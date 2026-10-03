import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

// Checks the OpenVaultDB publisher manifest: the root OVDB.md that opts the repository in and the
// manifest files it lists.
//
// Every path in OVDB.md and in a manifest is relative to the repository root, and must name a regular
// file that git tracks at HEAD: not a directory, a symlink, an untracked file or an ignored one (the
// Directory reads the pinned commit, where only tracked files exist).
//
// `files` supplies the repository: read(path) returns a file's text, and kind(path) says what the
// path is at HEAD: 'file', 'directory', 'symlink', 'untracked', 'ignored' or 'missing'.
// checkOvdbManifest returns a list of problems; empty means the manifest is good.

const manifestFormat = 'ovdb-manifest/draft-1';
const globChars = /[*?[\]{}\\]/;
const licenceId = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const discoveryPath = '/.well-known/openvaultdb';

// The keys a manifest may have. Anything else is refused, so a stray secret cannot ride along.
const allowedKeys = {
  '': ['format', 'id', 'title', 'description', 'url', 'deployment', 'model', 'meaning', 'publisher', 'licences', 'recordsets'],
  deployment: ['url', 'engine', 'discovery', 'recordset_page'],
  model: ['modelspec', 'hcl'],
  meaning: ['file', 'graph'],
  'meaning.graph': ['id', 'address'],
  publisher: ['name', 'url', 'repository'],
  licences: ['model', 'meaning', 'data'],
};

// A repository on disk, read through git. kind() asks git what HEAD holds at the path.
export function gitRepoFiles(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }).toString();
  return {
    read: (path) => readFileSync(join(root, path), 'utf8'),
    kind(path) {
      const [entry] = git('ls-tree', '-z', 'HEAD', '--', path).split('\0');
      if (entry) {
        const mode = entry.split(' ')[0];
        if (mode === '040000') return 'directory';
        if (mode === '120000') return 'symlink';
        return mode === '100644' || mode === '100755' ? 'file' : 'symlink'; // a submodule is not a file either
      }
      if (!existsSync(join(root, path))) return 'missing';
      try {
        git('check-ignore', '-q', '--no-index', '--', path);
        return 'ignored';
      } catch {
        return 'untracked';
      }
    },
  };
}

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { error: 'has no YAML frontmatter between --- lines' };
  try {
    const data = parseYaml(match[1]);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { error: 'frontmatter is not a mapping' };
    return { data };
  } catch (error) {
    return { error: `frontmatter is not valid YAML: ${error.message}` };
  }
}

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSafePath = (path) =>
  isText(path) && !globChars.test(path) && !path.startsWith('/') && !path.endsWith('/') && !path.split('/').some((part) => part === '' || part === '.' || part === '..');

// Why a value cannot be a URL a manifest may publish, or '' when it can.
function urlProblem(value) {
  if (!isText(value)) return 'is required';
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'must be an https URL';
  }
  if (url.protocol !== 'https:') return 'must be an https URL';
  if (url.username || url.password) return 'must not carry credentials';
  if (url.search || url.hash || value.includes('?') || value.includes('#')) return 'must not carry a query string or fragment';
  const host = url.hostname;
  if (host.startsWith('[') || /^\d+(\.\d+)*$/.test(host)) return 'must name a host, not an IP address';
  const labels = host.split('.');
  if (labels.length < 2 || ['localhost', 'local', 'internal', 'localdomain', 'lan', 'home', 'corp'].includes(labels.at(-1)) || labels.includes('localhost')) {
    return 'must be a public host, not a local or internal one';
  }
  return '';
}

const githubOwner = (value) => /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)$/.exec(value)?.[1];
const githubRepo = (value) => {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(value);
  return match && !match[2].endsWith('.git') ? { owner: match[1], repo: match[2] } : undefined;
};

