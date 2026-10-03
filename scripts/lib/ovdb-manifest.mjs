import { parse as parseYaml } from 'yaml';

// Checks the OpenVaultDB publisher manifest: the root OVDB.md that opts the repository in and the
// manifest files it lists. `files` supplies the repository: read(path) returns a file's text and
// exists(path) says whether it is there. Returns a list of problems; empty means the manifest is good.

const manifestFormat = 'ovdb-manifest/draft-1';
const globChars = /[*?[\]{}]/;

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
const isHttps = (value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};
const isSafePath = (path) => isText(path) && !path.startsWith('/') && !path.split('/').includes('..') && !globChars.test(path);

export function checkOvdbManifest(files, { entityNames, meaningLicence } = {}) {
  const problems = [];
  if (!files.exists('OVDB.md')) return ['OVDB.md is missing from the repository root'];
  const { data, error } = parseFrontmatter(files.read('OVDB.md'));
  if (error) return [`OVDB.md ${error}`];
  if (data.ovdb !== 1) problems.push(`OVDB.md: ovdb must be 1, got ${JSON.stringify(data.ovdb)}`);
  if (!Array.isArray(data.publish) || data.publish.length === 0) {
    problems.push('OVDB.md: publish must list at least one manifest path');
    return problems;
  }
  for (const entry of data.publish) {
    if (!isText(entry) || !entry.startsWith('./')) {
      problems.push(`OVDB.md: publish entry ${JSON.stringify(entry)} must be a path starting with ./`);
      continue;
    }
    const path = entry.slice(2);
    if (!isSafePath(path)) {
      problems.push(`OVDB.md: publish entry ${entry} must be an explicit path inside the repository (no glob, no ..)`);
      continue;
    }
    if (!files.exists(path)) {
      problems.push(`OVDB.md: publish entry ${entry} does not exist`);
      continue;
    }
    problems.push(...checkManifest(path, files, { entityNames, meaningLicence }));
  }
  return problems;
}

export function checkManifest(path, files, { entityNames, meaningLicence } = {}) {
  const problems = [];
  const bad = (message) => problems.push(`${path}: ${message}`);
  let manifest;
  try {
    manifest = parseYaml(files.read(path));
  } catch (error) {
    return [`${path}: is not valid YAML: ${error.message}`];
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return [`${path}: is not a mapping`];

  if (manifest.format !== manifestFormat) bad(`format must be ${manifestFormat}, got ${JSON.stringify(manifest.format)}`);
  for (const field of ['id', 'title', 'description']) if (!isText(manifest[field])) bad(`${field} is required`);
  if (isText(manifest.id) && !/^[a-z][a-z0-9-]*$/.test(manifest.id)) bad('id must be lower-case letters, digits and hyphens');

  const need = (object, field, label, check = isText) => {
    if (!check(object?.[field])) bad(`${label} is required`);
  };
  need(manifest, 'url', 'url', isHttps);
  const deployment = manifest.deployment;
  need(deployment, 'url', 'deployment.url', isHttps);
  need(deployment, 'engine', 'deployment.engine');
  need(deployment, 'discovery', 'deployment.discovery', isHttps);
  need(manifest.model, 'modelspec', 'model.modelspec');
  need(manifest.meaning, 'file', 'meaning.file');
  need(manifest.meaning?.graph, 'id', 'meaning.graph.id');
  need(manifest.meaning?.graph, 'address', 'meaning.graph.address', (value) => isText(value) && value.startsWith('meaning://'));
  need(manifest.publisher, 'name', 'publisher.name');
  need(manifest.publisher, 'url', 'publisher.url', isHttps);
  need(manifest.licences, 'model', 'licences.model');
  need(manifest.licences, 'meaning', 'licences.meaning');

  // Every file the manifest names must exist.
  for (const [label, value] of [
    ['model.modelspec', manifest.model?.modelspec],
    ['model.hcl', manifest.model?.hcl],
    ['meaning.file', manifest.meaning?.file],
  ]) {
    if (!isText(value)) continue;
    if (!isSafePath(value)) bad(`${label} ${JSON.stringify(value)} must be a path inside the repository`);
    else if (!files.exists(value)) bad(`${label} names ${value}, which does not exist`);
  }

  if (meaningLicence !== undefined && isText(manifest.licences?.meaning) && manifest.licences.meaning !== meaningLicence) {
    bad(`licences.meaning is ${manifest.licences.meaning} but the meaning file says ${meaningLicence}`);
  }

  // Recordsets are exactly the ModelSpec entities.
  const recordsets = manifest.recordsets;
  if (!Array.isArray(recordsets) || recordsets.length === 0 || !recordsets.every(isText)) {
    bad('recordsets must be a non-empty list of names');
  } else if (entityNames) {
    const listed = new Set(recordsets);
    if (listed.size !== recordsets.length) bad('recordsets lists a name twice');
    const missing = entityNames.filter((name) => !listed.has(name));
    const extra = recordsets.filter((name) => !entityNames.includes(name));
    if (missing.length) bad(`recordsets lacks ModelSpec entities: ${missing.join(', ')}`);
    if (extra.length) bad(`recordsets names things that are not ModelSpec entities: ${extra.join(', ')}`);
  }
  return problems;
}
