// Checks for meaning files (format meaning/draft-1, schema in
// model/vendor/meaninggraph-core/meaning.schema.json): JSON Schema validation,
// then the rules a schema cannot express. Every concept reference must
// resolve; extends joins compatible kinds only; values-of and units-of name
// entities; measures are computed from attributes and measures and grouped by
// dimensions and attributes; a ratio is never summed; every modelspec://
// binding must name an existing entity and property that fits its role; and
// values must cover the data they describe.
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

const conceptId = '[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*';
const bareRefPattern = new RegExp(`^${conceptId}$`);
const conceptRefPattern = new RegExp(`^meaning://([A-Za-z0-9.-]+(?:/[A-Za-z0-9._-]+)+)/(${conceptId})(?:\\?ref=([A-Za-z0-9._/-]+))?$`);
const modelRefPattern = /^modelspec:\/\/((?:[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._-]+)+)?)\/([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)(?:\?ref=([A-Za-z0-9._/-]+))?$/;

// A bare id is a concept in the same repository; meaning://{host}/{org}/{repo}/{id}
// is a concept in another one. The last path segment is the concept id.
export function parseConceptRef(ref) {
  if (bareRefPattern.test(ref)) return { id: ref };
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

// extends means "is a kind of", so it joins concepts of compatible kinds
// only: a concept's kind -> the kinds it may extend. An attribute and a
// dimension are both a property of an entity (a dimension is one that answers
// are grouped by), so they may extend each other.
export const extendsCompatibility = {
  entity: ['entity'],
  attribute: ['attribute', 'dimension'],
  dimension: ['dimension', 'attribute'],
  measure: ['measure'],
};
// What a measure may be computed from, and what it may be grouped by.
export const measureInputKinds = ['attribute', 'measure'];
export const measureDimensionKinds = ['dimension', 'attribute'];
// Aggregations that are wrong for a ratio: it is recomputed per group.
const ratioAggregations = ['sum', 'count', 'average'];
// Binding roles whose stored values name the concept's known values.
const valueRoles = ['value', 'display-name'];
const an = (kind) => `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;

// Resolves `ref` as written inside `repo` (a repository index from
// loadMeaningDir or indexConcepts): bare ids resolve in that repository,
// meaning:// ones through `resolve`. Returns { concept, repo } or null.
export function resolveConcept(ref, repo, resolve) {
  const parsed = ref && parseConceptRef(ref);
  if (!parsed) return null;
  const target = parsed.repo ? resolve(parsed.repo, parsed.ref) : repo;
  if (!target || target.error) return null;
  const found = target.concepts.get(parsed.id);
  return found ? { concept: found.concept, repo: target } : null;
}

// The concept and its ancestors through extends, nearest first. Stops at a
// repeat, so a cycle (reported by checkMeaning) cannot loop.
export function lineage(concept, repo, resolve) {
  const chain = [];
  for (let node = { concept, repo }; node && chain.length < 50; node = resolveConcept(node.concept.extends, node.repo, resolve)) {
    if (chain.some((seen) => seen.concept === node.concept)) break;
    chain.push(node);
  }
  return chain;
}

// The nearest concept along the lineage that sets `key`, with the repository
// it is written in (bare ids in its value resolve there), or null.
export function inherited(concept, repo, key, resolve) {
  return lineage(concept, repo, resolve).find((node) => node.concept[key] !== undefined) ?? null;
}

// A ratio is a measure computed from another measure, or a kind of a ratio.
// Returns the measure input that makes it one, or null.
export function ratioInput(concept, repo, resolve) {
  for (const node of lineage(concept, repo, resolve)) {
    for (const input of node.concept.measure?.inputs ?? []) {
      if (resolveConcept(input, node.repo, resolve)?.concept.kind === 'measure') return input;
    }
  }
  return null;
}

// The known values of a concept: its own, or those of the entity named by its
// values-of (its own or inherited through extends). extends never passes
// values themselves: a kind of country attribute holds countries, but an
// entity that extends another is not a list of the parent's instances.
export function effectiveValues(concept, local, resolve) {
  if (concept.values) return concept.values;
  const domain = inherited(concept, local, 'values-of', resolve);
  if (!domain) return [];
  return resolveConcept(domain.concept['values-of'], domain.repo, resolve)?.concept.values ?? [];
}

// The known values that a stored value names. `match` is labels (labels and
// aliases in any language, ignoring case) or codes.<code> (that code, exactly).
export function matchValues(values, stored, match = 'labels') {
  if (match.startsWith('codes.')) {
    const code = match.slice('codes.'.length);
    return values.filter((value) => value.codes?.[code] === String(stored));
  }
  const key = String(stored).toLowerCase();
  return values.filter((value) => [...Object.values(value.labels ?? {}), ...Object.values(value.aliases ?? {}).flat()].some((word) => word.toLowerCase() === key));
}

// Checks one repository's meaning files: `local` is the result of
// loadMeaningDir (or indexConcepts), `resolve` reads other repositories.
// Returns a list of problems; empty means the files are consistent.
export function checkMeaning({ local, resolve, schemaPath, models: givenModels }) {
  const problems = [...local.problems];
  // One pin per referenced repository across all of this repository's files:
  // the repository resolves against one version of each dependency.
  const pins = new Map();
  const lookup = (ref, where) => {
    const parsed = parseConceptRef(ref);
    if (!parsed) { problems.push(`${where}: ${ref} is not a concept reference`); return null; }
    if (!parsed.repo) {
      const found = local.concepts.get(parsed.id);
      if (!found) problems.push(`${where}: concept ${parsed.id} is not declared in this repository`);
      return found ? { concept: found.concept, repo: local } : null;
    }
    const seen = pins.get(parsed.repo);
    if (seen !== undefined && seen !== (parsed.ref ?? '')) problems.push(`${where}: meaning://${parsed.repo} is pinned to both "${seen}" and "${parsed.ref ?? ''}"; use one pin per repository`);
    pins.set(parsed.repo, parsed.ref ?? '');
    const remote = resolve(parsed.repo, parsed.ref);
    if (remote.error) { problems.push(`${where}: ${remote.error}`); return null; }
    const found = remote.concepts.get(parsed.id);
    if (!found) problems.push(`${where}: concept ${parsed.id} does not exist in meaning://${parsed.repo}`);
    return found ? { concept: found.concept, repo: remote } : null;
  };
  // ModelSpec entities whose rows are instances of a concept (role entity).
  const instanceEntities = (node) => (node?.concept.bindings ?? []).filter((b) => b.role === 'entity').map((b) => parseModelRef(b.model)?.name).filter(Boolean);
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
        if (owner && owner.concept.kind !== 'entity') problems.push(`${where}: of names ${concept.of}, which is ${an(owner.concept.kind)}, not an entity`);
      }
      if (concept.extends) {
        const parent = lookup(concept.extends, `${where} extends`);
        const allowed = extendsCompatibility[concept.kind] ?? [];
        if (parent && !allowed.includes(parent.concept.kind)) problems.push(`${where}: ${an(concept.kind)} cannot extend ${concept.extends}, which is ${an(parent.concept.kind)}; extends means "is a kind of", and ${an(concept.kind)} may extend only ${allowed.join(' or ')}`);
        const chain = [concept.id];
        for (let next = concept.extends; next && parseConceptRef(next)?.repo === undefined;) {
          if (chain.includes(next)) { problems.push(`${where}: extends forms a cycle (${[...chain, next].join(' -> ')})`); break; }
          chain.push(next);
          next = local.concepts.get(next)?.concept.extends;
        }
      }
      for (const key of ['values-of', 'units-of']) {
        if (!concept[key]) continue;
        const target = lookup(concept[key], `${where} ${key}`);
        if (target && target.concept.kind !== 'entity') problems.push(`${where}: ${key} names ${concept[key]}, which is ${an(target.concept.kind)}, not an entity`);
      }
      // A kind of an attribute whose values are instances of X holds instances
      // of X, or of a kind of X: values-of may narrow an inherited one, never change it.
      if (concept['values-of'] && concept.extends) {
        const parent = resolveConcept(concept.extends, local, resolve);
        const domain = parent && inherited(parent.concept, parent.repo, 'values-of', resolve);
        const required = domain && resolveConcept(domain.concept['values-of'], domain.repo, resolve);
        const own = resolveConcept(concept['values-of'], local, resolve);
        if (required && own && !lineage(own.concept, own.repo, resolve).some((node) => node.concept === required.concept)) problems.push(`${where}: values-of ${concept['values-of']} is neither ${domain.concept['values-of']} nor a kind of it, which ${concept.extends} requires`);
      }
      // With units-of (own or inherited) the unit names one value of that entity.
      const unitDomain = concept.unit && inherited(concept, local, 'units-of', resolve);
      if (unitDomain) {
        const entity = resolveConcept(unitDomain.concept['units-of'], unitDomain.repo, resolve);
        if (entity) {
          const unit = concept.unit.toLowerCase();
          const named = (entity.concept.values ?? []).filter((value) => [...Object.values(value.labels ?? {}), ...Object.values(value.aliases ?? {}).flat(), ...Object.values(value.codes ?? {})].some((word) => word.toLowerCase() === unit));
          if (named.length !== 1) problems.push(`${where}: unit "${concept.unit}" must name exactly one value of ${unitDomain.concept['units-of']} (units-of), but names ${named.length === 0 ? 'none' : named.map((value) => value.id).join(', ')}`);
        }
      }
      for (const ref of concept.measure?.inputs ?? []) {
        const input = lookup(ref, `${where} measure.inputs`);
        if (input && !measureInputKinds.includes(input.concept.kind)) problems.push(`${where}: measure.inputs names ${ref}, which is ${an(input.concept.kind)}; a measure is computed from attributes and measures only`);
      }
      for (const ref of concept.measure?.dimensions ?? []) {
        const dimension = lookup(ref, `${where} measure.dimensions`);
        if (dimension && !measureDimensionKinds.includes(dimension.concept.kind)) problems.push(`${where}: measure.dimensions names ${ref}, which is ${an(dimension.concept.kind)}; a measure is grouped by dimensions or attributes only`);
      }
      const aggregation = concept.measure?.aggregation;
      if (ratioAggregations.includes(aggregation)) {
        const ratio = ratioInput(concept, local, resolve);
        if (ratio) problems.push(`${where}: aggregation ${aggregation} on a ratio (it is computed from the measure ${ratio}); a ratio is recomputed per group from its inputs, so its aggregation is none`);
      }
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
        if (!binding.property) continue;
        const member = entity.properties?.[binding.property];
        if (!member) { problems.push(`${where}: ${binding.model}: entity ${parsed.name} has no property ${binding.property}`); continue; }
        const at = `${where}: ${parsed.name}.${binding.property}`;
        if (binding.role === 'identifier' && !(entity.key ?? []).includes(binding.property)) problems.push(`${at} has role identifier but is not in the key of ${parsed.name} [${(entity.key ?? []).join(', ')}]`);
        if (binding.role === 'display-name' && member.type !== 'string') problems.push(`${at} has role display-name but is ${member.entity ? `a reference to ${member.entity}` : an(member.type)}, not a string`);
        if (binding.role === 'value' && member.entity) problems.push(`${at} has role value but is a reference to ${member.entity}; bind it with role foreign-key`);
        if (binding.role === 'foreign-key') {
          if (!member.entity) { problems.push(`${at} has role foreign-key but is not a reference (it is ${an(member.type)})`); continue; }
          // The reference must point at the entity whose rows are the instances:
          // this concept's own (an entity) or those of its values-of entity.
          let target = null;
          if (concept.kind === 'entity') target = { concept, repo: local };
          else {
            const domain = inherited(concept, local, 'values-of', resolve);
            if (!domain) { problems.push(`${at} has role foreign-key, so ${concept.id} needs values-of: the entity its references point at`); continue; }
            target = resolveConcept(domain.concept['values-of'], domain.repo, resolve);
          }
          const expected = instanceEntities(target);
          if (expected.length > 0 && !expected.includes(member.entity)) problems.push(`${at} references ${member.entity}, but the instances of ${target.concept.id} are ${expected.join(', ')} rows`);
        }
      }
    }
  }
  return problems;
}

// Checks that every distinct value stored in a column bound with role value
// or display-name names exactly one of the concept's known values (see
// effectiveValues), matched as the binding's `match` says. `data` is rows
// keyed by entity name.
export function valueCoverageProblems({ local, resolve, data }) {
  const problems = [];
  for (const { concept, path } of local.concepts.values()) {
    const values = effectiveValues(concept, local, resolve);
    if (values.length === 0) continue;
    for (const binding of concept.bindings ?? []) {
      if (!binding.property || !valueRoles.includes(binding.role)) continue;
      const match = binding.match ?? 'labels';
      const entity = parseModelRef(binding.model)?.name;
      const stored = new Set((data[entity] ?? []).map((row) => row[binding.property]).filter((value) => value !== null && value !== undefined));
      for (const value of stored) {
        const matches = matchValues(values, value, match);
        if (matches.length !== 1) problems.push(`${path}: concept ${concept.id}: ${entity}.${binding.property} value "${value}" matches ${matches.length === 0 ? 'no value' : `${matches.length} values (${matches.map((m) => m.id).join(', ')})`}${match === 'labels' ? '' : ` by ${match}`}`);
      }
    }
  }
  return problems;
}
