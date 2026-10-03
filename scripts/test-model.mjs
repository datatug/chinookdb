import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { listDataFiles, listTrackedFiles, verifyChecksums } from './lib/checksums.mjs';
import { checkMeaning, createResolver, effectiveValues, indexConcepts, loadMeaningDir, matchValues, parseConceptRef, parseModelRef, valueCoverageProblems } from './lib/meaning.mjs';
import { compareModelWithData, parseHcl, toModelspecJson, validateModel } from './lib/modelspec.mjs';
import { buildModelJson, chinookModule, listModelFiles, modelChecksumsPath, modelDir } from './generate-model.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const schemaPath = join(root, 'model', 'vendor', 'meaninggraph-core', 'meaning.schema.json');
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
  assert.deepEqual(await verifyChecksums(modelDir, checksums, modelChecksumsPath, listModelFiles()), [], 'run pnpm generate');
});

test('only git-tracked files without a leading dot are published and checksummed', async () => {
  const work = mkdtempSync(join(tmpdir(), 'model-files-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', work, ...args], { stdio: 'pipe' });
    git('init', '-q');
    mkdirSync(join(work, 'model', '.cache'), { recursive: true });
    for (const name of ['a.yaml', '.DS_Store', '.cache/x.json', 'untracked.yaml']) writeFileSync(join(work, 'model', name), name);
    git('add', '-f', 'model/a.yaml', 'model/.DS_Store', 'model/.cache/x.json');
    assert.deepEqual(listTrackedFiles(work, 'model'), ['a.yaml'], 'a tracked dotfile, a dot-directory and an untracked file are left out');
    assert.deepEqual(await listDataFiles(join(work, 'model')), ['a.yaml', 'untracked.yaml'], 'the generated data listing skips dotfiles too');
  } finally { rmSync(work, { recursive: true, force: true }); }

  const probe = join(modelDir, '.probe-dotfile');
  writeFileSync(probe, 'not published');
  try {
    assert.ok(!listModelFiles().includes('.probe-dotfile'));
    const checksums = JSON.parse(read(`model/${modelChecksumsPath}`));
    assert.deepEqual(await verifyChecksums(modelDir, checksums, modelChecksumsPath, listModelFiles()), [], 'a stray dotfile in model/ changes nothing');
  } finally { rmSync(probe, { force: true }); }
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

test('every constraint the model states is checked against the rows: unique, pattern, min_len, enum, format', () => {
  const constrained = clone(model);
  const property = (entity, name) => constrained.entities[entity].properties[name];
  Object.assign(property('Artist', 'ArtistId'), { unique: true });
  Object.assign(property('Genre', 'Name'), { min_len: 1, pattern: '[A-Za-z0-9 &/\'-]+' });
  assert.deepEqual(compareModelWithData(constrained, schema, data), [], 'constraints that hold pass');

  Object.assign(property('Customer', 'Country'), { unique: true });
  Object.assign(property('Employee', 'Title'), { pattern: '[0-9]+' });
  Object.assign(property('Artist', 'Name'), { min_len: 200 });
  Object.assign(property('MediaType', 'Name'), { enum: ['MPEG audio file'] });
  Object.assign(property('Customer', 'Email'), { format: 'uri' });
  const problems = compareModelWithData(constrained, schema, data).join('\n');
  assert.match(problems, /Customer.Country is unique but rows \d+ and \d+ both hold "/);
  assert.match(problems, /Employee.Title row 0 value "General Manager" does not match pattern \[0-9\]\+/);
  assert.match(problems, /Artist.Name row 0 is shorter than 200/);
  assert.match(problems, /MediaType.Name row \d+ value "[^"]+" is not one of the enum values/);
  assert.match(problems, /Customer.Email format "uri" is not checked against the data \(checked: email\)/);
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
  for (const concept of meaning.concepts) assert.ok(concept.bindings || concept.source || concept.measure?.inputs, `${concept.id} links to the model, names its external source, or is derived from concepts that do`);
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
    for (const name of readdirSync(join(root, 'model/vendor/meaninggraph-core'))) writeFileSync(join(work, name), read(`model/vendor/meaninggraph-core/${name}`));
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
  const dates = data.Invoice.map((i) => i.InvoiceDate).sort();
  assert.deepEqual([dates[0], dates.at(-1)], ['2021-01-01 00:00:00', '2025-12-22 00:00:00'], 'invoices are dated from 2021-01-01 to 2025-12-22');
  assert.ok(dates.every((date) => date.endsWith(' 00:00:00')), 'the time part of InvoiceDate is always midnight');
  assert.match(meaning.concepts.find((c) => c.id === 'invoice').description, /412 invoices\s+dated from 2021-01-01 to 2025-12-22/);
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
    const reused = concept.extends ?? concept['values-of'];
    const parent = core.concepts.get(parseConceptRef(reused).id).concept;
    assert.ok(parent.labels.ru, `${reused} has a Russian label`);
  }
  const perCapita = local.concepts.get('music-sales-per-capita').concept;
  assert.equal(perCapita.unit, 'USD per million people');
  assert.equal(perCapita.measure.scale, 1000000);
  assert.deepEqual(perCapita.measure.dimensions, ['billing-country']);
});

const core = 'meaning://github.com/meaninggraph/core';
const mutate = (id, change) => {
  const doc = clone(meaning);
  change(doc.concepts.find((c) => c.id === id), doc);
  return check(doc).map((p) => p.replace(/^.*?: concept/, 'concept')).join('\n');
};

test('extends means "is a kind of" and joins compatible kinds only', () => {
  assert.match(mutate('customer', (c) => { c.extends = `${core}/revenue`; }), /concept customer: an entity cannot extend meaning:\/\/github.com\/meaninggraph\/core\/revenue, which is a measure; extends means "is a kind of", and an entity may extend only entity/);
  assert.match(mutate('music-sales', (c) => { c.extends = `${core}/invoice-total`; }), /a measure cannot extend .*invoice-total, which is an attribute/);
  // The draft's old double use: a dimension "extending" the entity whose instances it holds.
  assert.match(mutate('billing-country', (c) => { delete c['values-of']; c.extends = `${core}/country`; }), /a dimension cannot extend .*country, which is an entity; .* may extend only dimension or attribute/);
  assert.equal(mutate('invoice-date', (c) => { c.kind = 'attribute'; }), '', 'an attribute may extend an attribute');
});

test('values come from values-of only, and values-of and units-of name entities', () => {
  const local = chinook();
  const billing = local.concepts.get('billing-country').concept;
  assert.equal(effectiveValues(billing, local, resolve).length, 24, 'billing-country holds the universal countries');
  const { 'values-of': _, ...withoutValuesOf } = billing;
  assert.deepEqual(effectiveValues({ ...withoutValuesOf, extends: `${core}/date` }, local, resolve), [], 'extends passes no values');
  assert.match(mutate('billing-country', (c) => { c['values-of'] = 'music-sales'; }), /values-of names music-sales, which is a measure, not an entity/);
  assert.match(mutate('manager', (c) => { c['values-of'] = 'customer'; }), /concept manager: values-of customer is neither employee nor a kind of it, which .*\/manager requires/);
  assert.match(mutate('invoice-total', (c) => { c.unit = 'USDD'; }), /concept invoice-total: unit "USDD" must name exactly one value of currency \(units-of\), but names none/);
  assert.match(mutate('music-sales', (c) => { c.unit = 'dollars per track'; }), /unit "dollars per track" must name exactly one value of currency/, 'units-of is inherited through extends (revenue)');
  assert.equal(mutate('list-price', (c) => { c.unit = 'US dollar'; }), '', 'a label names the currency too');
});

test('measures are computed from attributes and measures, grouped by dimensions or attributes, and a ratio is never summed', () => {
  assert.match(mutate('music-sales', (c) => { c.measure.inputs.push('invoice'); }), /concept music-sales: measure.inputs names invoice, which is an entity; a measure is computed from attributes and measures only/);
  assert.match(mutate('music-sales', (c) => { c.measure.dimensions.push('invoice'); }), /measure.dimensions names invoice, which is an entity; a measure is grouped by dimensions or attributes only/);
  assert.match(mutate('music-sales-per-capita', (c) => { c.measure.aggregation = 'sum'; }), /concept music-sales-per-capita: aggregation sum on a ratio \(it is computed from the measure music-sales\)/);
  // A kind of a ratio is a ratio even without measure inputs of its own.
  assert.match(mutate('music-sales-per-capita', (c) => { c.measure.aggregation = 'average'; c.measure.inputs = []; }), /aggregation average on a ratio \(it is computed from the measure population\)/);
  assert.equal(mutate('music-sales-per-capita', (c) => { c.measure.aggregation = 'max'; }), '', 'the largest ratio is a fair question');
});

test('bindings carry a role, and the role must fit the model', () => {
  assert.match(mutate('artist', (c) => { c.bindings[1].property = 'Name'; }), /concept artist: Artist.Name has role identifier but is not in the key of Artist \[ArtistId\]/);
  assert.match(mutate('genre', (c) => { c.bindings[1] = { model: 'modelspec:///chinook.Track', property: 'GenreId', role: 'display-name' }; }), /Track.GenreId has role display-name but is a reference to Genre, not a string/);
  assert.match(mutate('genre', (c) => { c.bindings[2].role = 'value'; }), /concept genre: Track.GenreId has role value but is a reference to Genre; bind it with role foreign-key/);
  assert.match(mutate('genre', (c) => { c.bindings[2].property = 'MediaTypeId'; }), /concept genre: Track.MediaTypeId references MediaType, but the instances of genre are Genre rows/);
  assert.match(mutate('support-rep', (c) => { c['values-of'] = 'customer'; }), /concept support-rep: Customer.SupportRepId references Employee, but the instances of customer are Customer rows/);
  assert.match(mutate('support-rep', (c) => { delete c['values-of']; }), /Customer.SupportRepId has role foreign-key, so support-rep needs values-of/);
  assert.match(mutate('track-length', (c) => { c.bindings[0].role = 'foreign-key'; }), /Track.Milliseconds has role foreign-key but is not a reference \(it is an int\)/);
});

test('the schema rejects the draft forms that the split replaced', () => {
  assert.match(mutate('population', (c) => { c.kind = 'external'; }), /kind must be equal to one of the allowed values \(entity, attribute, measure, dimension\)/);
  assert.match(mutate('artist', (c) => { delete c.bindings[0].role; }), /bindings\/0 must have required property 'role'/);
  assert.match(mutate('artist', (c) => { c.bindings[0].property = 'Name'; }), /bindings\/0 must NOT be valid/, 'role entity takes no property');
  assert.match(mutate('artist', (c) => { c['values-of'] = 'genre'; }), /concepts\/0 must NOT be valid/, 'an entity has no values-of');
  assert.match(mutate('artist', (c) => { c.bindings[3].match = 'labels'; }), /bindings\/3 must NOT be valid/, 'match is for value and display-name bindings only');
  assert.match(mutate('artist', (c) => { delete c.description; }), /must have required property 'description'/);
  assert.match(mutate('artist', (c) => { c.id = '7artist'; }), /concepts\/0\/id must match pattern/, 'concept ids start with a letter');
  assert.match(mutate('artist', (c) => { c.id = 'artist-2'; }), /concepts\/0\/id must match pattern/, 'each word starts with a letter, so the camelCase field id is unambiguous');
});

test('a binding can match stored values by a code instead of by name', () => {
  const byCode = clone(meaning);
  byCode.concepts.find((c) => c.id === 'billing-country').bindings[0].match = 'codes.alpha2';
  const local = chinook(byCode);
  assert.match(valueCoverageProblems({ local, resolve, data }).join('\n'), /Invoice.BillingCountry value "USA" matches no value by codes.alpha2/);
  const countries = effectiveValues(local.concepts.get('billing-country').concept, local, resolve);
  const alpha2 = new Map(data.Invoice.map((row) => [row.BillingCountry, matchValues(countries, row.BillingCountry)[0].codes.alpha2]));
  const coded = { ...data, Invoice: data.Invoice.map((row) => ({ ...row, BillingCountry: alpha2.get(row.BillingCountry) })) };
  assert.deepEqual(valueCoverageProblems({ local, resolve, data: coded }), []);
});