export function checkOvdbManifest(files, { repository } = {}) {
  const problems = [];
  const kind = files.kind('OVDB.md');
  if (kind !== 'file') return [kind === 'missing' ? 'OVDB.md is missing from the repository root' : `OVDB.md must be a tracked regular file, but it is ${kind}`];
  const { data, error } = parseFrontmatter(files.read('OVDB.md'));
  if (error) return [`OVDB.md ${error}`];
  const extra = Object.keys(data).filter((key) => !['ovdb', 'publish'].includes(key));
  if (extra.length) problems.push(`OVDB.md: unknown frontmatter keys: ${extra.join(', ')}`);
  if (data.ovdb !== 1) problems.push(`OVDB.md: ovdb must be 1, got ${JSON.stringify(data.ovdb)}`);
  if (!Array.isArray(data.publish) || data.publish.length === 0) {
    problems.push('OVDB.md: publish must list at least one manifest path');
    return problems;
  }
  const seen = new Set();
  for (const entry of data.publish) {
    if (!isText(entry) || !entry.startsWith('./')) {
      problems.push(`OVDB.md: publish entry ${JSON.stringify(entry)} must be a path starting with ./`);
      continue;
    }
    const path = entry.slice(2);
    if (!isSafePath(path)) {
      problems.push(`OVDB.md: publish entry ${entry} must be an explicit file path inside the repository (no glob, no ..)`);
      continue;
    }
    if (seen.has(path)) {
      problems.push(`OVDB.md: publish lists ${entry} twice`);
      continue;
    }
    seen.add(path);
    const entryKind = files.kind(path);
    if (entryKind !== 'file') {
      problems.push(`OVDB.md: publish entry ${entry} must be a tracked regular file, but it is ${entryKind}`);
      continue;
    }
    problems.push(...checkManifest(path, files, { repository }));
  }
  return problems;
}

