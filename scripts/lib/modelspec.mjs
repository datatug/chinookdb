// ModelSpec helpers for the model in model/: a parser for the HCL subset that
// ModelSpec v0 uses, the JSON AST serialization
// (https://github.com/specscore/modelspec, spec/json-format.md), the structural
// checks that spec lists, and a comparison with the published data. It reads both
// spellings of ModelSpec: the current one (record, field, record =; format
// 1.0-draft-2) and the earlier, deprecated one (entity, property, entity =; format
// 1.0-draft), and refuses the constructs ModelSpec removed or reserved.
//
// Written against the ModelSpec specification at specscore/modelspec@133134b
// (spec/core-model.md "Deprecated Spellings" and "Removed Constructs And Reserved
// Words", spec/hcl-authoring.md, spec/json-format.md, decisions 0014, 0018, 0019
// and 0020), and checked against the reference CLI, `modelspec` 0.2.0. CI validates
// the model with the released `modelspec` tool (pnpm lint:model, pnpm
// check:model-twin); this file is what `pnpm generate` writes the JSON twin with,
// and the data comparison.
//
// The reading logic follows modelspec-org/registry (scripts/lib/modelspec.mjs); this
// file keeps the functions this repository calls and adds the comparison with the
// published data. It writes the JSON twin in the vocabulary of its HCL source, as
// `modelspec export` does.
//
// The parser accepts only what ModelSpec v0 HCL allows: named blocks, and
// attributes whose values are strings, numbers, booleans or lists of those. It
// rejects expressions, interpolation and map-style containers rather than
// guessing, so an unsupported construct fails loudly.

export const primitiveTypes = ['string', 'int', 'float', 'bool', 'decimal', 'uuid', 'date', 'time', 'datetime', 'document', 'json', 'any'];
export const reservedNames = ['records', 'entities', 'components', 'enums', 'collections', 'recordsets'];
const constraintTypes = { required: 'boolean', unique: 'boolean', min_len: 'integer', max_len: 'integer', pattern: 'string', format: 'string' };

// The two vocabularies, the whole of what differs between them (decisions 0018 and
// 0020). `record` is the HCL block of a record type, the HCL setting of a member that
// names a record type, and the JSON key of that setting; `field` is the HCL block of a
// member of a record type; `records` and `fields` are the JSON keys of a document's
// record types and of a record type's members. The JSON identifier decides which
// vocabulary a document is in; in HCL the words may be mixed in one file. A component
// has `fields` and a `field` block under both. The earlier vocabulary is deprecated
// and still read.
export const vocabularies = {
  earlier: { identifier: '1.0-draft', record: 'entity', field: 'property', records: 'entities', fields: 'properties' },
  current: { identifier: '1.0-draft-2', record: 'record', field: 'field', records: 'records', fields: 'fields' },
};
const { earlier, current } = vocabularies;
const both = [current, earlier];
const recordBlocks = both.map((words) => words.record);
const fieldBlocks = both.map((words) => words.field);
// The vocabulary a JSON document's identifier names, or undefined.
export const vocabularyOf = (json) => both.find((words) => words.identifier === json?.modelspec);
// The vocabulary the other way round.
const otherThan = (vocabulary) => (vocabulary === earlier ? current : earlier);

// Constructs of earlier drafts that a reader refuses, with the word that names them in
// HCL (a block) and, where there is one, in JSON (a top-level field): removed ones were
// part of the language, reserved ones are kept free for a later version (decision 0019).
const refusedWords = [
  { word: 'collection', status: 'removed', json: 'collections' },
  { word: 'recordset', status: 'removed', json: 'recordsets' },
  { word: 'column', status: 'removed' },
  { word: 'projection', status: 'reserved', json: 'projections' },
  { word: 'index', status: 'reserved' },
  { word: 'migration', status: 'reserved', json: 'migrations' },
];
const refusal = ({ word, status }, noun) => (status === 'removed'
  ? `the ${word} ${noun} was removed from ModelSpec (decision 0019)`
  : `the ${word} ${noun} is reserved by ModelSpec and has no content (decision 0019); remove it`);

