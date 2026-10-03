import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { verifyChecksums } from './lib/checksums.mjs';
import { checkMeaning, createResolver, indexConcepts, loadMeaningDir, parseConceptRef, parseModelRef, valueCoverageProblems } from './lib/meaning.mjs';
import { compareModelWithData, parseHcl, toModelspecJson, validateModel } from './lib/modelspec.mjs';
import { buildModelJson, chinookModule, modelChecksumsPath, modelDir } from './generate-model.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const schemaPath = join(root, 'model', 'meaning.schema.json');
const hcl = read('model/chinook.modelspec.hcl');
const model = toModelspecJson(parseHcl(hcl), chinookModule);
const schema = JSON.parse(read('src/data/schema.json'));
const data = JSON.parse(read('public/data/chinook.json'));
const meaningPath = 'model/chinook.meaning.yaml';
const meaning = parseYaml(read(meaningPath));
const resolve = createResolver({ root });
const chinook = (doc = meaning) => indexConcepts([{ path: join(root, meaningPath), doc }]);
const clone = (value) => structuredClone(value);
const check = (doc) => checkMeaning({ local: chinook(doc), resolve, schemaPath });

test('the ModelSpec JSON and the model checksums are generated from the current sources', async () => {
  assert.equal(read('model/chinook.modelspec.json'), await buildModelJson(), 'run pnpm generate');
  const checksums = JSON.parse(read(`model/${modelChecksumsPath}`));
  assert.deepEqual(await verifyChecksums(modelDir, checksums, modelChecksumsPath), [], 'run pnpm generate');
});

test('the model is structurally valid ModelSpec with all 11 Chinook entities', () => {
  assert.deepEqual(validateModel(model), []);
  assert.deepEqual(Object.keys(model.entities), ['Artist', 'Album', 'Track', 'Genre', 'MediaType', 'Playlist', 'PlaylistTrack', 'Customer', 'Employee', 'Invoice', 'InvoiceLine']);
  assert.equal(model.entities.Employee.properties.ReportsTo.entity, 'Employee', 'self-reference');
  assert.equal(model.entities.Customer.properties.SupportRepId.entity, 'Employee');
  assert.deepEqual(model.entities.PlaylistTrack.key, ['PlaylistId', 'TrackId'], 'many-to-many through PlaylistTrack');
  assert.equal(model.entities.PlaylistTrack.properties.TrackId.entity, 'Track');
});

test('the model matches the published data: tables, columns, keys, references, nullability, types and values', () => {
  assert.deepEqual(compareModelWithData(model, schema, data), []);
});

test('the model check fails when a column is renamed, a type or nullability changes, or a reference is lost', () => {
  const renamed = { ...data, Track: data.Track.map(({ Name, ...row }) => ({ ...row, Title: Name })) };
  const renamedSchema = clone(schema);
  renamedSchema.tables.find((t) => t.name === 'Track').columns.find((c) => c.name === 'Name').name = 'Title';
  const problems = compareModelWithData(model, renamedSchema, renamed);
  assert.ok(problems.includes('Track.Title is in the data but not in the model'), problems.join('\n'));
  assert.ok(problems.includes('Track.Name is in the model but not in the data'));

  const broken = clone(model);
  broken.entities.Invoice.properties.Total.type = 'int';
  broken.entities.Album.properties.Title.required = false;
  broken.entities.Album.properties.ArtistId = { type: 'int', required: true };
  const more = compareModelWithData(broken, schema, data);
  assert.ok(more.includes('Invoice.Total is int in the model, NUMERIC(10,2) (decimal) in the data'), more.join('\n'));
  assert.ok(more.includes('Album.Title is optional in the model but NOT NULL in the data'));
  assert.ok(more.includes('Album.ArtistId references Artist in the data but the model says type int'));

  const extraTable = clone(model);
  delete extraTable.entities.Genre;
  assert.match(compareModelWithData(extraTable, schema, data)[0], /differ from data tables/);
});