export function checkManifest(path, files, { repository } = {}) {
  const problems = [];
  const bad = (message) => problems.push(`${path}: ${message}`);
  let manifest;
  try {
    manifest = parseYaml(files.read(path));
  } catch (error) {
    return [`${path}: is not valid YAML: ${error.message}`];
  }
  if (!isObject(manifest)) return [`${path}: is not a mapping`];

  // No keys outside the allow-list, at any level.
  for (const [where, allowed] of Object.entries(allowedKeys)) {
    const object = where === '' ? manifest : where.split('.').reduce((value, key) => value?.[key], manifest);
    if (!isObject(object)) continue;
    const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
    if (unknown.length) bad(`unknown ${where ? `${where}.` : ''}keys: ${unknown.join(', ')}`);
  }

  if (manifest.format !== manifestFormat) bad(`format must be ${manifestFormat}, got ${JSON.stringify(manifest.format)}`);
  for (const field of ['id', 'title', 'description']) if (!isText(manifest[field])) bad(`${field} is required`);
  if (isText(manifest.id) && !/^[a-z][a-z0-9-]*$/.test(manifest.id)) bad('id must be lower-case letters, digits and hyphens');

  const checkUrl = (value, label) => {
    const problem = urlProblem(value);
    if (problem) bad(`${label} ${problem}`);
    return problem ? undefined : new URL(value);
  };
  const need = (object, field, label) => {
    if (!isText(object?.[field])) bad(`${label} is required`);
  };

  // The canonical identity, and the places it is served and discovered.
  const canonical = checkUrl(manifest.url, 'url');
  if (canonical && !(canonical.pathname.split('/').includes('ovdb') || canonical.hostname.split('.').slice(0, -2).includes('ovdb'))) {
    bad('url must have an ovdb path segment or an ovdb subdomain');
  }
  const deployment = manifest.deployment;
  const deployed = checkUrl(deployment?.url, 'deployment.url');
  need(deployment, 'engine', 'deployment.engine');
  const discovery = checkUrl(deployment?.discovery, 'deployment.discovery');
  if (discovery && canonical) {
    if (discovery.origin !== canonical.origin) bad(`deployment.discovery must be on the origin of url (${canonical.origin}), the document that lists it`);
    else if (discovery.pathname !== discoveryPath) bad(`deployment.discovery must be ${canonical.origin}${discoveryPath}`);
  }
  const page = deployment?.recordset_page;
  if (page !== undefined) {
    if (!isText(page) || page.split('{name}').length !== 2) bad('deployment.recordset_page must contain {name} exactly once');
    else {
      const expanded = checkUrl(page.replace('{name}', 'Name'), 'deployment.recordset_page');
      if (expanded && deployed && expanded.origin !== deployed.origin) bad(`deployment.recordset_page must be on the origin of deployment.url (${deployed.origin})`);
    }
  }

  // The publisher.
  need(manifest.publisher, 'name', 'publisher.name');
  const publisherUrl = manifest.publisher?.url;
  const owner = checkUrl(publisherUrl, 'publisher.url') && githubOwner(publisherUrl);
  if (publisherUrl && !owner && !urlProblem(publisherUrl)) bad('publisher.url must be https://github.com/<owner>');
  const repo = manifest.publisher?.repository;
  const repoParts = typeof repo === 'string' ? githubRepo(repo) : undefined;
  if (!isText(repo)) bad('publisher.repository is required');
  else if (urlProblem(repo)) bad(`publisher.repository ${urlProblem(repo)}`);
  else if (!repoParts) bad('publisher.repository must be https://github.com/<owner>/<repository>');
  else {
    if (owner && repoParts.owner !== owner) bad('publisher.repository must belong to the owner in publisher.url');
    if (repository !== undefined && repo !== repository) bad(`publisher.repository must be ${repository}, the repository this manifest is in`);
  }

  // The licences the Directory shows: licences.data is the one it lists for the database.
  for (const field of ['model', 'meaning', 'data']) {
    const value = manifest.licences?.[field];
    if (!isText(value)) bad(`licences.${field} is required`);
    else if (!licenceId.test(value)) bad(`licences.${field} must be an SPDX licence id`);
  }

  // Every file the manifest names is a tracked regular file; they are all read from the repository root.
  const named = { 'model.modelspec': manifest.model?.modelspec, 'model.hcl': manifest.model?.hcl, 'meaning.file': manifest.meaning?.file };
  if (!isText(named['model.modelspec'])) bad('model.modelspec is required');
  if (!isText(named['meaning.file'])) bad('meaning.file is required');
  const readable = {};
  for (const [label, value] of Object.entries(named)) {
    if (value === undefined && label === 'model.hcl') continue;
    if (!isText(value)) continue;
    if (!isSafePath(value)) {
      bad(`${label} ${JSON.stringify(value)} must be a file path relative to the repository root (no glob, no .., not absolute)`);
      continue;
    }
    const fileKind = files.kind(value);
    if (fileKind !== 'file') bad(`${label} names ${value}, which must be a tracked regular file, but it is ${fileKind}`);
    else readable[label] = value;
  }

  // The meaning graph is the one the meaning file declares, at the address of this repository.
  const graph = manifest.meaning?.graph;
  need(graph, 'id', 'meaning.graph.id');
  need(graph, 'address', 'meaning.graph.address');
  if (readable['meaning.file'] && isText(graph?.id)) {
    try {
      const meaning = parseYaml(files.read(readable['meaning.file']));
      if (meaning?.id !== graph.id) bad(`meaning.graph.id is ${graph.id} but the meaning file's id is ${JSON.stringify(meaning?.id)}`);
      if (isText(manifest.licences?.meaning) && meaning?.license !== manifest.licences.meaning) {
        bad(`licences.meaning is ${manifest.licences.meaning} but the meaning file says ${meaning?.license}`);
      }
    } catch (error) {
      bad(`${readable['meaning.file']} is not valid YAML: ${error.message}`);
    }
  }
  if (isText(graph?.address) && repoParts) {
    const expected = `meaning://github.com/${repoParts.owner}/${repoParts.repo}`;
    if (graph.address !== expected) bad(`meaning.graph.address must be ${expected}, derived from publisher.repository`);
  }

  // Recordsets are exactly the ModelSpec entities.
  const recordsets = manifest.recordsets;
  if (!Array.isArray(recordsets) || recordsets.length === 0 || !recordsets.every(isText)) {
    bad('recordsets must be a non-empty list of names');
  } else if (readable['model.modelspec']) {
    let entityNames;
    try {
      entityNames = Object.keys(JSON.parse(files.read(readable['model.modelspec'])).entities ?? {});
    } catch (error) {
      bad(`${readable['model.modelspec']} is not a ModelSpec JSON file: ${error.message}`);
    }
    if (entityNames) {
      const listed = new Set(recordsets);
      if (listed.size !== recordsets.length) bad('recordsets lists a name twice');
      const missing = entityNames.filter((name) => !listed.has(name));
      const extra = recordsets.filter((name) => !entityNames.includes(name));
      if (missing.length) bad(`recordsets lacks ModelSpec entities: ${missing.join(', ')}`);
      if (extra.length) bad(`recordsets names things that are not ModelSpec entities: ${extra.join(', ')}`);
    }
  }
  return problems;
}
