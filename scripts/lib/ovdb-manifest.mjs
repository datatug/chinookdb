import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { cleanGitEnv } from './git-env.mjs';
import { canonicalUrlProblem, enginePattern, homepageProblem, idPattern, isRepositoryPath, maxIdLength, publicHttpsProblem } from './directory-rules.mjs';

// Checks the OpenVaultDB publisher manifest: the root OVDB.md that opts the repository in and the
// manifest files it lists.
//
// Every path in OVDB.md and in a manifest is relative to the directory the files are read from (the repository root, for
// the Directory), and must name a regular
// file that git tracks at HEAD: not a directory, a symlink, an untracked file or an ignored one (the
// Directory reads the pinned commit, where only tracked files exist).
//
// `files` supplies the repository: read(path) returns a file's text as HEAD holds it (not the working
// tree), and kind(path) says what the path is at HEAD: 'file', 'directory', 'symlink', 'untracked',
// 'ignored' or 'missing'. Both look at the same commit, so an uncommitted edit is never checked.
// problem(), when present, says why the repository cannot be read at all (not a git repository, no
// commit yet). read() throws an Error whose message says why a file cannot be read (for example, too large).
// checkOvdbManifest returns a list of problems; empty means the manifest is good.
//
// A manifest has one of two forms, the two the OVDB Directory accepts, and the forms never mix. The
// Directory tells them apart by whether the manifest has local model files.
//
// Own model (this repository's own manifest): `model.modelspec` (the JSON) and `model.hcl` (the source,
// which the Directory index reports as `model.path`) are tracked files of this repository, as is
// `meaning.file`; `meaning.graph.id` and `meaning.graph.address` name the graph. An optional
// `model.address` must be this repository's own address for the model, without a ref.
//
// Shared model (a hoster of a database whose model and meaning graph are published elsewhere): no local
// model or meaning files. `model.address` and `meaning.address` are each pinned with `?ref=<40 hex>`;
// `meaning.file` is a path in the graph's repository, `meaning.graph.id` is the MeaningGraph registry id,
// `licences.data` is required, `licences.model` and `licences.meaning` are optional, and the optional
// `recordsets_partial: true` says that `recordsets` lists a subset of the model's entities. Neither
// address may name the publisher's own repository.
//
// Both forms may have an optional `homepage`: the publisher's own page for the database, under a stricter
// URL rule than the Directory's (see directory-rules.mjs: 200 characters, plain ASCII host and path).
//
// This is an offline PRE-CHECK, not the Directory's verdict, and the Directory is the authority. The URL, id,
// engine and path rules are the Directory's own (directory-rules.mjs). It does not parse the model or the meaning
// file in full, look at the registries, or compare across records; for the shared form it cannot read the model
// or the graph at all, so it validates shape only, and the Directory checks both addresses against the ModelSpec
// registry and the MeaningGraph registry, reads both repositories at the pinned commits and compares `recordsets`
// with the model's entities. Every report says so (see `notes`, `offlineNote`).
//
// `model.hcl` is the source file of an own model. The Directory index takes `model.path` from the meaning
// file's `models:` entry for the module, and the manifest's `model.hcl` must be that same path.
//
// One grammar for names, the intersection of what the ModelSpec registry, the MeaningGraph registry and the
// Directory accept (see the README): the host is github.com; an organisation or repository segment is
// `[A-Za-z0-9_.-]+`, is not `.` or `..`, and a repository does not end in `.git` in any case; host,
// organisation and repository are written in lower case in an address; a module name is a ModelSpec
// module name, a letter and then letters, digits and `_`, case-sensitive, never with a dot
// (`<address>.<Entity>` is an entity reference).