test('the HCL parser rejects syntax outside ModelSpec v0 instead of guessing', () => {
  assert.throws(() => parseHcl('entity "A" {\n  key = ["${x}"]\n}'), /interpolation/);
  assert.throws(() => parseHcl('entity "A" {\n  properties = { id = 1 }\n}'), /map-style/);
  assert.throws(() => parseHcl('entity "A" {\n  key = upper("id")\n}'), /not a literal|expected/);
  assert.throws(() => toModelspecJson(parseHcl('entity "A" {}\nentity "A" {}'), chinookModule), /duplicate entity/);
  const bad = toModelspecJson(parseHcl('entity "collections" {\n key = ["id"]\n property "id" {\n type = "integer"\n }\n property "o" {\n entity = "Nope"\n }\n}'), chinookModule);
  assert.deepEqual(validateModel(bad), ['collections is a reserved name', 'collections.id has unsupported type "integer"', 'collections.o references unknown entity Nope']);
});

test('the meaning file and the universal concepts validate against the schema and every reference resolves', () => {
  assert.deepEqual(check(meaning), []);
  assert.deepEqual(checkMeaning({ local: loadMeaningDir(join(root, 'model/vendor/meaninggraph-core')), resolve, schemaPath }), []);
  for (const concept of meaning.concepts) assert.ok(concept.bindings || concept.kind === 'external' || concept.measure?.inputs, `${concept.id} links to the model, is external, or is derived from concepts that do`);
});

test('every country spelling in the bound data columns names exactly one universal country', () => {
  assert.deepEqual(valueCoverageProblems({ local: chinook(), resolve, data }), []);
  assert.ok(data.Invoice.some((row) => row.BillingCountry === 'USA'), 'Chinook spells United States "USA"; the universal alias covers it');
});

test('the meaning check fails on a broken modelspec:// reference, an unknown concept, a schema error or mixed pins', () => {
  const typo = clone(meaning);
  typo.concepts.find((c) => c.id === 'invoice-total').bindings[0].property = 'Totl';
  assert.deepEqual(check(typo).map((p) => p.replace(/^.*?: concept/, 'concept')), ['concept invoice-total: modelspec:///chinook.Invoice: entity Invoice has no property Totl']);

  const entity = clone(meaning);
  entity.concepts.find((c) => c.id === 'artist').bindings[0].model = 'modelspec:///chinook.Artists';
  assert.match(check(entity).join('\n'), /module chinook has no entity Artists/);

  const module = clone(meaning);
  module.concepts.find((c) => c.id === 'artist').bindings[0].model = 'modelspec:///music.Artist';
  assert.match(check(module).join('\n'), /module music is not listed in models/);

  const unknown = clone(meaning);
  unknown.concepts.find((c) => c.id === 'customer').extends = 'meaning://github.com/meaninggraph/core/client';
  assert.match(check(unknown).join('\n'), /concept client does not exist in meaning:\/\/github.com\/meaninggraph\/core/);

  const local = clone(meaning);
  local.concepts.find((c) => c.id === 'music-sales').measure.inputs.push('invoice-totals');
  assert.match(check(local).join('\n'), /concept invoice-totals is not declared in this repository/);

  const schemaError = clone(meaning);
  delete schemaError.format;
  schemaError.concepts[0].kind = 'thing';
  const schemaProblems = check(schemaError).join('\n');
  assert.match(schemaProblems, /schema: \/ must have required property 'format'/);
  assert.match(schemaProblems, /schema: \/concepts\/0\/kind must be equal to one of the allowed values/);

  const pins = clone(meaning);
  pins.concepts.find((c) => c.id === 'customer').extends = 'meaning://github.com/meaninggraph/core/customer?ref=v1';
  assert.match(check(pins).join('\n'), /pinned to both/);

  const notEntity = clone(meaning);
  notEntity.concepts.find((c) => c.id === 'track-length').of = 'music-sales';
  assert.match(check(notEntity).join('\n'), /which is a measure, not an entity/);

  const cycle = clone(meaning);
  cycle.concepts.find((c) => c.id === 'invoice').extends = 'invoice-line';
  cycle.concepts.find((c) => c.id === 'invoice-line').extends = 'invoice';
  assert.match(check(cycle).join('\n'), /extends forms a cycle/);
});

test('a country spelling that no universal country knows fails the coverage check', () => {
  const renamed = { ...data, Invoice: data.Invoice.map((row) => (row.BillingCountry === 'USA' ? { ...row, BillingCountry: 'U.S.A.' } : row)) };
  assert.deepEqual(valueCoverageProblems({ local: chinook(), resolve, data: renamed }).map((p) => p.replace(/^.*?: concept/, 'concept')), ['concept billing-country: Invoice.BillingCountry value "U.S.A." matches no value']);
});

