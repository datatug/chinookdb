// Checks for meaning files (format meaning/draft-1, schema in
// model/meaning.schema.json): JSON Schema validation, then the rules a schema
// cannot express. Every concept reference must resolve, every modelspec://
// binding must name an existing entity and property, and values must cover
// the data they describe.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { parseHcl, toModelspecJson } from './modelspec.mjs';

// Where meaning:// repositories are read from, keyed by {host}/{org}/{repo}.
// `dir` reads a local copy (relative to the repository root). `git` fetches
// the repository at the ?ref= pin that the references carry. The vendored copy
// stands in for github.com/meaninggraph/core until that public repository
// exists; switching to it is this one line:
//   'github.com/meaninggraph/core': { git: 'https://github.com/meaninggraph/core' },
export const meaningSources = {
  'github.com/meaninggraph/core': { dir: 'model/vendor/meaninggraph-core' },
};

const conceptRefPattern = /^meaning:\/\/([A-Za-z0-9.-]+(?:\/[A-Za-z0-9._-]+)+)\/([a-z0-9][a-z0-9-]*)(?:\?ref=([A-Za-z0-9._/-]+))?$/;
const modelRefPattern = /^modelspec:\/\/((?:[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._-]+)+)?)\/([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)(?:\?ref=([A-Za-z0-9._/-]+))?$/;

// A bare id is a concept in the same repository; meaning://{host}/{org}/{repo}/{id}
// is a concept in another one. The last path segment is the concept id.
export function parseConceptRef(ref) {
  if (/^[a-z0-9][a-z0-9-]*$/.test(ref)) return { id: ref };
  const match = conceptRefPattern.exec(ref);
  if (!match) return null;
  return { repo: match[1], id: match[2], ref: match[3] };
}

// modelspec:///{module}.{Name} (same repository) or modelspec://{host}/{org}/{repo}/{module}.{Name}.
export function parseModelRef(ref) {
  const match = modelRefPattern.exec(ref);
  if (!match) return null;
  return { repo: match[1] || undefined, module: match[2], name: match[3], ref: match[4] };
}

let compiled;
export function schemaValidator(schemaPath) {
  if (compiled?.path === schemaPath) return compiled.validate;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  compiled = { path: schemaPath, validate: ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8'))) };
  return compiled.validate;
}

export function schemaProblems(doc, schemaPath) {
  const validate = schemaValidator(schemaPath);
  if (validate(doc)) return [];
  return validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}${error.params?.allowedValues ? ` (${error.params.allowedValues.join(', ')})` : ''}${error.params?.additionalProperty ? ` (${error.params.additionalProperty})` : ''}`);
}

// Loads every *.meaning.yaml in `dir` as one repository's concepts.
export function loadMeaningDir(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.meaning.yaml')).sort().map((name) => {
    const path = join(dir, name);
    return { path, doc: parseYaml(readFileSync(path, 'utf8')) };
  });
  return indexConcepts(files);
}

export function indexConcepts(files) {
  const concepts = new Map();
  const problems = [];
  for (const file of files) {
    for (const concept of file.doc?.concepts ?? []) {
      if (concepts.has(concept.id)) problems.push(`concept ${concept.id} is declared twice (${concepts.get(concept.id).path} and ${file.path})`);
      else concepts.set(concept.id, { concept, path: file.path, doc: file.doc });
    }
  }
  return { files, concepts, problems };
}

function checkoutGit(url, ref) {
  const dir = mkdtempSync(join(tmpdir(), 'meaning-source-'));
  const git = (...args) => execFileSync('git', args, { stdio: 'pipe' });
  git('init', '-q', dir);
  git('-C', dir, 'fetch', '-q', '--depth', '1', url, ref);
  git('-C', dir, 'checkout', '-q', 'FETCH_HEAD');
  return dir;
}

// Resolves meaning:// repositories through `sources` (see meaningSources).
export function createResolver({ root, sources = meaningSources }) {
  const cache = new Map();
  return (repo, ref) => {
    const source = sources[repo];
    if (!source) return { error: `no source configured for meaning://${repo}` };
    if (source.git && !ref) return { error: `meaning://${repo} is read from git and needs a ?ref= pin` };
    const key = `${repo}@${ref ?? ''}`;
    if (!cache.has(key)) cache.set(key, loadMeaningDir(source.dir ? join(root, source.dir) : checkoutGit(source.git, ref)));
    return cache.get(key);
  };
}

function loadModels(file, doc) {
  const models = {};
  for (const [module, relative] of Object.entries(doc.models ?? {})) {
    const text = readFileSync(join(dirname(file), relative), 'utf8');
    models[module] = toModelspecJson(parseHcl(text), { id: module, name: module, version: 'unversioned' });
  }
  return models;
}