const manifestFormat = 'ovdb-manifest/draft-1';
// The SPDX identifiers a manifest may use for a licence. Small on purpose; add one when a database needs it.
export const licenceIds = [
  '0BSD', 'AGPL-3.0-only', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0',
  'GPL-2.0-only', 'GPL-3.0-only', 'ISC', 'LGPL-3.0-only', 'MIT', 'MPL-2.0', 'ODC-By-1.0', 'ODbL-1.0', 'PDDL-1.0', 'Unlicense',
];
const segment = '[A-Za-z0-9_.-]+';
const moduleName = '[A-Za-z][A-Za-z0-9_]*';
const pinPattern = '(?:\\?ref=([0-9a-f]{40}))?';
const modelAddress = new RegExp(`^modelspec://github\\.com/(${segment})/(${segment})/(${moduleName})${pinPattern}$`);
const graphAddress = new RegExp(`^meaning://github\\.com/(${segment})/(${segment})${pinPattern}$`);
const githubRepoPath = new RegExp(`^https://github\\.com/(${segment})/(${segment})$`);
const githubOwnerPath = new RegExp(`^https://github\\.com/(${segment})$`);
const modulePattern = new RegExp(`^${moduleName}$`);
// A path inside a repository, as the Directory spells it: relative, no `..` or `.` or empty segment, no glob.
const repositoryPath = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)\.(?:\/|$))[A-Za-z0-9_.\/-]+$/;
const graphIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Whether an organisation and repository are names github.com may hold (as the Directory's repositoryKey says).
const namesRepository = (owner, repo) => ![owner, repo].includes('.') && ![owner, repo].includes('..') && !/\.git$/i.test(repo);
function parseModelAddress(value) {
  const match = typeof value === 'string' ? modelAddress.exec(value) : null;
  return match && namesRepository(match[1], match[2]) ? { owner: match[1], repo: match[2], module: match[3], ref: match[4] } : null;
}
function parseGraphAddress(value) {
  const match = typeof value === 'string' ? graphAddress.exec(value) : null;
  return match && namesRepository(match[1], match[2]) ? { owner: match[1], repo: match[2], ref: match[3] } : null;
}
const entityName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const maxFileBytes = 16 * 1024 * 1024;
const discoveryPath = '/.well-known/openvaultdb';

// The keys a manifest may have. Anything else is refused, so a stray secret cannot ride along.
const allowedKeys = {
  '': ['format', 'id', 'title', 'description', 'url', 'deployment', 'model', 'meaning', 'publisher', 'licences', 'recordsets', 'recordsets_partial', 'homepage'],
  deployment: ['url', 'engine', 'discovery', 'recordset_page'],
  model: ['modelspec', 'hcl', 'address', 'name'],
  meaning: ['file', 'graph', 'address'],
  'meaning.graph': ['id', 'address'],
  publisher: ['name', 'url', 'repository'],
  licences: ['model', 'meaning', 'data'],
};

// A repository on disk, read through git. kind() asks git what HEAD holds at the path.
export function gitRepoFiles(root) {
  // cleanGitEnv drops every inherited GIT_* variable; -C names the repository.
  // --literal-pathspecs: a path is a path, never pathspec magic such as `:/` or `:(icase)`.
  const run = (flags, args, options = {}) =>
    execFileSync('git', [...flags, '-C', root, ...args], { stdio: 'pipe', env: cleanGitEnv(), maxBuffer: maxFileBytes, ...options }).toString();
  const git = (...args) => run(['--literal-pathspecs'], args);
  return {
    problem() {
      try {
        run([], ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
        return '';
      } catch (error) {
        const reason = String(error.stderr ?? '').trim().split('\n').at(-1) || error.message.split('\n')[0];
        return `git could not read HEAD of ${root}: ${reason}. Is it a git repository with a commit?`;
      }
    },
    read(path) {
      try {
        return git('cat-file', 'blob', `HEAD:./${path}`); // ./ : relative to `root`, which need not be the top of the repository
      } catch (error) {
        if (error.code === 'ENOBUFS') throw new Error(`${path} is larger than ${maxFileBytes / 1024 / 1024} MB, which is more than a manifest file may be`);
        throw new Error(`${path} cannot be read at HEAD: ${String(error.stderr ?? '').trim().split('\n').at(-1) || error.message}`);
      }
    },
    kind(path) {
      let entry;
      try {
        entry = git('ls-tree', '-z', 'HEAD', '--', path).split('\0')[0];
      } catch {
        return 'missing'; // git refused the path outright; a repository that cannot be read at all is reported by problem()
      }
      // `<mode> <type> <sha>\t<path>`; only an entry for exactly the requested path counts.
      const tab = entry.indexOf('\t');
      if (tab >= 0 && entry.slice(tab + 1) === path) {
        const mode = entry.split(' ')[0];
        if (mode === '040000') return 'directory';
        if (mode === '120000') return 'symlink';
        return mode === '100644' || mode === '100755' ? 'file' : 'symlink'; // a submodule is not a file either
      }
      if (!existsSync(join(root, path))) return 'missing';
      try {
        run([], ['check-ignore', '-q', '--no-index', '--', path]); // check-ignore refuses --literal-pathspecs; a path that git cannot take is not ignored
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
// A path in a repository, as the Directory spells it (isRepositoryPath): relative, letters, digits and . _ - / only,
// no `..`, `.` or empty segment, no glob.
const isSafePath = isRepositoryPath;

const githubOwner = (value) => {
  const owner = githubOwnerPath.exec(value)?.[1];
  return owner !== undefined && namesRepository(owner, 'x') ? owner : undefined;
};
const githubRepo = (value) => {
  const match = githubRepoPath.exec(value);
  return match && namesRepository(match[1], match[2]) ? { owner: match[1], repo: match[2] } : undefined;
};

// What every report says, for either form: this is a pre-check, and what it does not check.
export const offlineNote = 'this is an offline pre-check, not the OVDB Directory\'s verdict: the Directory is the authority and checks everything again at the pinned commit. Not checked here: the full ModelSpec parse of the model (properties, types, references), the meaning check with the pinned core checker (concept shapes, bindings, extends chains, values), lookups in the ModelSpec registry and the MeaningGraph registry, and checks across records (a canonical url, a deployment or a recordset page that two databases claim).';

// Checks OVDB.md and every manifest it lists. Returns { problems, notes }: `problems` is empty when the
// manifest is good; `notes` says what this offline check could not decide and who does (the Directory).
export function reportOvdbManifest(files, { repository } = {}) {
  const problems = [];
  const notes = [];
  const unreadable = files.problem?.();
  if (unreadable) return { problems: [unreadable], notes };
  const kind = files.kind('OVDB.md');
  if (kind !== 'file') return { problems: [kind === 'missing' ? 'OVDB.md is missing from the repository root' : `OVDB.md must be a tracked regular file, but it is ${kind}`], notes };
  let text;
  try {
    text = files.read('OVDB.md');
  } catch (error) {
    return { problems: [`OVDB.md: ${error.message}`], notes };
  }
  const { data, error } = parseFrontmatter(text);
  if (error) return { problems: [`OVDB.md ${error}`], notes };
  const extra = Object.keys(data).filter((key) => !['ovdb', 'publish'].includes(key));
  if (extra.length) problems.push(`OVDB.md: unknown frontmatter keys: ${extra.join(', ')}`);
  if (data.ovdb !== 1) problems.push(`OVDB.md: ovdb must be 1, got ${JSON.stringify(data.ovdb)}`);
  if (!Array.isArray(data.publish) || data.publish.length === 0) {
    problems.push('OVDB.md: publish must list at least one manifest path');
    return { problems, notes };
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
    const checked = analyseManifest(path, files, { repository });
    problems.push(...checked.problems);
    notes.push(...checked.notes);
  }
  return { problems, notes };
}

// The problems only (empty means the manifest is good); see reportOvdbManifest for the notes.
export const checkOvdbManifest = (files, options) => reportOvdbManifest(files, options).problems;

export const checkManifest = (path, files, options) => analyseManifest(path, files, options).problems;

function analyseManifest(path, files, { repository } = {}) {
  const problems = [];
  const notes = [];
  const bad = (message) => problems.push(`${path}: ${message}`);
  let manifest;
  try {
    manifest = parseYaml(files.read(path));
  } catch (error) {
    return { problems: [error instanceof Error && error.name === 'YAMLParseError' ? `${path}: is not valid YAML: ${error.message}` : `${path}: ${error.message}`], notes };
  }
  if (!isObject(manifest)) return { problems: [`${path}: is not a mapping`], notes };

  // No keys outside the allow-list, at any level.
  for (const [where, allowed] of Object.entries(allowedKeys)) {
    const object = where === '' ? manifest : where.split('.').reduce((value, key) => value?.[key], manifest);
    if (!isObject(object)) continue;
    const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
    if (unknown.length) bad(`unknown ${where ? `${where}.` : ''}keys: ${unknown.join(', ')}`);
  }

  if (manifest.format !== manifestFormat) bad(`format must be ${manifestFormat}, got ${JSON.stringify(manifest.format)}`);
  for (const field of ['id', 'title', 'description']) if (!isText(manifest[field])) bad(`${field} is required`);
  if (isText(manifest.id) && (!idPattern.test(manifest.id) || manifest.id.length > maxIdLength)) bad(`id must be lower-case letters, digits and single hyphens, at most ${maxIdLength} characters`);

  // A URL the manifest publishes, under the Directory's rules (directory-rules.mjs); returns it parsed, or undefined.
  const checkUrl = (value, label, { check = publicHttpsProblem, ...options } = {}) => {
    if (value === undefined || value === null || value === '') {
      bad(`${label} is required`);
      return undefined;
    }
    const problem = check(value, options);
    if (problem) bad(`${label} ${problem}`);
    return problem ? undefined : new URL(options.template ? value.replace('{name}', 'name') : value);
  };
  const need = (object, field, label) => {
    if (!isText(object?.[field])) bad(`${label} is required`);
  };

  // The canonical identity, and the places it is served and discovered.
  const canonical = checkUrl(manifest.url, 'url', { check: canonicalUrlProblem });
  // The publisher's own page for the database: any public https URL on any origin, under the stricter
  // homepage rule (200 characters at most, plain ASCII host and path), which the Directory does not have.
  if (manifest.homepage !== undefined) {
    const problem = homepageProblem(manifest.homepage);
    if (problem) bad(`homepage ${problem}`);
  }
  const deployment = manifest.deployment;
  const deployed = checkUrl(deployment?.url, 'deployment.url');
  if (typeof deployment?.engine !== 'string' || !enginePattern.test(deployment.engine)) bad('deployment.engine is required: a letter, then letters, digits and . _ + - (40 characters at most)');
  const discovery = checkUrl(deployment?.discovery, 'deployment.discovery');
  if (discovery && canonical) {
    if (discovery.origin !== canonical.origin) bad(`deployment.discovery must be on the origin of url (${canonical.origin}), the document that lists it`);
    else if (discovery.pathname !== discoveryPath) bad(`deployment.discovery must be ${canonical.origin}${discoveryPath}`);
  }
  const page = deployment?.recordset_page;
  if (page !== undefined) {
    const expanded = checkUrl(page, 'deployment.recordset_page', { template: true });
    if (expanded && deployed && expanded.origin !== deployed.origin) bad(`deployment.recordset_page must be on the origin of deployment.url (${deployed.origin})`);
  }

  // The publisher.
  need(manifest.publisher, 'name', 'publisher.name');
  const publisherUrl = manifest.publisher?.url;
  const owner = checkUrl(publisherUrl, 'publisher.url') && githubOwner(publisherUrl);
  if (publisherUrl && !owner && !publicHttpsProblem(publisherUrl)) bad('publisher.url must be https://github.com/<owner>');
  const repo = manifest.publisher?.repository;
  const repoParts = typeof repo === 'string' ? githubRepo(repo) : undefined;
  if (!isText(repo)) bad('publisher.repository is required');
  else if (!repoParts) bad('publisher.repository must be https://github.com/<owner>/<repository>');
  else {
    if (owner && repoParts.owner !== owner) bad('publisher.repository must belong to the owner in publisher.url');
    if (repository !== undefined && repo !== repository) bad(`publisher.repository must be ${repository}, the repository this manifest is in`);
  }
  // The publisher's own repository as an address names it: host, organisation and repository in lower case.
  const ownRepository = repoParts ? `${repoParts.owner}/${repoParts.repo}`.toLowerCase() : undefined;

  // The form: own model files, or a shared model named by pinned addresses (see the top of this file).
  const model = manifest.model;
  const local = model?.modelspec !== undefined || model?.hcl !== undefined;
  const address = model?.address;
  const modelParts = parseModelAddress(address);
  if (address !== undefined && !modelParts) {
    bad(`model.address must be modelspec://github.com/<org>/<repository>/<module>, optionally followed by ?ref=<40 hex>, got ${JSON.stringify(address)}`);
  }
  if (model?.name !== undefined && !(typeof model.name === 'string' && modulePattern.test(model.name))) {
    bad(`model.name, when given, must be a ModelSpec module name (a letter, then letters, digits and "_"), got ${JSON.stringify(model.name)}`);
  }
  // An address spelled the way the registries spell it, and, when it is a pinned one, not the publisher's own
  // repository. Returns whether the address passed.
  const spelling = (label, value, parts, { notOwn }) => {
    const spelled = `${parts.owner}/${parts.repo}`;
    if (spelled !== spelled.toLowerCase()) {
      bad(`${label} ${value} must be written in lower case (host, organisation and repository; the module name is case-sensitive)`);
      return false;
    }
    if (notOwn && spelled === ownRepository) {
      bad(`${label} ${value} names this repository; a model or meaning file in the publisher's own repository is named by local files (model.modelspec and meaning.file), not by a pinned address`);
      return false;
    }
    return true;
  };

  // Each file is read once; a file that cannot be read is reported once, and reads as undefined.
  const loaded = new Map();
  const load = (file) => {
    if (!loaded.has(file)) {
      try {
        loaded.set(file, files.read(file));
      } catch (error) {
        bad(error.message);
        loaded.set(file, undefined);
      }
    }
    return loaded.get(file);
  };

  // The licences the Directory shows: licences.data is the one it lists for the database. A shared model's
  // model and meaning licences come from the registries, so there they are optional.
  for (const field of ['model', 'meaning', 'data']) {
    const value = manifest.licences?.[field];
    if (value === undefined && !local && field !== 'data') continue;
    if (!isText(value)) bad(`licences.${field} is required`);
    else if (!licenceIds.includes(value)) bad(`licences.${field} must be a known SPDX licence id (${licenceIds.join(', ')}), got ${JSON.stringify(value)}`);
  }

  // What the model declares: set only when the model is known (a parsed own model file).
  let moduleName;
  let entityNames;

  if (local) {
    // ---- own model: the model and the meaning file are tracked files of this repository ----
    if (manifest.meaning?.address !== undefined) {
      bad('meaning.address is only for a shared model (model.address with ?ref= and no local model files); a manifest with its own model files has its own meaning file and names its graph by meaning.graph.address');
    }
    if (manifest.recordsets_partial !== undefined) bad('recordsets_partial is only for a shared model; a manifest with its own model files lists every ModelSpec entity');

    // Every file the manifest names is a tracked regular file; they are all read from the repository root.
    const named = { 'model.modelspec': model?.modelspec, 'model.hcl': model?.hcl, 'meaning.file': manifest.meaning?.file };
    const suffixes = { 'model.modelspec': '.modelspec.json', 'model.hcl': '.modelspec.hcl' };
    if (!isText(named['model.modelspec'])) bad('model.modelspec is required with local model files');
    if (!isText(named['model.hcl'])) bad("model.hcl is required with local model files: it is the model's source file, and must be the path in the meaning file's models: entry");
    if (!isText(named['meaning.file'])) bad('meaning.file is required');
    const readable = {};
    for (const [label, value] of Object.entries(named)) {
      if (!isText(value)) continue;
      if (!isSafePath(value)) {
        bad(`${label} ${JSON.stringify(value)} must be a file path relative to the repository root (no glob, no .., not absolute)`);
        continue;
      }
      if (suffixes[label] && !value.endsWith(suffixes[label])) {
        bad(`${label} ${JSON.stringify(value)} must be a path ending in ${suffixes[label]}`);
        continue;
      }
      const fileKind = files.kind(value);
      if (fileKind !== 'file') bad(`${label} names ${value}, which must be a tracked regular file, but it is ${fileKind}`);
      else readable[label] = value;
    }

    // The module the model file declares, and its entities. Whatever the file holds (null, 0, false, "" are
    // valid JSON too), a model that cannot be read as a ModelSpec is a problem, never a silent pass.
    const modelFile = readable['model.modelspec'];
    if (modelFile) {
      const text = load(modelFile);
      if (text !== undefined) {
        let json;
        let parsed = false;
        try {
          json = JSON.parse(text);
          parsed = true;
        } catch (error) {
          bad(`${modelFile} is not a ModelSpec JSON file: ${error.message}`);
        }
        if (parsed && !isObject(json)) bad(`${modelFile} is not a ModelSpec JSON file: it must be a JSON object, not ${JSON.stringify(json)}`);
        else if (parsed) {
          const name = json.module?.name;
          if (typeof name !== 'string' || !modulePattern.test(name)) bad(`${modelFile} has no module.name that is a ModelSpec module name (a letter, then letters, digits and "_"), got ${JSON.stringify(name)}`);
          else moduleName = name;
          if (!isObject(json.entities)) bad(`${modelFile} has no entities (an object of ModelSpec entities)`);
          else entityNames = Object.keys(json.entities);
        }
      }
    }
    if (model?.name !== undefined && moduleName !== undefined && model.name !== moduleName) bad(`model.name is ${model.name}, but ${modelFile} is module ${moduleName}`);

    // The address is this repository's own, for the module the model file declares, and carries no ref (the
    // model is in the commit being read). Host, organisation and repository are lower case, as the Directory requires.
    if (modelParts) {
      if (modelParts.ref) bad('model.address must not carry ?ref= when the model files are in this repository');
      if (spelling('model.address', address, modelParts, { notOwn: false }) && ownRepository && moduleName !== undefined) {
        const expected = `modelspec://github.com/${ownRepository}/${moduleName}`;
        if (`modelspec://github.com/${modelParts.owner}/${modelParts.repo}/${modelParts.module}` !== expected) {
          bad(`model.address must be ${expected}, this repository plus the module name in ${modelFile}`);
        }
      }
    }

    // The meaning graph is the one the meaning file declares, at the address of this repository.
    const graph = manifest.meaning?.graph;
    need(graph, 'id', 'meaning.graph.id');
    need(graph, 'address', 'meaning.graph.address');
    if (readable['meaning.file']) {
      const text = load(readable['meaning.file']);
      let meaning;
      let parsed = false;
      if (text !== undefined) {
        try {
          meaning = parseYaml(text);
          parsed = true;
        } catch (error) {
          bad(`${readable['meaning.file']} is not valid YAML: ${error.message}`);
        }
      }
      if (parsed && !isObject(meaning)) bad(`${readable['meaning.file']} is not a MeaningGraph file: it must be a mapping`);
      else if (parsed) {
        if (isText(graph?.id) && meaning.id !== graph.id) bad(`meaning.graph.id is ${graph.id} but the meaning file's id is ${JSON.stringify(meaning.id)}`);
        if (isText(manifest.licences?.meaning) && meaning.license !== manifest.licences.meaning) {
          bad(`licences.meaning is ${manifest.licences.meaning} but the meaning file says ${meaning.license}`);
        }
        // model.hcl is the meaning file's models: entry for the module (relative to the meaning file); the
        // Directory takes model.path from that entry and compares it with the manifest.
        if (readable['model.hcl'] && moduleName !== undefined) {
          const entry = isObject(meaning.models) ? meaning.models[moduleName] : undefined;
          if (!isText(entry)) bad(`the meaning file ${readable['meaning.file']} has no models: entry for module ${moduleName}`);
          else {
            const resolved = posix.join(posix.dirname(readable['meaning.file']), entry);
            if (readable['model.hcl'] !== resolved) bad(`model.hcl is ${readable['model.hcl']} but the meaning file's models: entry for ${moduleName} is ${resolved}`);
          }
        }
      }
    }
    // The Directory compares meaning.graph.address with the MeaningGraph registry's record of the graph verbatim, and that
    // record is for this repository in whatever case the registry spells it: offline, the repository must be this one,
    // in any case; the exact spelling is the registry's, and the Directory checks it.
    if (isText(graph?.address) && repoParts) {
      const expected = `meaning://github.com/${repoParts.owner}/${repoParts.repo}`;
      if (graph.address.toLowerCase() !== expected.toLowerCase()) bad(`meaning.graph.address must be ${expected} (in any case), derived from publisher.repository`);
    }
  } else {
    // ---- shared model: the model and the meaning graph are published in other repositories ----
    if (address === undefined) bad('model must name the model by local files (model.modelspec and model.hcl) or by model.address');
    if (modelParts) {
      if (!modelParts.ref) bad('model.address must carry ?ref=<40 hex> when the model is not in this repository (no local model files)');
      spelling('model.address', address, modelParts, { notOwn: true });
      if (model.name !== undefined && modulePattern.test(String(model.name)) && model.name !== modelParts.module) {
        bad(`model.name is ${model.name}, but model.address names module ${modelParts.module}`);
      }
    }

    const meaningAddress = manifest.meaning?.address;
    const graphParts = parseGraphAddress(meaningAddress);
    if (meaningAddress === undefined) {
      bad('meaning.address is required when model.address names a model in another repository (the meaning graph is then shared too): meaning://github.com/<org>/<repository>?ref=<40 hex>');
    } else if (!graphParts) {
      bad(`meaning.address must be meaning://github.com/<org>/<repository>?ref=<40 hex>, got ${JSON.stringify(meaningAddress)}`);
    } else {
      if (!graphParts.ref) bad('meaning.address must carry ?ref=<40 hex> (the pin says which commit of the meaning graph is read)');
      spelling('meaning.address', meaningAddress, graphParts, { notOwn: true });
    }
    // meaning.file is a path in the graph's repository, so it is not looked up here; the Directory reads it at the pin.
    const file = manifest.meaning?.file;
    if (!isText(file)) bad("meaning.file (the file of the graph, in the graph's repository, that binds the model) is required");
    else if (!repositoryPath.test(file) || file.endsWith('/')) bad(`meaning.file ${JSON.stringify(file)} must be a file path in the graph's repository (relative, no .., no leading /, no empty or . segment, no glob)`);
    const graph = manifest.meaning?.graph;
    need(graph, 'id', 'meaning.graph.id (the MeaningGraph registry id)');
    if (isText(graph?.id) && !graphIdPattern.test(graph.id)) bad('meaning.graph.id must be a MeaningGraph registry id: lower-case letters, digits and single hyphens');
    if (graph?.address !== undefined) {
      if (!(isText(graph.address) && graph.address.startsWith('meaning://'))) bad("meaning.graph.address, when given, must be the graph's meaning:// address without a pin");
      else if (graphParts && graph.address !== `meaning://github.com/${graphParts.owner}/${graphParts.repo}`) {
        bad(`meaning.graph.address is ${graph.address}, but meaning.address names meaning://github.com/${graphParts.owner}/${graphParts.repo}; leave meaning.graph.address out or make it the unpinned address`);
      }
    }
    if (manifest.recordsets_partial !== undefined && typeof manifest.recordsets_partial !== 'boolean') bad('recordsets_partial must be true or false');
    notes.push(`${path}: shared model: this check is offline and validated only the shape of model.address, meaning.address, meaning.file, meaning.graph, the licences and recordsets. The OVDB Directory checks both addresses against the ModelSpec registry and the MeaningGraph registry, reads both repositories at the pinned commits, and compares recordsets with the model's entities (a subset needs recordsets_partial: true).`);
  }

  // Recordsets are the ModelSpec entities (an own model's, exactly), each a valid, unique name.
  const recordsets = manifest.recordsets;
  if (!Array.isArray(recordsets) || recordsets.length === 0 || !recordsets.every(isText)) {
    bad('recordsets must be a non-empty list of names');
  } else {
    const listed = new Set(recordsets);
    if (listed.size !== recordsets.length) bad('recordsets lists a name twice');
    const misshapen = recordsets.filter((name) => !entityName.test(name));
    if (misshapen.length) bad(`recordsets names must look like ModelSpec entity names (letters, digits, underscore): ${misshapen.map((name) => JSON.stringify(name)).join(', ')}`);
    // Every recordset page the template makes is a URL the Directory checks again with the real name.
    if (isText(page) && !misshapen.length && !publicHttpsProblem(page, { template: true })) {
      for (const name of recordsets) {
        const problem = publicHttpsProblem(page.replace('{name}', name));
        if (problem) bad(`the recordset page of ${name}, ${page.replace('{name}', name)}, ${problem}`);
      }
    }
    // A shared model is in another repository, so its entities cannot be read here: the Directory compares.
    if (local && entityNames !== undefined) {
      const missing = entityNames.filter((name) => !listed.has(name));
      const extra = recordsets.filter((name) => !entityNames.includes(name));
      if (missing.length) bad(`recordsets lacks ModelSpec entities: ${missing.join(', ')}`);
      if (extra.length) bad(`recordsets names things that are not ModelSpec entities: ${extra.join(', ')}`);
    }
  }
  notes.unshift(`${path}: ${offlineNote}`);
  return { problems, notes };
}
