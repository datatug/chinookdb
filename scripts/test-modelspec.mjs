// Tests for scripts/lib/modelspec.mjs: it reads both spellings of ModelSpec, the
// current one (record, field, record =; format 1.0-draft-2) and the earlier,
// deprecated one (entity, property, entity =; format 1.0-draft), says the same
// thing for both, and refuses what ModelSpec removed or reserved. The fixtures use
// invented names; when the repository has a model in model/, that model is read in
// both spellings too. CC0-1.0.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compareModelWithData, hclUsesEarlier, parseHcl, reservedNames, serializeModel, storageToModel, toModelspecJson, validateModel, vocabularies, vocabularyOf } from './lib/modelspec.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const moduleInfo = { id: 'example.test/shop/shop', name: 'shop', version: '0.1.0' };
const jsonOf = (hcl) => toModelspecJson(parseHcl(hcl), moduleInfo);
// What a program writes and reads back: plain objects, in the order they were written.
const plain = (json) => JSON.parse(serializeModel(json));

const earlierHcl = `# A small model.
enum "Status" {
  values = ["open", "closed"]
}

component "Audit" {
  field "createdAt" {
    type     = "datetime"
    required = true
  }
}

entity "Customer" {
  key = ["id"]
  use = ["Audit"]

  property "id" {
    type     = "int"
    required = true
  }

  property "name" {
    type    = "string"
    max_len = 20
  }
}

entity "Order" {
  key = ["id"]

  property "id" {
    type     = "int"
    required = true
  }

  property "customer" {
    entity   = "Customer"
    required = true
  }

  property "status" {
    type = "string"
    enum = "Status"
  }
}
`;
const toCurrentHcl = (hcl) => hcl
  .replace(/^(\s*)entity(\s+")/gm, '$1record$2')
  .replace(/^(\s*)property(\s+")/gm, '$1field$2')
  .replace(/^(\s*)entity(\s*=)/gm, '$1record$2');
// A component's members are `field` blocks in both spellings, so those are left alone.
const toEarlierHcl = (hcl) => {
  let inComponent = false;
  return hcl.split('\n').map((line) => {
    if (/^component\s+"/.test(line)) inComponent = true;
    else if (/^}/.test(line)) inComponent = false;
    const renamed = line.replace(/^(\s*)record(\s+")/, '$1entity$2').replace(/^(\s*)record(\s*=)/, '$1entity$2');
    return inComponent ? renamed : renamed.replace(/^(\s*)field(\s+")/, '$1property$2');
  }).join('\n');
};
const currentHcl = toCurrentHcl(earlierHcl);

// The same document in the other vocabulary, written out from the table of words and
// nothing else: an oracle for what the converter should say. A component's members
// are `fields` under both identifiers.
const mapValues = (object, change) => Object.fromEntries(Object.entries(object).map(([name, value]) => [name, change(value)]));
function translate(json, to) {
  const from = vocabularyOf(json);
  const target = vocabularies[to];
  const rename = (member) => Object.fromEntries(Object.entries(member).map(([name, value]) => [name === from.record ? target.record : name, value]));
  const out = {};
  for (const [kind, value] of Object.entries(json)) {
    if (kind === 'modelspec') out.modelspec = target.identifier;
    else if (kind === from.records) {
      out[target.records] = mapValues(value, (record) => ({
        ...(record.key ? { key: record.key } : {}),
        ...(record.use ? { use: record.use } : {}),
        [target.fields]: mapValues(record[from.fields], rename),
      }));
    } else if (kind === 'components') out.components = mapValues(value, (component) => ({ fields: mapValues(component.fields, rename) }));
    else out[kind] = value;
  }
  return out;
}

test('the two vocabularies are named in one table', () => {
  assert.deepEqual(vocabularies, {
    earlier: { identifier: '1.0-draft', record: 'entity', field: 'property', records: 'entities', fields: 'properties' },
    current: { identifier: '1.0-draft-2', record: 'record', field: 'field', records: 'records', fields: 'fields' },
  });
  assert.equal(vocabularyOf({ modelspec: '1.0-draft' }), vocabularies.earlier);
  assert.equal(vocabularyOf({ modelspec: '1.0-draft-2' }), vocabularies.current);
  assert.equal(vocabularyOf({ modelspec: '2.0' }), undefined);
  assert.equal(vocabularyOf({}), undefined);
  assert.equal(vocabularyOf(null), undefined);
});

test('a source in the earlier spelling converts to a 1.0-draft document, as it always did', () => {
  const json = jsonOf(earlierHcl);
  assert.deepEqual(Object.keys(json), ['modelspec', 'module', 'enums', 'components', 'entities']);
  assert.deepEqual(plain(json), {
    modelspec: '1.0-draft',
    module: moduleInfo,
    enums: { Status: { values: ['open', 'closed'] } },
    components: { Audit: { fields: { createdAt: { type: 'datetime', required: true } } } },
    entities: {
      Customer: { key: ['id'], use: ['Audit'], properties: { id: { type: 'int', required: true }, name: { type: 'string', max_len: 20 } } },
      Order: { key: ['id'], properties: { id: { type: 'int', required: true }, customer: { entity: 'Customer', required: true }, status: { type: 'string', enum: 'Status' } } },
    },
  });
  assert.deepEqual(validateModel(json), []);
  assert.equal(hclUsesEarlier(parseHcl(earlierHcl)), true);
});

test('a source in the current spelling converts to a 1.0-draft-2 document that says the same thing', () => {
  assert.notEqual(currentHcl, earlierHcl);
  const json = jsonOf(currentHcl);
  assert.deepEqual(Object.keys(json), ['modelspec', 'module', 'enums', 'components', 'records']);
  assert.equal(json.modelspec, '1.0-draft-2');
  assert.deepEqual(plain(json).records.Order.fields.customer, { record: 'Customer', required: true });
  assert.deepEqual(plain(json), translate(plain(jsonOf(earlierHcl)), 'current'));
  assert.deepEqual(validateModel(json), []);
  assert.equal(hclUsesEarlier(parseHcl(currentHcl)), false);
  assert.deepEqual(plain(jsonOf(toEarlierHcl(currentHcl))), plain(jsonOf(earlierHcl)), 'and back');
});

test('a source that mixes the spellings converts in the earlier vocabulary, as modelspec export does', () => {
  const mixed = `record "Customer" {
  key = ["id"]
  property "id" {
    type = "int"
  }
}

entity "Order" {
  key = ["id"]
  field "id" {
    type = "int"
  }
  field "customer" {
    entity = "Customer"
  }
  property "billTo" {
    record = "Customer"
  }
}
`;
  const json = jsonOf(mixed);
  assert.equal(json.modelspec, '1.0-draft');
  assert.deepEqual(plain(json).entities.Order.properties, { id: { type: 'int' }, customer: { entity: 'Customer' }, billTo: { entity: 'Customer' } });
  assert.deepEqual(validateModel(json), []);
  assert.equal(hclUsesEarlier(parseHcl(mixed)), true);
  // One word of the earlier spelling anywhere is enough, in a component too.
  const inComponent = 'component "C" {\n  field "x" {\n    entity = "A"\n  }\n}\nrecord "A" {\n  field "id" {\n    type = "int"\n  }\n}\n';
  assert.equal(jsonOf(inComponent).modelspec, '1.0-draft');
  assert.deepEqual(plain(jsonOf(inComponent)).components.C.fields.x, { entity: 'A' });
  // A property block in a record block is a word of the earlier spelling.
  assert.equal(jsonOf('record "A" {\n  property "id" {\n    type = "int"\n  }\n}\n').modelspec, '1.0-draft');
  assert.equal(jsonOf('component "C" {\n  field "x" {\n    type = "int"\n  }\n}\n').modelspec, '1.0-draft-2');
  // A field and a property of one name are one name twice; so are a record and an entity.
  assert.throws(() => jsonOf('record "A" {\n  field "id" {\n    type = "int"\n  }\n  property "id" {\n    type = "int"\n  }\n}\n'), /duplicate property "id" in record "A"/);
  assert.throws(() => jsonOf('record "A" {\n}\nentity "A" {\n}\n'), /duplicate entity "A"/);
});

test('a member that carries both reference words is refused, and so is a property in a component', () => {
  for (const [hcl, pattern] of [
    [currentHcl.replace('    record   = "Customer"', '    record   = "Customer"\n    entity   = "Customer"'), /line \d+: field "customer" has both entity and record; a member refers to one record type/],
    [earlierHcl.replace('    entity   = "Customer"', '    entity   = "Customer"\n    record   = "Customer"'), /line \d+: property "customer" has both entity and record; a member refers to one record type/],
    ['component "C" {\n  property "x" {\n    type = "int"\n  }\n}\n', /component "C" cannot contain a property block \(this converter supports field\)/],
    ['record "A" {\n  record = "B"\n}\n', /unsupported record attribute record/],
    ['entity "A" {\n  entity = "B"\n}\n', /unsupported entity attribute entity/],
    ['record "A" {\n  field "x" {\n    type = "int"\n    index "i" {\n    }\n  }\n}\n', /the index block is reserved by ModelSpec/],
  ]) assert.throws(() => jsonOf(hcl), pattern);
});

test('removed constructs and reserved words are refused in both spellings, at the top and inside a record type, and the message names the word', () => {
  const removed = ['collection', 'recordset', 'column'];
  for (const [spelling, hcl, member] of [['earlier', earlierHcl, 'property "name" {'], ['current', currentHcl, 'field "name" {']]) {
    for (const word of [...removed, 'projection', 'index', 'migration']) {
      const status = removed.includes(word) ? 'was removed from ModelSpec \\(decision 0019\\)' : 'is reserved by ModelSpec and has no content \\(decision 0019\\)';
      const pattern = new RegExp(`line \\d+: the ${word} block ${status}`);
      const top = `${hcl}\n${word} "x" {\n}\n`;
      const nested = hcl.replace(member, `${word} "x" {\n  }\n\n  ${member}`);
      assert.notEqual(nested, hcl);
      for (const source of [top, nested]) assert.throws(() => jsonOf(source), pattern, `${spelling} ${word}`);
    }
  }
  // Settings do not make it acceptable.
  assert.throws(() => jsonOf('collection "tasks" {\n  kind = "editable"\n}\n'), /the collection block was removed/);
  // In JSON the removed and reserved top-level fields are refused, under either identifier.
  for (const identifier of ['earlier', 'current']) {
    const base = plain(identifier === 'earlier' ? jsonOf(earlierHcl) : jsonOf(currentHcl));
    for (const [field, text] of [['collections', 'was removed from ModelSpec (decision 0019)'], ['recordsets', 'was removed from ModelSpec (decision 0019)'], ['projections', 'is reserved by ModelSpec and has no content (decision 0019); remove it'], ['migrations', 'is reserved by ModelSpec and has no content (decision 0019); remove it']]) {
      assert.deepEqual(validateModel({ ...base, [field]: {} }), [`the ${field} field ${text}`], `${identifier} ${field}`);
    }
    // `index` is reserved as a block only: the specification names no JSON field for it.
    assert.deepEqual(validateModel({ ...base, index: {} }), []);
  }
});

test('a name that a ModelSpec document reserves is refused in both vocabularies', () => {
  assert.deepEqual(reservedNames, ['records', 'entities', 'components', 'enums', 'collections', 'recordsets']);
  for (const { identifier, records, fields } of Object.values(vocabularies)) {
    for (const name of reservedNames) {
      const json = { modelspec: identifier, module: { id: 'a/b', name: 'b', version: '1' }, [records]: { [name]: { [fields]: {} } } };
      assert.deepEqual(validateModel(json), [`${name} is a reserved name`], `${identifier} ${name}`);
    }
  }
});

test('a JSON document is in the vocabulary its identifier names, and a key of the other one is an error', () => {
  const earlierJson = plain(jsonOf(earlierHcl));
  const currentJson = plain(jsonOf(currentHcl));
  assert.deepEqual(validateModel(earlierJson), []);
  assert.deepEqual(validateModel(currentJson), []);
  const cases = [
    [currentJson, (json) => { json.entities = json.records; delete json.records; }, /"entities" is a key of format 1\.0-draft; this document says "1\.0-draft-2", where it is "records"/],
    [currentJson, (json) => { json.records.Customer.properties = json.records.Customer.fields; }, /record Customer: "properties" is a key of format 1\.0-draft; .*where it is "fields"/],
    [currentJson, (json) => { json.records.Order.fields.customer.entity = 'Customer'; }, /Order\.customer: "entity" is a key of format 1\.0-draft; .*where it is "record"/],
    [currentJson, (json) => { json.components.Audit.fields.createdAt.entity = 'Customer'; }, /Audit\.createdAt: "entity" is a key of format 1\.0-draft/],
    [earlierJson, (json) => { json.records = json.entities; delete json.entities; }, /"records" is a key of format 1\.0-draft-2; this document says "1\.0-draft", where it is "entities"/],
    [earlierJson, (json) => { json.entities.Customer.fields = json.entities.Customer.properties; }, /entity Customer: "fields" is a key of format 1\.0-draft-2; .*where it is "properties"/],
    [earlierJson, (json) => { json.entities.Order.properties.customer.record = 'Customer'; }, /Order\.customer: "record" is a key of format 1\.0-draft-2; .*where it is "entity"/],
    [earlierJson, (json) => { json.components.Audit.fields.createdAt.record = 'Customer'; }, /Audit\.createdAt: "record" is a key of format 1\.0-draft-2/],
  ];
  for (const [base, change, pattern] of cases) {
    const json = structuredClone(base);
    change(json);
    assert.match(validateModel(json).join('\n'), pattern);
  }
  // The foreign key is reported once, not also as an unsupported attribute.
  const stray = structuredClone(currentJson);
  stray.records.Order.fields.customer.entity = 'Customer';
  assert.equal(validateModel(stray).filter((problem) => /unsupported attribute/.test(problem)).length, 0);
  // An identifier that is neither is refused, whatever else the document holds.
  for (const identifier of ['1.0-draft-3', '2.0', undefined, 1]) assert.match(validateModel({ ...earlierJson, modelspec: identifier }).join('\n'), /modelspec must be "1\.0-draft-2" \(or "1\.0-draft", the earlier spelling\)/);
  for (const notDocument of [null, [], 'text', 0]) assert.deepEqual(validateModel(notDocument), ['the JSON AST must be an object']);
});

test('the structural checks are the same in both vocabularies, in their own words', () => {
  const cases = [
    ['no module id', (json) => { delete json.module.id; }, () => /module\.id and module\.version are required/],
    ['module not an object', (json) => { json.module = 'x'; }, () => /module must be an object/],
    ['records not an object', (json, w) => { json[w.records] = []; }, (w) => new RegExp(`${w.records} must be an object keyed by name`)],
    ['no members', (json, w) => { delete json[w.records].Customer[w.fields]; }, (w) => new RegExp(`${w.records} Customer must be an object with ${w.fields}`)],
    ['member not an object', (json, w) => { json[w.records].Customer[w.fields].name = 'string'; }, () => /Customer\.name must be an object/],
    ['key not a list', (json, w) => { json[w.records].Customer.key = 'id'; }, (w) => new RegExp(`${w.record} Customer key must be a list of ${w.field} names`)],
    ['empty key', (json, w) => { json[w.records].Customer.key = []; }, (w) => new RegExp(`${w.record} Customer key must be a non-empty list when present`)],
    ['repeated key', (json, w) => { json[w.records].Customer.key = ['id', 'id']; }, (w) => new RegExp(`${w.record} Customer key id is duplicated`)],
    ['key names nothing', (json, w) => { json[w.records].Customer.key = ['nope']; }, (w) => new RegExp(`${w.record} Customer key nope is not a ${w.field}`)],
    ['use not a list', (json, w) => { json[w.records].Customer.use = 'Audit'; }, (w) => new RegExp(`${w.record} Customer use must be a list of component names`)],
    ['unknown component', (json, w) => { json[w.records].Customer.use = ['Nope']; }, (w) => new RegExp(`${w.record} Customer references unknown component Nope`)],
    ['unknown record', (json, w) => { json[w.records].Order[w.fields].customer[w.record] = 'Nope'; }, (w) => new RegExp(`Order\\.customer references unknown ${w.record} Nope`)],
    ['record of another module', (json, w) => { json[w.records].Order[w.fields].customer[w.record] = 'core.Customer'; }, (w) => new RegExp(`names ${w.record} core\\.Customer of another module`)],
    ['two kinds', (json, w) => { json[w.records].Order[w.fields].customer.type = 'int'; }, (w) => new RegExp(`Order\\.customer must have exactly one of type, ${w.record}, component`)],
    ['no kind', (json, w) => { delete json[w.records].Order[w.fields].customer[w.record]; }, (w) => new RegExp(`Order\\.customer must have exactly one of type, ${w.record}, component`)],
    ['unsupported type', (json, w) => { json[w.records].Customer[w.fields].name.type = 'integer'; }, () => /Customer\.name has unsupported type "integer"/],
    ['unsupported attribute', (json, w) => { json[w.records].Customer[w.fields].name.colour = 'red'; }, () => /Customer\.name has unsupported attribute colour/],
    ['wrong constraint type', (json, w) => { json[w.records].Customer[w.fields].name.max_len = '20'; }, () => /Customer\.name\.max_len must be a non-negative integer/],
    ['unknown enum', (json, w) => { json[w.records].Order[w.fields].status.enum = 'Nope'; }, () => /Order\.status references unknown enum Nope/],
    ['empty enum', (json) => { json.enums.Status.values = []; }, () => /enum Status needs a non-empty values list/],
    ['repeated enum value', (json) => { json.enums.Status.values = ['a', 'a']; }, () => /enum Status has duplicate values/],
    ['name with a dot', (json, w) => { json[w.records]['a.b'] = { [w.fields]: {} }; }, () => /a\.b: concept names cannot contain dots/],
    ['record and enum of one name', (json, w) => { json.enums.Customer = { values: ['x'] }; }, (w) => new RegExp(`Customer is declared as both ${w.records} and enums`)],
  ];
  for (const w of Object.values(vocabularies)) {
    const base = plain(jsonOf(w === vocabularies.earlier ? earlierHcl : currentHcl));
    assert.deepEqual(validateModel(base), []);
    for (const [name, change, pattern] of cases) {
      const json = structuredClone(base);
      change(json, w);
      assert.match(validateModel(json).join('\n'), pattern(w), `${w.identifier}: ${name}`);
    }
    // A key is optional: a record type without one makes no claim about identity.
    const keyless = structuredClone(base);
    delete keyless[w.records].Customer.key;
    assert.deepEqual(validateModel(keyless), [], `${w.identifier}: no key`);
  }
});

test('the HCL parser rejects syntax outside ModelSpec v0 instead of guessing', () => {
  for (const [source, pattern] of [
    ['record "A" {\n  key = ["${x}"]\n}', /string interpolation/],
    ['record "A" {\n  fields = { id = 1 }\n}', /map-style/],
    ['record "A" {\n  key = upper("id")\n}', /not a literal|expected/],
    ['record "A" {\n  key = [["id"]]\n}', /nested lists/],
    ['record "A" {\n  key = ["id"]\n  key = ["id"]\n}', /duplicate attribute key/],
    ['record "A" {\n  key = "id\n}', /unterminated string/],
    ['record "A" {\n  key = "\\q"\n}', /unsupported escape/],
    ['/* record "A" {\n}', /unterminated comment/],
    ['x = 1\n', /top-level attributes are not ModelSpec v0/],
    ['record "A" {\n  key = @\n}', /unexpected character/],
    ['record "A" {\n', /expected \}|end of file/],
  ]) assert.throws(() => parseHcl(source), pattern, source);
  const parsed = parseHcl('# note\n// note\n/* block\ncomment */ record "A" {\n  n = -1.5\n  ok = true\n  names = ["a", "b",]\n}\n');
  assert.deepEqual(parsed.blocks.map((block) => [block.type, block.name, block.line, { ...block.attributes }]), [['record', 'A', 4, { n: -1.5, ok: true, names: ['a', 'b'] }]]);
  assert.equal(parseHcl('record "A" {\n  note = "a\\n\\t\\"b\\\\"\n}').blocks[0].attributes.note, 'a\n\t"b\\', 'the escapes ModelSpec HCL allows');
  assert.throws(() => jsonOf('record "A" {\n  field "x" {\n    type = "int"\n    field "y" {\n    }\n  }\n}\n'), /field "x" cannot contain blocks/);
  assert.throws(() => jsonOf('enum "E" {\n  values = ["a"]\n  field "x" {\n  }\n}\n'), /enum "E" cannot contain blocks/);
  assert.throws(() => jsonOf('widget "W" {\n}\n'), /top-level widget blocks are not supported by this converter \(record, entity, component, enum\)/);
  assert.throws(() => jsonOf('record "A" {\n  field "x" {\n    type = "int"\n  }\n  widget "w" {\n  }\n}\n'), /record "A" cannot contain a widget block \(this converter supports field, property\)/);
});

test('names like constructor, toString and __proto__ are ordinary names', () => {
  const json = jsonOf('record "constructor" {\n  field "toString" {\n    type = "int"\n  }\n  field "__proto__" {\n    type = "int"\n  }\n}\n');
  assert.deepEqual(Object.keys(json.records), ['constructor']);
  assert.deepEqual(Object.keys(json.records.constructor.fields), ['toString', '__proto__']);
  assert.deepEqual(validateModel(json), []);
});

// ---- the comparison with the published data ----------------------------------------

const shopHcl = `entity "Customer" {
  key = ["id"]

  property "id" {
    type     = "int"
    required = true
  }

  property "name" {
    type    = "string"
    max_len = 20
    unique  = true
  }
}

entity "Order" {
  key = ["id"]

  property "id" {
    type     = "int"
    required = true
  }

  property "customer" {
    entity   = "Customer"
    required = true
  }

  property "placed" {
    type = "datetime"
  }
}
`;
const shopSchema = {
  tables: [
    { name: 'Customer', foreignKeys: [], columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'name', type: 'NVARCHAR(20)', nullable: true, primaryKey: false }] },
    { name: 'Order', foreignKeys: [{ column: 'customer', table: 'Customer', referencedColumn: 'id' }], columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, { name: 'customer', type: 'INTEGER', nullable: false, primaryKey: false }, { name: 'placed', type: 'DATETIME', nullable: true, primaryKey: false }] },
  ],
};
const shopData = { Customer: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }], Order: [{ id: 1, customer: 1, placed: '2021-01-01 00:00:00' }, { id: 2, customer: 2, placed: null }] };

test('the comparison with the published data gives the same verdict for both spellings, in the model\'s own words', () => {
  assert.deepEqual(storageToModel('NVARCHAR(40)'), { type: 'string', max_len: 40 });
  assert.deepEqual(storageToModel('NUMERIC(10,2)'), { type: 'decimal' });
  assert.deepEqual(storageToModel('BLOB'), { type: 'unmapped BLOB' });
  for (const [hcl, w] of [[shopHcl, vocabularies.earlier], [toCurrentHcl(shopHcl), vocabularies.current]]) {
    const model = plain(jsonOf(hcl));
    assert.deepEqual(compareModelWithData(model, shopSchema, shopData), [], w.identifier);

    const broken = structuredClone(model);
    broken[w.records].Order[w.fields].customer = { type: 'int', required: true };
    broken[w.records].Customer[w.fields].name.max_len = 30;
    delete broken[w.records].Order[w.fields].placed;
    broken[w.records].Customer[w.fields].extra = { type: 'string' };
    const problems = compareModelWithData(broken, shopSchema, shopData);
    for (const expected of [
      `Order.customer references Customer in the data but the model says type int`,
      `Customer.name max_len is 30, the data allows 20`,
      `Order.placed is in the data but not in the model`,
      `Customer.extra is in the model but not in the data`,
    ]) assert.ok(problems.includes(expected), `${w.identifier}: ${expected}\n${problems.join('\n')}`);

    const referenceInModel = structuredClone(model);
    referenceInModel[w.records].Customer[w.fields].name = { [w.record]: 'Order' };
    assert.ok(compareModelWithData(referenceInModel, shopSchema, shopData).includes(`Customer.name is a reference to Order in the model but has no foreign key in the data`), w.identifier);

    const wrongTarget = structuredClone(model);
    wrongTarget[w.records].Order[w.fields].customer[w.record] = 'Order';
    const wrong = compareModelWithData(wrongTarget, shopSchema, shopData);
    assert.ok(wrong.includes(`Order.customer references Customer in the data but the model says ${w.record} Order`), wrong.join('\n'));

    const missing = structuredClone(model);
    delete missing[w.records].Order;
    assert.match(compareModelWithData(missing, shopSchema, shopData)[0], new RegExp(`^${w.records} \\[Customer\\] differ from data tables \\[Customer, Order\\]`));
    const extra = structuredClone(model);
    extra[w.records].Shipment = { [w.fields]: {} };
    assert.ok(compareModelWithData(extra, shopSchema, { ...shopData, Shipment: [] }).includes(`${w.record} Shipment has no published table`), w.identifier);

    const badRows = compareModelWithData(model, shopSchema, { ...shopData, Customer: [{ id: 1, name: 'Ada' }, { id: 'x', name: 'Ada' }] });
    assert.ok(badRows.some((problem) => /Customer\.id row 1 value "x" is not a int/.test(problem)), badRows.join('\n'));
    assert.ok(badRows.some((problem) => /Customer\.name is unique but rows 0 and 1 both hold "Ada"/.test(problem)), badRows.join('\n'));
  }
});

// ---- the repository's own model -----------------------------------------------------

const modelDir = join(root, 'model');
const modelFiles = existsSync(modelDir) ? readdirSync(modelDir).filter((name) => name.endsWith('.modelspec.hcl')) : [];

test('the repository\'s own model reads the same in both spellings', { skip: modelFiles.length === 0 && 'this repository has no model/*.modelspec.hcl' }, () => {
  for (const name of modelFiles) {
    const hcl = readFileSync(join(modelDir, name), 'utf8');
    const committed = JSON.parse(readFileSync(join(modelDir, name.replace(/\.hcl$/, '.json')), 'utf8'));
    const asEarlier = plain(toModelspecJson(parseHcl(toEarlierHcl(hcl)), committed.module));
    const asCurrent = plain(toModelspecJson(parseHcl(toCurrentHcl(hcl)), committed.module));
    assert.equal(asEarlier.modelspec, '1.0-draft', name);
    assert.equal(asCurrent.modelspec, '1.0-draft-2', name);
    assert.deepEqual(validateModel(asEarlier), [], name);
    assert.deepEqual(validateModel(asCurrent), [], name);
    assert.deepEqual(asEarlier, translate(committed, 'earlier'), `${name}: the earlier spelling gives the committed JSON`);
    assert.deepEqual(asCurrent, translate(committed, 'current'), `${name}: the current spelling gives the same model`);
    assert.deepEqual(asCurrent, translate(asEarlier, 'current'), name);
  }
});