// Checks one repository's meaning files: `local` is the result of
// loadMeaningDir (or indexConcepts), `resolve` reads other repositories.
// Returns a list of problems; empty means every reference resolves.
export function checkMeaning({ local, resolve, schemaPath, models: givenModels }) {
  const problems = [...local.problems];
  const pins = new Map();
  const lookup = (ref, where) => {
    const parsed = parseConceptRef(ref);
    if (!parsed) { problems.push(`${where}: ${ref} is not a concept reference`); return null; }
    if (!parsed.repo) {
      const found = local.concepts.get(parsed.id);
      if (!found) problems.push(`${where}: concept ${parsed.id} is not declared in this repository`);
      return found ?? null;
    }
    const seen = pins.get(parsed.repo);
    if (seen !== undefined && seen !== (parsed.ref ?? '')) problems.push(`${where}: meaning://${parsed.repo} is pinned to both "${seen}" and "${parsed.ref ?? ''}"; use one pin per repository`);
    pins.set(parsed.repo, parsed.ref ?? '');
    const remote = resolve(parsed.repo, parsed.ref);
    if (remote.error) { problems.push(`${where}: ${remote.error}`); return null; }
    const found = remote.concepts.get(parsed.id);
    if (!found) problems.push(`${where}: concept ${parsed.id} does not exist in meaning://${parsed.repo}`);
    return found ?? null;
  };
  for (const file of local.files) {
    const { path, doc } = file;
    if (schemaPath) problems.push(...schemaProblems(doc, schemaPath).map((problem) => `${path}: schema: ${problem}`));
    if (!Array.isArray(doc?.concepts)) continue;
    let models = givenModels;
    try { models ??= loadModels(path, doc); } catch (error) { problems.push(`${path}: models: ${error.message}`); models = {}; }
    const sourceIds = new Set();
    for (const source of doc.sources ?? []) {
      if (sourceIds.has(source.id)) problems.push(`${path}: source ${source.id} is declared twice`);
      sourceIds.add(source.id);
    }
    for (const concept of doc.concepts) {
      const where = `${path}: concept ${concept.id}`;
      if (concept.of) {
        const owner = lookup(concept.of, `${where} of`);
        if (owner && owner.concept.kind !== 'entity') problems.push(`${where}: of names ${concept.of}, which is a ${owner.concept.kind}, not an entity`);
      }
      if (concept.extends) {
        lookup(concept.extends, `${where} extends`);
        const chain = [concept.id];
        for (let next = concept.extends; next && parseConceptRef(next)?.repo === undefined;) {
          if (chain.includes(next)) { problems.push(`${where}: extends forms a cycle (${[...chain, next].join(' -> ')})`); break; }
          chain.push(next);
          next = local.concepts.get(next)?.concept.extends;
        }
      }
      for (const ref of concept.measure?.inputs ?? []) lookup(ref, `${where} measure.inputs`);
      for (const ref of concept.measure?.dimensions ?? []) lookup(ref, `${where} measure.dimensions`);
      if (concept.source && !sourceIds.has(concept.source)) problems.push(`${where}: source ${concept.source} is not declared in sources`);
      const valueIds = new Set();
      const names = new Map();
      for (const value of concept.values ?? []) {
        if (valueIds.has(value.id)) problems.push(`${where}: value ${value.id} is declared twice`);
        valueIds.add(value.id);
        for (const language of new Set([...Object.keys(value.labels ?? {}), ...Object.keys(value.aliases ?? {})])) {
          for (const word of [value.labels?.[language], ...(value.aliases?.[language] ?? [])].filter(Boolean)) {
            const key = `${language}:${word.toLowerCase()}`;
            if (names.has(key) && names.get(key) !== value.id) problems.push(`${where}: "${word}" names both ${names.get(key)} and ${value.id}`);
            names.set(key, value.id);
          }
        }
      }
      for (const binding of concept.bindings ?? []) {
        const parsed = parseModelRef(binding.model);
        if (!parsed) { problems.push(`${where}: ${binding.model} is not a modelspec:// reference`); continue; }
        if (parsed.repo) { problems.push(`${where}: ${binding.model} points at another repository; this check resolves same-repository models only`); continue; }
        const model = models[parsed.module];
        if (!model) { problems.push(`${where}: ${binding.model}: module ${parsed.module} is not listed in models`); continue; }
        const entity = model.entities?.[parsed.name];
        if (!entity) { problems.push(`${where}: ${binding.model}: module ${parsed.module} has no entity ${parsed.name}`); continue; }
        if (binding.property && !(binding.property in (entity.properties ?? {}))) problems.push(`${where}: ${binding.model}: entity ${parsed.name} has no property ${binding.property}`);
      }
    }
  }
  return problems;
}

// The values a concept has, its own or inherited through extends.
// Bare ids in an inherited concept resolve in that concept's own repository.
export function effectiveValues(concept, local, resolve) {
  let repo = local;
  for (let depth = 0; concept && depth < 20; depth++) {
    if (concept.values) return concept.values;
    const parsed = concept.extends && parseConceptRef(concept.extends);
    if (!parsed) return [];
    if (parsed.repo) {
      repo = resolve(parsed.repo, parsed.ref);
      if (repo.error) return [];
    }
    concept = repo.concepts.get(parsed.id)?.concept;
  }
  return [];
}

// Checks that every distinct value stored in a bound column names exactly one
// of the concept's values (by label or alias, ignoring case). `data` is rows
// keyed by entity name.
export function valueCoverageProblems({ local, resolve, data }) {
  const problems = [];
  for (const { concept, path } of local.concepts.values()) {
    const values = effectiveValues(concept, local, resolve);
    if (values.length === 0) continue;
    for (const binding of concept.bindings ?? []) {
      if (!binding.property) continue;
      const entity = parseModelRef(binding.model)?.name;
      const stored = new Set((data[entity] ?? []).map((row) => row[binding.property]).filter((value) => value !== null && value !== undefined));
      for (const value of stored) {
        const matches = values.filter((candidate) => [...Object.values(candidate.labels ?? {}), ...Object.values(candidate.aliases ?? {}).flat()].some((word) => word.toLowerCase() === String(value).toLowerCase()));
        if (matches.length !== 1) problems.push(`${path}: concept ${concept.id}: ${entity}.${binding.property} value "${value}" matches ${matches.length === 0 ? 'no value' : `${matches.length} values (${matches.map((m) => m.id).join(', ')})`}`);
      }
    }
  }
  return problems;
}
