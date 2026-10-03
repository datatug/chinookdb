// ModelSpec helpers for model/chinook.modelspec.hcl: a parser for the HCL
// subset that ModelSpec v0 uses, the JSON AST serialization
// (https://github.com/specscore/modelspec, spec/json-format.md), the
// structural checks that spec lists, and a comparison with the published data.
//
// The parser accepts only what ModelSpec v0 HCL allows: named blocks, and
// attributes whose values are strings, numbers, booleans or lists of those. It
// rejects expressions, interpolation and map-style containers rather than
// guessing, so an unsupported construct fails loudly. CI also runs the real
// HCL parser through `specscore graph lint` (scripts/lint-modelspec.sh).

export const modelspecVersion = '1.0-draft';
export const primitiveTypes = ['string', 'int', 'float', 'bool', 'decimal', 'uuid', 'date', 'time', 'datetime', 'document', 'json', 'any'];
export const reservedNames = ['entities', 'components', 'enums', 'collections', 'recordsets'];
const constraintTypes = { required: 'boolean', unique: 'boolean', min_len: 'integer', max_len: 'integer', pattern: 'string', format: 'string' };
const referenceAttributes = ['type', 'entity', 'component', 'enum'];

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
    const attributes = {};
    const blocks = [];
    while (peek() && peek().kind !== closing) {
      const name = expect('ident');
      if (peek()?.kind === '=') {
        p++;
        if (name.value in attributes) throw new Error(`line ${name.line}: duplicate attribute ${name.value}`);
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

function members(block, memberType, allowed) {
  const out = {};
  for (const child of block.blocks) {
    if (!allowed.includes(child.type)) throw new Error(`line ${child.line}: ${block.type} "${block.name}" cannot contain a ${child.type} block (this converter supports ${allowed.join(', ')})`);
    if (child.type !== memberType) continue;
    if (child.blocks.length > 0) throw new Error(`line ${child.line}: ${child.type} "${child.name}" cannot contain blocks`);
    if (child.name in out) throw new Error(`line ${child.line}: duplicate ${child.type} "${child.name}" in ${block.type} "${block.name}"`);
    out[child.name] = { ...child.attributes };
  }
  return out;
}

// Serializes parsed HCL to the ModelSpec JSON AST. `module` is { id, name, version }:
// standalone HCL has no place for module identity, so the caller supplies it.
export function toModelspecJson(document, module) {
  const json = { modelspec: modelspecVersion, module };
  const add = (kind, name, value, line) => {
    json[kind] ??= {};
    if (name in json[kind]) throw new Error(`line ${line}: duplicate ${{ entities: 'entity', components: 'component', enums: 'enum' }[kind]} "${name}"`);
    json[kind][name] = value;
  };
  for (const block of document.blocks) {
    if (block.type === 'entity') {
      const { key, use, ...rest } = block.attributes;
      if (Object.keys(rest).length > 0) throw new Error(`line ${block.line}: unsupported entity attribute ${Object.keys(rest).join(', ')}`);
      add('entities', block.name, { ...(key ? { key } : {}), ...(use ? { use } : {}), properties: members(block, 'property', ['property']) }, block.line);
    } else if (block.type === 'component') {
      add('components', block.name, { fields: members(block, 'field', ['field']) }, block.line);
    } else if (block.type === 'enum') {
      if (block.blocks.length > 0) throw new Error(`line ${block.line}: enum "${block.name}" cannot contain blocks`);
      add('enums', block.name, { ...block.attributes }, block.line);
    } else {
      throw new Error(`line ${block.line}: top-level ${block.type} blocks are not supported by this converter (entity, component, enum)`);
    }
  }
  return json;
}

export const serializeModel = (json) => `${JSON.stringify(json, null, 2)}\n`;

// Structural checks from ModelSpec spec/json-format.md "Validation
// Requirements", for entities, components and enums. Returns problems.
export function validateModel(json) {
  const problems = [];
  if (json.modelspec !== modelspecVersion) problems.push(`modelspec must be "${modelspecVersion}"`);
  if (!json.module?.id || !json.module?.version) problems.push('module.id and module.version are required');
  const trio = new Map();
  for (const kind of ['entities', 'components', 'enums']) {
    for (const name of Object.keys(json[kind] ?? {})) {
      if (reservedNames.includes(name)) problems.push(`${name} is a reserved name`);
      if (name.includes('.')) problems.push(`${name}: concept names cannot contain dots`);
      if (trio.has(name)) problems.push(`${name} is declared as both ${trio.get(name)} and ${kind}`);
      trio.set(name, kind);
    }
  }
  const resolves = (name, kind) => trio.get(name) === kind;
  for (const [name, enumDef] of Object.entries(json.enums ?? {})) {
    const values = enumDef.values;
    if (!Array.isArray(values) || values.length === 0) problems.push(`enum ${name} needs a non-empty values list`);
    else if (new Set(values).size !== values.length) problems.push(`enum ${name} has duplicate values`);
  }
  const checkMember = (where, member) => {
    const kinds = referenceAttributes.filter((attribute) => attribute in member && attribute !== 'enum');
    if (kinds.length !== 1) problems.push(`${where} must have exactly one of type, entity, component`);
    if ('type' in member && !primitiveTypes.includes(member.type)) problems.push(`${where} has unsupported type ${JSON.stringify(member.type)}`);
    if ('entity' in member && !resolves(member.entity, 'entities')) problems.push(`${where} references unknown entity ${member.entity}`);
    if ('component' in member && !resolves(member.component, 'components')) problems.push(`${where} references unknown component ${member.component}`);
    if ('enum' in member && typeof member.enum === 'string' && !resolves(member.enum, 'enums')) problems.push(`${where} references unknown enum ${member.enum}`);
    if ('enum' in member && typeof member.enum !== 'string' && !(Array.isArray(member.enum) && member.enum.length > 0)) problems.push(`${where} enum must name an enum or list values`);
    for (const [attribute, value] of Object.entries(member)) {
      if (referenceAttributes.includes(attribute)) continue;
      const expected = constraintTypes[attribute];
      if (!expected) { problems.push(`${where} has unsupported attribute ${attribute}`); continue; }
      const ok = expected === 'integer' ? Number.isInteger(value) && value >= 0 : typeof value === expected;
      if (!ok) problems.push(`${where}.${attribute} must be ${expected === 'integer' ? 'a non-negative integer' : `a ${expected}`}`);
    }
  };
  for (const [name, component] of Object.entries(json.components ?? {})) {
    for (const [field, member] of Object.entries(component.fields ?? {})) checkMember(`${name}.${field}`, member);
  }
  for (const [name, entity] of Object.entries(json.entities ?? {})) {
    if (!Array.isArray(entity.key) || entity.key.length === 0) problems.push(`entity ${name} needs a key`);
    for (const keyProperty of entity.key ?? []) if (!(keyProperty in (entity.properties ?? {}))) problems.push(`entity ${name} key ${keyProperty} is not a property`);
    for (const used of entity.use ?? []) if (!resolves(used, 'components')) problems.push(`entity ${name} uses unknown component ${used}`);
    for (const [property, member] of Object.entries(entity.properties ?? {})) checkMember(`${name}.${property}`, member);
  }
  return problems;
}

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
// `data` is public/data/chinook.json (rows keyed by table). Returns problems.
export function compareModelWithData(model, schema, data) {
  const problems = [];
  const entities = model.entities ?? {};
  const tables = new Map(schema.tables.map((table) => [table.name, table]));
  const sorted = (values) => [...values].sort();
  if (JSON.stringify(sorted(Object.keys(entities))) !== JSON.stringify(sorted(Object.keys(data)))) problems.push(`entities [${sorted(Object.keys(entities)).join(', ')}] differ from data tables [${sorted(Object.keys(data)).join(', ')}]`);
  for (const [name, entity] of Object.entries(entities)) {
    const table = tables.get(name);
    const rows = data[name];
    if (!table || !rows) { problems.push(`entity ${name} has no published table`); continue; }
    const columns = new Set(rows.flatMap((row) => Object.keys(row)));
    for (const column of table.columns) columns.add(column.name);
    const properties = Object.keys(entity.properties ?? {});
    for (const column of columns) if (!properties.includes(column)) problems.push(`${name}.${column} is in the data but not in the model`);
    for (const property of properties) if (!columns.has(property)) problems.push(`${name}.${property} is in the model but not in the data`);
    const primaryKey = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
    if (JSON.stringify(entity.key ?? []) !== JSON.stringify(primaryKey)) problems.push(`${name} key [${(entity.key ?? []).join(', ')}] differs from the primary key [${primaryKey.join(', ')}]`);
    for (const column of table.columns) {
      const member = entity.properties?.[column.name];
      if (!member) continue;
      const where = `${name}.${column.name}`;
      const foreignKey = table.foreignKeys.find((fk) => fk.column === column.name);
      if (foreignKey) {
        if (member.entity !== foreignKey.table) problems.push(`${where} references ${foreignKey.table} in the data but the model says ${member.entity ? `entity ${member.entity}` : `type ${member.type}`}`);
        const target = tables.get(foreignKey.table);
        const targetKey = target?.columns.filter((c) => c.primaryKey).map((c) => c.name) ?? [];
        if (JSON.stringify(targetKey) !== JSON.stringify([foreignKey.referencedColumn])) problems.push(`${where} references ${foreignKey.table}.${foreignKey.referencedColumn}, which is not that entity's whole key`);
      } else {
        if (member.entity) problems.push(`${where} is a reference to ${member.entity} in the model but has no foreign key in the data`);
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
        const type = member.entity ? 'int' : member.type;
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