test('the reference grammar: bare ids are local, meaning:// names another repository, modelspec:// names an entity', () => {
  assert.deepEqual(parseConceptRef('country'), { id: 'country' });
  assert.deepEqual(parseConceptRef('meaning://github.com/meaninggraph/core/country?ref=abc123'), { repo: 'github.com/meaninggraph/core', id: 'country', ref: 'abc123' });
  assert.equal(parseConceptRef('meaning://country'), null);
  assert.deepEqual(parseModelRef('modelspec:///chinook.Invoice'), { repo: undefined, module: 'chinook', name: 'Invoice', ref: undefined });
  assert.deepEqual(parseModelRef('modelspec://github.com/datatug/chinookdb/chinook.Invoice?ref=main'), { repo: 'github.com/datatug/chinookdb', module: 'chinook', name: 'Invoice', ref: 'main' });
  assert.equal(parseModelRef('modelspec://chinook.Invoice'), null, 'legacy form without the third slash');
});

test('switching meaning://github.com/meaninggraph/core from the vendored copy to a git repository is one source entry', () => {
  const work = mkdtempSync(join(tmpdir(), 'meaning-core-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', work, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    for (const name of ['commerce', 'geo', 'identity', 'statistics']) writeFileSync(join(work, `${name}.meaning.yaml`), read(`model/vendor/meaninggraph-core/${name}.meaning.yaml`));
    git('add', '.');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'core');
    git('tag', 'v0');
    const sources = { 'github.com/meaninggraph/core': { git: `file://${work}` } };
    const pinned = JSON.parse(JSON.stringify(meaning).replaceAll('meaning://github.com/meaninggraph/core/population', 'meaning://github.com/meaninggraph/core/population?ref=v0'));
    assert.match(checkMeaning({ local: chinook(pinned), resolve: createResolver({ root, sources }), schemaPath }).join('\n'), /pinned to both/, 'every reference to one repository carries the same pin');
    const allPinned = JSON.parse(JSON.stringify(meaning).replace(/(meaning:\/\/github\.com\/meaninggraph\/core\/[a-z-]+)/g, '$1?ref=v0'));
    assert.deepEqual(checkMeaning({ local: chinook(allPinned), resolve: createResolver({ root, sources }), schemaPath }), []);
    assert.match(checkMeaning({ local: chinook(), resolve: createResolver({ root, sources }), schemaPath }).join('\n'), /needs a \?ref= pin/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('the facts the meaning file states hold in the data', () => {
  const lines = new Map();
  for (const line of data.InvoiceLine) lines.set(line.InvoiceId, (lines.get(line.InvoiceId) ?? 0) + line.UnitPrice * line.Quantity);
  for (const invoice of data.Invoice) assert.equal(Math.round(invoice.Total * 100), Math.round(lines.get(invoice.InvoiceId) * 100), `Invoice ${invoice.InvoiceId} total equals its lines`);
  const customers = new Map(data.Customer.map((c) => [c.CustomerId, c]));
  for (const invoice of data.Invoice) assert.equal(invoice.BillingCountry, customers.get(invoice.CustomerId).Country, `Invoice ${invoice.InvoiceId} is billed to the customer's country`);
  assert.equal(data.Invoice.length, 412);
  assert.equal(new Set(data.Invoice.map((i) => i.BillingCountry)).size, 24);
  assert.deepEqual([...new Set(data.InvoiceLine.map((l) => l.Quantity))], [1]);
  assert.deepEqual([...new Set(data.Track.map((t) => t.UnitPrice))].sort(), [0.99, 1.99]);
});

test('the concepts of the hero question have Russian labels, own or inherited', () => {
  const core = loadMeaningDir(join(root, 'model/vendor/meaninggraph-core'));
  const local = chinook();
  for (const id of ['music-sales', 'billing-country', 'population', 'music-sales-per-capita']) {
    const concept = local.concepts.get(id).concept;
    assert.ok(concept.labels.ru, `${id} has a Russian label`);
    const parent = core.concepts.get(parseConceptRef(concept.extends).id).concept;
    assert.ok(parent.labels.ru, `${concept.extends} has a Russian label`);
  }
  const perCapita = local.concepts.get('music-sales-per-capita').concept;
  assert.equal(perCapita.unit, 'USD per million people');
  assert.equal(perCapita.measure.scale, 1000000);
  assert.deepEqual(perCapita.measure.dimensions, ['billing-country']);
});