function tokenize(text) {
  const tokens = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#' || (c === '/' && text[i + 1] === '/')) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`line ${line}: unterminated comment`);
      line += text.slice(i, end).split('\n').length - 1;
      i = end + 2;
      continue;
    }
    if ('{}[]=,'.includes(c)) { tokens.push({ kind: c, line }); i++; continue; }
    if (c === '"') {
      let value = '';
      i++;
      while (text[i] !== '"') {
        if (i >= text.length || text[i] === '\n') throw new Error(`line ${line}: unterminated string`);
        if (text[i] === '$' && text[i + 1] === '{') throw new Error(`line ${line}: string interpolation is not ModelSpec v0`);
        if (text[i] === '\\') {
          const escaped = { n: '\n', t: '\t', '"': '"', '\\': '\\' }[text[i + 1]];
          if (escaped === undefined) throw new Error(`line ${line}: unsupported escape \\${text[i + 1]}`);
          value += escaped;
          i += 2;
        } else value += text[i++];
      }
      i++;
      tokens.push({ kind: 'string', value, line });
      continue;
    }
    const number = /^-?\d+(\.\d+)?/.exec(text.slice(i));
    if (number) { tokens.push({ kind: 'number', value: Number(number[0]), line }); i += number[0].length; continue; }
    const ident = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(i));
    if (ident) { tokens.push({ kind: 'ident', value: ident[0], line }); i += ident[0].length; continue; }
    throw new Error(`line ${line}: unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// Parses ModelSpec HCL into { blocks: [{ type, name, line, attributes, blocks }] }.
export function parseHcl(text) {
  const tokens = tokenize(text);
  let p = 0;
  const peek = () => tokens[p];
  const expect = (kind) => {
    const token = tokens[p];
    if (!token || token.kind !== kind) throw new Error(`line ${token?.line ?? 'EOF'}: expected ${kind}, found ${token ? token.value ?? token.kind : 'end of file'}`);
    p++;
    return token;
  };
  const value = () => {
    const token = tokens[p++];
    if (!token) throw new Error('unexpected end of file in a value');
    if (token.kind === 'string' || token.kind === 'number') return token.value;
    if (token.kind === 'ident' && (token.value === 'true' || token.value === 'false')) return token.value === 'true';
    if (token.kind === '[') {
      const list = [];
      while (peek()?.kind !== ']') {
        const item = value();
        if (Array.isArray(item)) throw new Error(`line ${token.line}: nested lists are not ModelSpec v0`);
        list.push(item);
        if (peek()?.kind === ',') p++;
        else break;
      }
      expect(']');
      return list;
    }
    if (token.kind === '{') throw new Error(`line ${token.line}: map-style values are not ModelSpec v0 syntax; use named blocks`);
    throw new Error(`line ${token.line}: ${token.value ?? token.kind} is not a literal (expressions are not ModelSpec v0)`);
  };
  const body = (closing) => {
    const attributes = Object.create(null);
    const blocks = [];
    while (peek() && peek().kind !== closing) {
      const name = expect('ident');
      if (peek()?.kind === '=') {
        p++;
        if (Object.hasOwn(attributes, name.value)) throw new Error(`line ${name.line}: duplicate attribute ${name.value}`);
        attributes[name.value] = value();
      } else {
        const label = expect('string');
        expect('{');
        const inner = body('}');
        expect('}');
        blocks.push({ type: name.value, name: label.value, line: name.line, ...inner });
      }
    }
    return { attributes, blocks };
  };
  const document = body(undefined);
  if (Object.keys(document.attributes).length > 0) throw new Error('top-level attributes are not ModelSpec v0');
  return document;
}

// Throws for a removed or reserved block anywhere in the source, naming the word.
function refuseRemovedBlocks(blocks) {
  for (const block of blocks) {
    const refused = refusedWords.find(({ word }) => word === block.type);
    if (refused) throw new Error(`line ${block.line}: ${refusal(refused, 'block')}`);
    refuseRemovedBlocks(block.blocks);
  }
}

// ---- HCL to JSON -----------------------------------------------------------

// A source that holds any word of the earlier spelling is exported in the earlier
// vocabulary, as `modelspec export` does, so that a model and its JSON twin stay in
// step until both are rewritten. Only a source in the current spelling alone is
// exported as `1.0-draft-2`.
export const hclUsesEarlier = (document) => document.blocks.some((block) => block.type === earlier.record
  || block.blocks.some((child) => child.type === earlier.field || Object.hasOwn(child.attributes, earlier.record)));

// A member's settings, with its reference to a record type spelled as `vocabulary` spells it.
// One member that carries both spellings of the reference is an error.
function memberSettings(member, vocabulary) {
  if (both.every((words) => Object.hasOwn(member.attributes, words.record))) {
    throw new Error(`line ${member.line}: ${member.type} "${member.name}" has both ${earlier.record} and ${current.record}; a member refers to one record type`);
  }
  return Object.fromEntries(Object.entries(member.attributes).map(([name, value]) => [both.some((words) => words.record === name) ? vocabulary.record : name, value]));
}

// The members of a record type or a component, keyed by name. `allowed` are the block
// types a member may have.
function members(block, allowed, vocabulary) {
  const out = Object.create(null);
  for (const child of block.blocks) {
    if (!allowed.includes(child.type)) throw new Error(`line ${child.line}: ${block.type} "${block.name}" cannot contain ${/^[aeiou]/.test(child.type) ? 'an' : 'a'} ${child.type} block (this converter supports ${allowed.join(', ')})`);
    if (child.blocks.length > 0) throw new Error(`line ${child.line}: ${child.type} "${child.name}" cannot contain blocks`);
    if (Object.hasOwn(out, child.name)) throw new Error(`line ${child.line}: duplicate ${child.type} "${child.name}" in ${block.type} "${block.name}"`);
    out[child.name] = memberSettings(child, vocabulary);
  }
  return out;
}

function recordJson(block, vocabulary) {
  const { key, use, ...rest } = block.attributes;
  if (Object.keys(rest).length > 0) throw new Error(`line ${block.line}: unsupported ${block.type} attribute ${Object.keys(rest).join(', ')}`);
  return { ...(key ? { key } : {}), ...(use ? { use } : {}), [vocabulary.fields]: members(block, fieldBlocks, vocabulary) };
}

// Serializes parsed HCL to the ModelSpec JSON AST. `module` is { id, name, version }:
// standalone HCL has no place for module identity, so the caller supplies it.
export function toModelspecJson(document, module) {
  refuseRemovedBlocks(document.blocks);
  const vocabulary = hclUsesEarlier(document) ? earlier : current;
  const json = { modelspec: vocabulary.identifier, module };
  const add = (kind, block, value) => {
    json[kind] ??= Object.create(null);
    if (Object.hasOwn(json[kind], block.name)) throw new Error(`line ${block.line}: duplicate ${block.type} "${block.name}"`);
    json[kind][block.name] = value;
  };
  for (const block of document.blocks) {
    if (recordBlocks.includes(block.type)) {
      add(vocabulary.records, block, recordJson(block, vocabulary));
    } else if (block.type === 'component') {
      add('components', block, { fields: members(block, ['field'], vocabulary) });
    } else if (block.type === 'enum') {
      if (block.blocks.length > 0) throw new Error(`line ${block.line}: enum "${block.name}" cannot contain blocks`);
      add('enums', block, { ...block.attributes });
    } else {
      throw new Error(`line ${block.line}: top-level ${block.type} blocks are not supported by this converter (${[...recordBlocks, 'component', 'enum'].join(', ')})`);
    }
  }
  return json;
}

export const serializeModel = (json) => `${JSON.stringify(json, null, 2)}\n`;

// ---- JSON ------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The shape the structural checks below rely on, so that a malformed file is
// a problem and never an exception. Returns problems.
function shapeProblems(json, vocabulary) {
  const problems = [];
  for (const refused of refusedWords.filter((candidate) => candidate.json && Object.hasOwn(json, candidate.json))) problems.push(refusal({ ...refused, word: refused.json }, 'field'));
  if (!isObject(json.module)) problems.push('module must be an object');
  for (const [kind, member] of [[vocabulary.records, vocabulary.fields], ['components', 'fields']]) {
    if (json[kind] === undefined) continue;
    if (!isObject(json[kind])) { problems.push(`${kind} must be an object keyed by name`); continue; }
    for (const [name, concept] of Object.entries(json[kind])) {
      if (!isObject(concept) || !isObject(concept[member])) { problems.push(`${kind} ${name} must be an object with ${member}`); continue; }
      for (const [memberName, value] of Object.entries(concept[member])) if (!isObject(value)) problems.push(`${name}.${memberName} must be an object`);
      if (kind === vocabulary.records) {
        if (concept.key !== undefined && !(Array.isArray(concept.key) && concept.key.every((item) => typeof item === 'string'))) problems.push(`${vocabulary.record} ${name} key must be a list of ${vocabulary.field} names`);
        if (concept.use !== undefined && !(Array.isArray(concept.use) && concept.use.every((item) => typeof item === 'string'))) problems.push(`${vocabulary.record} ${name} use must be a list of component names`);
      }
    }
  }
  if (json.enums !== undefined) {
    if (!isObject(json.enums)) problems.push('enums must be an object keyed by name');
    else for (const [name, value] of Object.entries(json.enums)) if (!isObject(value)) problems.push(`enum ${name} must be an object`);
  }
  return problems;
}

// The identifier decides the vocabulary: a key of the other vocabulary is an error.
// Components use `fields` under both identifiers, so only their members are checked.
// Run after shapeProblems, so every record type and component is an object with its members.
function foreignKeyProblems(json, vocabulary) {
  const foreign = otherThan(vocabulary);
  const wrong = (where, foreignKey, ownKey) => `${where}"${foreignKey}" is a key of format ${foreign.identifier}; this document says "${vocabulary.identifier}", where it is "${ownKey}"`;
  const problems = [];
  if (Object.hasOwn(json, foreign.records)) problems.push(wrong('', foreign.records, vocabulary.records));
  const memberSets = [
    ...Object.entries(json.components ?? {}).map(([name, component]) => [name, component.fields]),
    ...Object.entries(json[vocabulary.records] ?? {}).map(([name, record]) => [name, record[vocabulary.fields]]),
  ];
  for (const [name, record] of Object.entries(json[vocabulary.records] ?? {})) {
    if (Object.hasOwn(record, foreign.fields)) problems.push(wrong(`${vocabulary.record} ${name}: `, foreign.fields, vocabulary.fields));
  }
  for (const [name, set] of memberSets) {
    for (const [memberName, member] of Object.entries(set)) {
      if (Object.hasOwn(member, foreign.record)) problems.push(wrong(`${name}.${memberName}: `, foreign.record, vocabulary.record));
    }
  }
  return problems;
}

// Structural checks from ModelSpec spec/json-format.md "Validation
// Requirements", for records, components and enums, in the vocabulary that the
// document's identifier names. Returns problems.
export function validateModel(json) {
  if (!isObject(json)) return ['the JSON AST must be an object'];
  const vocabulary = vocabularyOf(json);
  if (!vocabulary) return [`modelspec must be "${current.identifier}" (or "${earlier.identifier}", the earlier spelling)`];
  const shape = shapeProblems(json, vocabulary);
  if (shape.length > 0) return shape;
  const problems = foreignKeyProblems(json, vocabulary);
  if (!json.module?.id || !json.module?.version) problems.push('module.id and module.version are required');
  const declared = new Map();
  for (const kind of [vocabulary.records, 'components', 'enums']) {
    for (const name of Object.keys(json[kind] ?? {})) {
      if (reservedNames.includes(name)) problems.push(`${name} is a reserved name`);
      if (name.includes('.')) problems.push(`${name}: concept names cannot contain dots`);
      if (declared.has(name)) problems.push(`${name} is declared as both ${declared.get(name)} and ${kind}`);
      declared.set(name, kind);
    }
  }
  const resolves = (name, kind) => declared.get(name) === kind;
  // A module-qualified name (decision 0014) needs a module resolver, which
  // draft 1 of the registry does not have: it is reported, never guessed at.
  const unresolved = (where, kind, name) => (String(name).includes('.')
    ? `${where} names ${kind} ${name} of another module; the registry cannot resolve module-qualified references yet`
    : `${where} references unknown ${kind} ${name}`);
  for (const [name, enumDef] of Object.entries(json.enums ?? {})) {
    const values = enumDef.values;
    if (!Array.isArray(values) || values.length === 0) problems.push(`enum ${name} needs a non-empty values list`);
    else if (new Set(values).size !== values.length) problems.push(`enum ${name} has duplicate values`);
  }
  const referenceAttributes = ['type', vocabulary.record, 'component', 'enum'];
  const checkMember = (where, member) => {
    const kinds = referenceAttributes.filter((attribute) => Object.hasOwn(member, attribute) && attribute !== 'enum');
    if (kinds.length !== 1) problems.push(`${where} must have exactly one of type, ${vocabulary.record}, component`);
    if (Object.hasOwn(member, 'type') && !primitiveTypes.includes(member.type)) problems.push(`${where} has unsupported type ${JSON.stringify(member.type)}`);
    if (Object.hasOwn(member, vocabulary.record) && !resolves(member[vocabulary.record], vocabulary.records)) problems.push(unresolved(where, vocabulary.record, member[vocabulary.record]));
    if (Object.hasOwn(member, 'component') && !resolves(member.component, 'components')) problems.push(unresolved(where, 'component', member.component));
    if (Object.hasOwn(member, 'enum') && typeof member.enum === 'string' && !resolves(member.enum, 'enums')) problems.push(unresolved(where, 'enum', member.enum));
    if (Object.hasOwn(member, 'enum') && typeof member.enum !== 'string' && !(Array.isArray(member.enum) && member.enum.length > 0)) problems.push(`${where} enum must name an enum or list values`);
    for (const [attribute, value] of Object.entries(member)) {
      // A key of the other vocabulary has been reported already.
      if (referenceAttributes.includes(attribute) || attribute === otherThan(vocabulary).record) continue;
      const expected = constraintTypes[attribute];
      if (!expected) { problems.push(`${where} has unsupported attribute ${attribute}`); continue; }
      const ok = expected === 'integer' ? Number.isInteger(value) && value >= 0 : typeof value === expected;
      if (!ok) problems.push(`${where}.${attribute} must be ${expected === 'integer' ? 'a non-negative integer' : `a ${expected}`}`);
    }
  };
  for (const [name, component] of Object.entries(json.components ?? {})) {
    for (const [field, member] of Object.entries(component.fields ?? {})) checkMember(`${name}.${field}`, member);
  }
  for (const [name, record] of Object.entries(json[vocabulary.records] ?? {})) {
    if (record.key !== undefined && (!Array.isArray(record.key) || record.key.length === 0)) problems.push(`${vocabulary.record} ${name} key must be a non-empty list when present`);
    const keys = new Set();
    for (const keyField of Array.isArray(record.key) ? record.key : []) {
      if (keys.has(keyField)) problems.push(`${vocabulary.record} ${name} key ${keyField} is duplicated`);
      keys.add(keyField);
      if (!Object.hasOwn(record[vocabulary.fields] ?? {}, keyField)) problems.push(`${vocabulary.record} ${name} key ${keyField} is not a ${vocabulary.field}`);
    }
    for (const used of record.use ?? []) if (!resolves(used, 'components')) problems.push(unresolved(`${vocabulary.record} ${name}`, 'component', used));
    for (const [field, member] of Object.entries(record[vocabulary.fields] ?? {})) checkMember(`${name}.${field}`, member);
  }
  return problems;
}

// ---- the comparison with the published data -----------------------------------

// The ModelSpec type each SQLite storage type maps to, and its max_len.
export function storageToModel(sqliteType) {
  const varchar = /^NVARCHAR\((\d+)\)$/.exec(sqliteType);
  if (varchar) return { type: 'string', max_len: Number(varchar[1]) };
  return { INTEGER: { type: 'int' }, DATETIME: { type: 'datetime' }, 'NUMERIC(10,2)': { type: 'decimal' } }[sqliteType] ?? { type: `unmapped ${sqliteType}` };
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const verifiedFormats = ['email'];
const datetimePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// Compares the model with the published data: `schema` is src/data/schema.json
// (tables, columns, keys and foreign keys read from the SQLite source) and
// `data` is public/data/chinook.json (rows keyed by table). `model` is a JSON AST
// in either vocabulary; the problems are worded in the vocabulary of its
// identifier. Returns problems.
export function compareModelWithData(model, schema, data) {
  const problems = [];
  const vocabulary = vocabularyOf(model) ?? earlier;
  const entities = model[vocabulary.records] ?? {};
  const tables = new Map(schema.tables.map((table) => [table.name, table]));
  const sorted = (values) => [...values].sort();
  if (JSON.stringify(sorted(Object.keys(entities))) !== JSON.stringify(sorted(Object.keys(data)))) problems.push(`${vocabulary.records} [${sorted(Object.keys(entities)).join(', ')}] differ from data tables [${sorted(Object.keys(data)).join(', ')}]`);
  for (const [name, entity] of Object.entries(entities)) {
    const table = tables.get(name);
    const rows = data[name];
    if (!table || !rows) { problems.push(`${vocabulary.record} ${name} has no published table`); continue; }
    const columns = new Set(rows.flatMap((row) => Object.keys(row)));
    for (const column of table.columns) columns.add(column.name);
    const properties = Object.keys(entity[vocabulary.fields] ?? {});
    for (const column of columns) if (!properties.includes(column)) problems.push(`${name}.${column} is in the data but not in the model`);
    for (const property of properties) if (!columns.has(property)) problems.push(`${name}.${property} is in the model but not in the data`);
    const primaryKey = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
    if (JSON.stringify(entity.key ?? []) !== JSON.stringify(primaryKey)) problems.push(`${name} key [${(entity.key ?? []).join(', ')}] differs from the primary key [${primaryKey.join(', ')}]`);
    for (const column of table.columns) {
      const member = entity[vocabulary.fields]?.[column.name];
      if (!member) continue;
      const where = `${name}.${column.name}`;
      const reference = member[vocabulary.record];
      const foreignKey = table.foreignKeys.find((fk) => fk.column === column.name);
      if (foreignKey) {
        if (reference !== foreignKey.table) problems.push(`${where} references ${foreignKey.table} in the data but the model says ${reference ? `${vocabulary.record} ${reference}` : `type ${member.type}`}`);
        const target = tables.get(foreignKey.table);
        const targetKey = target?.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? [];
        if (JSON.stringify(targetKey) !== JSON.stringify([foreignKey.referencedColumn])) problems.push(`${where} references ${foreignKey.table}.${foreignKey.referencedColumn}, which is not that ${vocabulary.record}'s whole key`);
      } else {
        if (reference) problems.push(`${where} is a reference to ${reference} in the model but has no foreign key in the data`);
        const expected = storageToModel(column.type);
        if (member.type !== expected.type) problems.push(`${where} is ${member.type} in the model, ${column.type} (${expected.type}) in the data`);
        if (expected.max_len !== undefined && member.max_len !== expected.max_len) problems.push(`${where} max_len is ${member.max_len}, the data allows ${expected.max_len}`);
      }
      if (Boolean(member.required) === column.nullable) problems.push(`${where} is ${member.required ? 'required' : 'optional'} in the model but ${column.nullable ? 'nullable' : 'NOT NULL'} in the data`);
      // Every constraint the model states is checked against the rows; one
      // this comparer cannot check is a problem, never silently accepted.
      if (member.format !== undefined && !verifiedFormats.includes(member.format)) problems.push(`${where} format "${member.format}" is not checked against the data (checked: ${verifiedFormats.join(', ')})`);
      const pattern = member.pattern === undefined ? null : new RegExp(`^(?:${member.pattern})$`, 'u');
      const allowed = typeof member.enum === 'string' ? model.enums?.[member.enum]?.values : member.enum;
      const rowProblems = [];
      const seen = new Map();
      for (const [index, row] of rows.entries()) {
        const value = row[column.name];
        if (value === null || value === undefined) {
          if (member.required) rowProblems.push(`${where} is required but row ${index} has no value`);
          continue;
        }
        const type = reference ? 'int' : member.type;
        const fits = { int: Number.isInteger(value), decimal: typeof value === 'number', string: typeof value === 'string', datetime: typeof value === 'string' && datetimePattern.test(value) }[type];
        if (!fits) rowProblems.push(`${where} row ${index} value ${JSON.stringify(value)} is not a ${type}`);
        if (member.max_len !== undefined && String(value).length > member.max_len) rowProblems.push(`${where} row ${index} is longer than ${member.max_len}`);
        if (member.min_len !== undefined && String(value).length < member.min_len) rowProblems.push(`${where} row ${index} is shorter than ${member.min_len}`);
        if (pattern && !pattern.test(String(value))) rowProblems.push(`${where} row ${index} value ${JSON.stringify(value)} does not match pattern ${member.pattern}`);
        if (allowed && !allowed.includes(value)) rowProblems.push(`${where} row ${index} value ${JSON.stringify(value)} is not one of the enum values`);
        if (member.format === 'email' && !emailPattern.test(value)) rowProblems.push(`${where} row ${index} is not an email address`);
        if (member.unique) {
          if (seen.has(value)) rowProblems.push(`${where} is unique but rows ${seen.get(value)} and ${index} both hold ${JSON.stringify(value)}`);
          else seen.set(value, index);
        }
      }
      // A wrong type fails every row; three examples say enough.
      problems.push(...rowProblems.slice(0, 3));
      if (rowProblems.length > 3) problems.push(`${where}: ${rowProblems.length - 3} more row problems`);
    }
  }
  return problems;
}
