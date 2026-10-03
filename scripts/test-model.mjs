import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cleanGitEnv } from './lib/git-env.mjs';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { listDataFiles, listTrackedFiles, verifyChecksums } from './lib/checksums.mjs';
import { checkMeaning, checkoutGit, coreRepo, createResolver, effectiveValues, indexConcepts, loadMeaningDir, matchValues, parseConceptRef, parseModelRef, pinsOf, valueCoverageProblems } from './lib/meaning.mjs';
import { compareModelWithData, parseHcl, toModelspecJson, validateModel } from './lib/modelspec.mjs';
import { checkOvdbManifest, gitRepoFiles, parseFrontmatter, reportOvdbManifest } from './lib/ovdb-manifest.mjs';
import { buildModelJson, chinookModule, listModelFiles, modelChecksumsPath, modelDir } from './generate-model.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const hcl = read('model/chinook.modelspec.hcl');
const model = toModelspecJson(parseHcl(hcl), chinookModule);
const schema = JSON.parse(read('src/data/schema.json'));
const data = JSON.parse(read('public/data/chinook.json'));
const meaningPath = 'model/chinook.meaning.yaml';
const meaning = parseYaml(read(meaningPath));
const selfRepo = 'github.com/datatug/chinookdb';
// The universal concepts and the schema come from one checkout of meaninggraph/core at the
// commit that the meaning file's references pin; the resolver returns its directory.
const resolve = createResolver({ root });
after(() => resolve.dispose());
const [corePin] = pinsOf(meaning, coreRepo);
const coreIndex = resolve(coreRepo, corePin);
if (coreIndex.error) throw new Error(coreIndex.error);
const schemaPath = join(coreIndex.dir, 'meaning.schema.json');
const chinook = (doc = meaning) => indexConcepts([{ path: join(root, meaningPath), doc }]);
const clone = (value) => structuredClone(value);
const check = (doc) => checkMeaning({ local: chinook(doc), resolve, schemaPath, selfRepo });
const coreUrl = `meaning://${coreRepo}`;
const coreRef = (id, pin = corePin) => `${coreUrl}/${id}?ref=${pin}`;

// Where the network is not the point, a local git repository stands in for github.com.
// Every process this file starts gets an environment without GIT_* variables (git sets GIT_DIR and
// GIT_INDEX_FILE for a hook it runs from a linked worktree), and every git call names its repository with -C.
const exec = (command, args, options = {}) => execFileSync(command, args, { ...options, env: cleanGitEnv() });
const scratch = mkdtempSync(join(tmpdir(), 'model-meaning-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let scratchCount = 0;
const gitIn = (dir, ...args) => exec('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();
function localOrigin(files) {
  const dir = join(scratch, `origin-${scratchCount++}`);
  mkdirSync(dir);
  gitIn(dir, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  gitIn(dir, 'add', '.');
  gitIn(dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'files');
  return { dir, url: `file://${dir}`, sha: gitIn(dir, 'rev-parse', 'HEAD') };
}
const plainRun = (command, args) => exec(command, args, { stdio: 'pipe' }).toString();
// A resolver that reads the universal concepts' address from a local repository instead of github.com.
const localResolver = (url, repo = coreRepo) => createResolver({ root, sources: { [repo]: { git: url } }, cacheDir: join(scratch, `cache-${scratchCount++}`) });
const permanent = /(not our ref|couldn't find remote ref)/;

test('the ModelSpec JSON and the model checksums are generated from the current sources', async () => {
  assert.equal(read('model/chinook.modelspec.json'), await buildModelJson(), 'run pnpm generate');
  const checksums = JSON.parse(read(`model/${modelChecksumsPath}`));
  assert.deepEqual(await verifyChecksums(modelDir, checksums, modelChecksumsPath, listModelFiles()), [], 'run pnpm generate');
});

test('only git-tracked files without a leading dot are published and checksummed', async () => {
  const work = mkdtempSync(join(tmpdir(), 'model-files-'));
  try {
    const git = (...args) => exec('git', ['-C', work, ...args], { stdio: 'pipe' });
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
  assert.deepEqual(checkMeaning({ local: coreIndex, resolve, schemaPath, selfRepo: coreRepo }), [], 'the universal concepts at the pinned commit pass the same checks');
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
  unknown.concepts.find((c) => c.id === 'customer').extends = coreRef('client');
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

  // Mixed pins are reported before anything is fetched; the odd pin is read from a local repository, not github.com.
  const pins = clone(meaning);
  pins.concepts.find((c) => c.id === 'customer').extends = coreRef('customer', 'a'.repeat(40));
  const offline = localResolver(localOrigin({ 'a.meaning.yaml': 'format: meaning/draft-1\n' }).url);
  assert.match(checkMeaning({ local: chinook(pins), resolve: offline, schemaPath, selfRepo }).join('\n'), /pinned to both/);
  offline.dispose();

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

test('every concept reference to meaninggraph/core pins one full commit, and the schema comes from that checkout', () => {
  const pins = pinsOf(meaning, coreRepo);
  assert.equal(pins.length, 1, `one pin for the repository, got ${JSON.stringify(pins)}`);
  assert.match(pins[0], /^[0-9a-f]{40}$/, 'a pin is a full commit id, never a branch or tag');
  assert.equal(corePin, pins[0]);
  assert.ok(read('README.md').includes(`\`${corePin}\``), 'the README names the pinned commit in full, so a pin bump updates it too');
  assert.equal(schemaPath, join(coreIndex.dir, 'meaning.schema.json'));
  assert.ok(existsSync(schemaPath), 'the resolver returns the directory of the pinned checkout');
  assert.ok(coreIndex.concepts.has('country') && coreIndex.concepts.has('currency'));
  const unpinned = JSON.parse(JSON.stringify(meaning).replaceAll(`?ref=${corePin}`, ''));
  assert.match(check(unpinned).join('\n'), /read from git and needs a \?ref= pin/);
  assert.ok(!existsSync(join(root, 'model', 'vendor')), 'no vendored copy of the universal concepts');
});

test('the git source fails on a ?ref= that does not exist and on a concept id that is missing at the pin', () => {
  const nowhere = '0'.repeat(40);
  const origin = localOrigin({ 'a.meaning.yaml': 'format: meaning/draft-1\n' });
  const missingRef = clone(meaning);
  for (const concept of missingRef.concepts) if (concept.extends?.startsWith(coreUrl)) concept.extends = concept.extends.replace(corePin, nowhere);
  const offline = localResolver(origin.url);
  const problems = checkMeaning({ local: chinook(missingRef), resolve: offline, schemaPath, selfRepo }).join('\n');
  offline.dispose();
  // The message is the permanent failure of the repository, not a network error that merely looks like one.
  assert.match(problems, new RegExp(`meaning://${coreRepo}\\?ref=${nowhere} cannot be read: cannot fetch ${nowhere} from ${origin.url}: .*(not our ref|couldn't find remote ref)`));
  assert.match(problems, /pinned to both/, 'the mixed pin is reported too');

  const missingId = clone(meaning);
  missingId.concepts.find((c) => c.id === 'customer').extends = coreRef('no-such-concept');
  assert.match(check(missingId).join('\n'), /concept customer extends: concept no-such-concept does not exist in meaning:\/\/github.com\/meaninggraph\/core/);
});

test('checkoutGit caches an immutable commit by its id, retries a failed fetch and never leaves a clone behind', () => {
  const work = mkdtempSync(join(tmpdir(), 'meaning-git-'));
  try {
    const origin = join(work, 'origin');
    const git = (...args) => exec('git', ['-C', origin, ...args], { stdio: 'pipe' }).toString().trim();
    mkdirSync(origin);
    git('init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'a.meaning.yaml'), 'format: meaning/draft-1\n');
    git('add', '.');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'a');
    const sha = git('rev-parse', 'HEAD');
    const url = `file://${origin}`;
    const calls = [];
    const cacheDir = join(work, 'cache');
    const tempDir = join(work, 'tmp');
    mkdirSync(tempDir);
    const run = (command, args) => { calls.push(args.join(' ')); return exec(command, args, { stdio: 'pipe' }).toString(); };
    const fetches = () => calls.filter((call) => / fetch /.test(call)).length;

    const first = checkoutGit(url, sha, { cacheDir, run });
    assert.equal(first.dir, join(cacheDir, sha), 'cached under the commit id');
    assert.deepEqual(readdirSync(cacheDir), [sha], 'no temporary clone is left in the cache');
    assert.equal(fetches(), 1);
    assert.equal(checkoutGit(url, sha, { cacheDir, run }).dir, first.dir);
    assert.equal(fetches(), 1, 'the second call reads the cache and fetches nothing');

    writeFileSync(join(first.dir, 'stray.txt'), 'changed');
    writeFileSync(join(first.dir, 'a.meaning.yaml'), 'changed');
    checkoutGit(url, sha, { cacheDir, run });
    assert.equal(fetches(), 1, 'a cached checkout with local changes is made the commit again, without a fetch');
    assert.ok(!existsSync(join(first.dir, 'stray.txt')));
    assert.equal(readFileSync(join(first.dir, 'a.meaning.yaml'), 'utf8'), 'format: meaning/draft-1\n');

    // A failing fetch is retried; the third attempt succeeds.
    let failures = 2;
    const flaky = (command, args) => { if (args.includes('fetch') && failures-- > 0) throw Object.assign(new Error('network'), { stderr: Buffer.from('fatal: unable to access: Connection reset') }); return run(command, args); };
    const retried = checkoutGit(url, 'main', { tempDir, run: flaky, retryDelayMs: 1 });
    assert.ok(existsSync(join(retried.dir, 'a.meaning.yaml')));
    retried.release();
    assert.ok(!existsSync(retried.dir), 'a temporary clone is removed on release');

    // It stops after `retries` attempts and removes the clone it started.
    const always = (command, args) => { if (args.includes('fetch')) throw Object.assign(new Error('network'), { stderr: Buffer.from('fatal: unable to access: Connection reset') }); return run(command, args); };
    assert.throws(() => checkoutGit(url, 'main', { tempDir, run: always, retries: 2, retryDelayMs: 1 }), /cannot fetch main from .*Connection reset/);
    assert.deepEqual(readdirSync(tempDir), [], 'a failed checkout leaves no clone behind');
    // A ref that does not exist is not retried.
    calls.length = 0;
    assert.throws(() => checkoutGit(url, 'f'.repeat(40), { cacheDir, run, retryDelayMs: 1 }), (error) => /cannot fetch/.test(error.message) && permanent.test(error.message));
    assert.equal(fetches(), 1, 'a missing ref is permanent: one attempt');
    assert.deepEqual(readdirSync(cacheDir).filter((name) => name.startsWith('.')), [], 'and leaves no temporary clone in the cache');

    // A git source resolves like the real one: a pin is required and the concepts load.
    const sources = { 'example.com/org/core': { git: url } };
    const resolver = createResolver({ root, sources, cacheDir, run });
    assert.match(resolver('example.com/org/core').error, /needs a \?ref= pin/);
    assert.equal(resolver('example.com/org/core', sha).files.length, 1);
    assert.match(resolver('example.com/org/core', 'f'.repeat(40)).error, /cannot be read: cannot fetch .*(not our ref|couldn't find remote ref)/);
    resolver.dispose();
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('a cached checkout is made the pinned commit again before it is reused, or fetched anew', () => {
  const a = 'format: meaning/draft-1\nid: a\n';
  const b = 'format: meaning/draft-1\nid: b\n';
  const { url, sha } = localOrigin({ 'a.meaning.yaml': a, 'b.meaning.yaml': b });
  const own = (dir, ...args) => gitIn(dir, ...args);
  const scenarios = {
    'a modified tracked file': (k) => appendFileSync(join(k, 'a.meaning.yaml'), '# POISON\n'),
    'a modified file hidden by skip-worktree': (k) => { own(k, 'update-index', '--skip-worktree', 'a.meaning.yaml'); appendFileSync(join(k, 'a.meaning.yaml'), '# POISON\n'); },
    'a modified file hidden by assume-unchanged': (k) => { own(k, 'update-index', '--assume-unchanged', 'a.meaning.yaml'); appendFileSync(join(k, 'a.meaning.yaml'), '# POISON\n'); },
    'a meaning file hidden by .git/info/exclude': (k) => { appendFileSync(join(k, '.git', 'info', 'exclude'), 'evil.meaning.yaml\n'); writeFileSync(join(k, 'evil.meaning.yaml'), 'POISON\n'); },
    'a meaning file hidden by core.excludesFile': (k) => { writeFileSync(join(k, '.git', 'ignore-all'), '*.extra.meaning.yaml\n'); own(k, 'config', 'core.excludesFile', join(k, '.git', 'ignore-all')); writeFileSync(join(k, 'x.extra.meaning.yaml'), 'POISON\n'); },
    'a file removed from a sparse checkout': (k) => { own(k, 'config', 'core.sparseCheckout', 'true'); mkdirSync(join(k, '.git', 'info'), { recursive: true }); writeFileSync(join(k, '.git', 'info', 'sparse-checkout'), 'b.meaning.yaml\n'); own(k, 'read-tree', '-mu', 'HEAD'); },
    'a deleted file': (k) => rmSync(join(k, 'a.meaning.yaml')),
    'a missing .git (a partial restore)': (k) => rmSync(join(k, '.git'), { recursive: true, force: true }),
    'an empty directory': (k) => { rmSync(k, { recursive: true, force: true }); mkdirSync(k); },
  };
  for (const [name, poison] of Object.entries(scenarios)) {
    const cacheDir = join(scratch, `cache-${scratchCount++}`);
    const kept = checkoutGit(url, sha, { cacheDir, run: plainRun }).dir;
    poison(kept);
    const { dir } = checkoutGit(url, sha, { cacheDir, run: plainRun, retryDelayMs: 1 });
    assert.equal(dir, kept, name);
    assert.deepEqual(readdirSync(dir).filter((entry) => entry !== '.git').sort(), ['a.meaning.yaml', 'b.meaning.yaml'], `${name}: no foreign file stays`);
    assert.equal(readFileSync(join(dir, 'a.meaning.yaml'), 'utf8'), a, `${name}: a.meaning.yaml is the commit's`);
    assert.equal(readFileSync(join(dir, 'b.meaning.yaml'), 'utf8'), b, `${name}: b.meaning.yaml is the commit's`);
    assert.deepEqual(own(dir, 'ls-files', '-v').split('\n'), ['H a.meaning.yaml', 'H b.meaning.yaml'], `${name}: no hidden index flag`);
    assert.equal(own(dir, 'ls-files', '--others').trim(), '', `${name}: nothing untracked, whatever the exclude rules say`);
    assert.deepEqual(readdirSync(cacheDir), [sha], `${name}: no temporary clone is left`);
  }

  // A cache entry that is not a repository of its own is never reset or cleaned through the repository around it.
  const outer = join(scratch, `outer-${scratchCount++}`);
  mkdirSync(outer);
  gitIn(outer, 'init', '-q');
  writeFileSync(join(outer, 'precious.txt'), 'keep');
  const cacheDir = join(outer, '.cache');
  mkdirSync(join(cacheDir, sha), { recursive: true });
  writeFileSync(join(cacheDir, sha, 'junk.txt'), 'junk');
  checkoutGit(url, sha, { cacheDir, run: plainRun });
  assert.equal(readFileSync(join(outer, 'precious.txt'), 'utf8'), 'keep', 'the untracked file of the enclosing repository survives');
  assert.ok(existsSync(join(cacheDir, sha, 'a.meaning.yaml')) && !existsSync(join(cacheDir, sha, 'junk.txt')));
});

test('two processes filling one cache entry both get the verified directory', () => {
  const { url, sha } = localOrigin({ 'a.meaning.yaml': 'format: meaning/draft-1\n' });
  const cacheDir = join(scratch, `cache-${scratchCount++}`);
  const kept = join(cacheDir, sha);
  // The other process finishes its checkout, and fills the entry, while this one is between checkout and rename.
  let raced = false;
  const run = (command, args) => {
    const out = plainRun(command, args);
    if (args.includes('checkout') && !raced) {
      raced = true;
      const work = args[1];
      exec('git', ['clone', '-q', work, kept], { stdio: 'pipe' });
    }
    return out;
  };
  const { dir } = checkoutGit(url, sha, { cacheDir, run });
  assert.ok(raced);
  assert.equal(dir, kept);
  assert.equal(readFileSync(join(dir, 'a.meaning.yaml'), 'utf8'), 'format: meaning/draft-1\n');
  assert.equal(gitIn(dir, 'rev-parse', 'HEAD'), sha);
  assert.deepEqual(readdirSync(cacheDir), [sha], 'the loser removes its own clone');

  // Were the winner's directory not the commit, the loser reports it rather than adopt it.
  const cacheDir2 = join(scratch, `cache-${scratchCount++}`);
  const kept2 = join(cacheDir2, sha);
  let raced2 = false;
  const run2 = (command, args) => {
    const out = plainRun(command, args);
    if (args.includes('checkout') && !raced2) { raced2 = true; mkdirSync(kept2, { recursive: true }); writeFileSync(join(kept2, 'bogus.txt'), 'x'); }
    return out;
  };
  assert.throws(() => checkoutGit(url, sha, { cacheDir: cacheDir2, run: run2 }), /ENOTEMPTY|EEXIST/);
  assert.deepEqual(readdirSync(cacheDir2).filter((name) => name.startsWith('.')), [], 'and leaves no temporary clone');
});

// The suite runs in parallel on a developer's machine and CI shards share a cache: several processes fill and read
// one entry at the same time. ENOTEMPTY used to escape when the losers of the rename verified the winner's directory
// while all of them held git's index lock, or when one process removed an entry another was filling.
test('processes that fill, read and repair one cache entry at the same time all get the verified directory', async () => {
  const { url, sha } = localOrigin(Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`f${index}.meaning.yaml`, `format: meaning/draft-1\nid: x${index}\n`])));
  const cacheDir = join(scratch, `cache-${scratchCount++}`);
  const kept = join(cacheDir, sha);
  const loader = `import { checkoutGit } from ${JSON.stringify(pathToFileURL(join(root, 'scripts', 'lib', 'meaning.mjs')).href)};
const [url, sha, cacheDir] = process.argv.slice(1);
process.stdout.write(checkoutGit(url, sha, { cacheDir }).dir);`;
  const together = (count) => Promise.all(Array.from({ length: count }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', loader, url, sha, cacheDir], { env: cleanGitEnv(), stdio: 'pipe' });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ code, out, err }));
  })));
  const allGot = (results, what) => {
    for (const { code, out, err } of results) {
      assert.equal(code, 0, `${what}: ${err.split('\n').filter((line) => /Error|ENOTEMPTY|EEXIST/.test(line)).join(' | ')}`);
      assert.equal(out, kept, what);
    }
    assert.deepEqual(readdirSync(cacheDir), [sha], `${what}: no temporary or discarded directory is left`);
    assert.equal(gitIn(kept, 'status', '--porcelain'), '', `${what}: the entry is the commit`);
    assert.equal(readdirSync(kept).filter((name) => name.endsWith('.meaning.yaml')).length, 150, `${what}: every file is there`);
  };
  allGot(await together(8), 'a cold cache, eight processes');
  allGot(await together(8), 'a warm cache, eight processes');
  writeFileSync(join(kept, 'f1.meaning.yaml'), 'POISON\n');
  writeFileSync(join(kept, 'stray.meaning.yaml'), 'POISON\n');
  allGot(await together(8), 'a poisoned entry, eight processes');
  assert.equal(readFileSync(join(kept, 'f1.meaning.yaml'), 'utf8'), 'format: meaning/draft-1\nid: x1\n');
  assert.ok(!existsSync(join(kept, 'stray.meaning.yaml')));
});

test('an entry that is already the commit is only read, and a lock another process holds is waited out, not condemned', () => {
  const { url, sha } = localOrigin({ 'a.meaning.yaml': 'format: meaning/draft-1\n' });
  const cacheDir = join(scratch, `cache-${scratchCount++}`);
  const kept = join(cacheDir, sha);
  const calls = [];
  const run = (command, args) => { calls.push(args); return plainRun(command, args); };
  checkoutGit(url, sha, { cacheDir, run });
  writeFileSync(join(kept, '.git', 'marker'), 'the entry is not replaced');
  calls.length = 0;
  assert.equal(checkoutGit(url, sha, { cacheDir, run }).dir, kept);
  assert.ok(calls.length > 0);
  assert.deepEqual(calls.filter((args) => args.some((arg) => ['read-tree', 'checkout-index', 'clean', 'fetch', 'init'].includes(arg))), [], 'nothing is written to an entry that is already the commit');
  assert.ok(calls.filter((args) => args.includes('status')).every((args) => args.includes('--no-optional-locks')), 'and the status check takes no optional lock');
  // git fails once on the index lock another process holds: the entry is looked at again, not thrown away.
  let locks = 0;
  const busy = (command, args) => {
    if (args.includes('status') && args.some((arg) => arg.startsWith(kept)) && locks < 1) { locks += 1; throw Object.assign(new Error('git failed'), { stderr: Buffer.from(`fatal: Unable to create '${kept}/.git/index.lock': File exists.`) }); }
    return run(command, args);
  };
  calls.length = 0;
  assert.equal(checkoutGit(url, sha, { cacheDir, run: busy }).dir, kept);
  assert.equal(locks, 1, 'the lock was met');
  assert.equal(readFileSync(join(kept, '.git', 'marker'), 'utf8'), 'the entry is not replaced', 'the same entry, not a fresh checkout');
  assert.deepEqual(calls.filter((args) => args.includes('fetch')), [], 'and nothing was fetched');
  // The same for a loser of the rename, which has to verify the winner's directory while it is busy.
  const cacheDir2 = join(scratch, `cache-${scratchCount++}`);
  const kept2 = join(cacheDir2, sha);
  let raced = false;
  let lockFailures = 0;
  const racing = (command, args) => {
    if (args.includes('status') && args.some((arg) => arg.startsWith(kept2)) && lockFailures < 2) { lockFailures += 1; throw Object.assign(new Error('git failed'), { stderr: Buffer.from('fatal: Unable to create index.lock') }); }
    const out = plainRun(command, args);
    if (args.includes('checkout') && !raced) { raced = true; exec('git', ['clone', '-q', args[1], kept2], { stdio: 'pipe' }); }
    return out;
  };
  const { dir } = checkoutGit(url, sha, { cacheDir: cacheDir2, run: racing });
  assert.ok(raced);
  assert.equal(dir, kept2);
  assert.equal(lockFailures, 2, 'the lock was met twice, and waited out');
  assert.deepEqual(readdirSync(cacheDir2), [sha]);
  // An entry that stays unreadable is condemned, and the replacement is fetched anew.
  const cacheDir3 = join(scratch, `cache-${scratchCount++}`);
  checkoutGit(url, sha, { cacheDir: cacheDir3, run: plainRun });
  const kept3 = join(cacheDir3, sha);
  writeFileSync(join(kept3, '.git', 'marker'), 'the old entry');
  writeFileSync(join(kept3, '.git', 'HEAD'), 'ref: refs/heads/nowhere\n');
  assert.equal(checkoutGit(url, sha, { cacheDir: cacheDir3, run: plainRun }).dir, kept3);
  assert.ok(!existsSync(join(kept3, '.git', 'marker')), 'the old entry was replaced');
  assert.deepEqual(readdirSync(cacheDir3), [sha], 'and the discarded one is gone');
});

// A repository that writes its own concepts with its own address, the way core's FORMAT.md allows.
const tinyRepo = 'example.com/org/tiny';
const tinyConcept = (id, kind, rest = {}) => ({ id, kind, labels: { en: id }, description: id, ...rest });
const tinyDoc = (selfRef) => ({
  format: 'meaning/draft-1', id: 'tiny', name: 'Tiny', description: 'A tiny repository.', license: 'CC0-1.0',
  concepts: [
    tinyConcept('currency', 'entity', { values: [{ id: 'usd', labels: { en: 'US dollar' }, aliases: { en: ['USD'] } }] }),
    tinyConcept('country', 'entity'),
    tinyConcept('money-amount', 'attribute', { 'units-of': 'currency' }),
    tinyConcept('price', 'attribute', { extends: selfRef('money-amount') }),
    tinyConcept('headcount', 'measure', { measure: { formula: 'count', aggregation: 'sum' } }),
    tinyConcept('per-capita', 'measure', { measure: { formula: 'x / y', inputs: ['headcount'] } }),
    tinyConcept('per-capita-two', 'measure', { extends: selfRef('per-capita'), measure: { formula: 'x' } }),
    tinyConcept('loop-a', 'attribute', { extends: selfRef('loop-b') }),
    tinyConcept('loop-b', 'attribute', { extends: selfRef('loop-a') }),
  ],
});

test('a repository\'s own address inside it is the same as a bare id: inheritance follows it', () => {
  const consumerChecks = (selfRef) => {
    const origin = localOrigin({ 'tiny.meaning.yaml': stringifyYaml(tinyDoc(selfRef)) });
    const resolver = localResolver(origin.url, tinyRepo);
    const r = (id) => `meaning://${tinyRepo}/${id}?ref=${origin.sha}`;
    const consumer = (concepts) => ({ format: 'meaning/draft-1', id: 'consumer', name: 'Consumer', description: 'c', license: 'CC0-1.0', concepts: concepts.map((c) => tinyConcept(c.id, c.kind, c.rest)) });
    const problemsOf = (...concepts) => checkMeaning({ local: indexConcepts([{ path: 'consumer.meaning.yaml', doc: consumer(concepts) }]), resolve: resolver, schemaPath, selfRepo: 'example.com/me/consumer' }).map((p) => p.replace(/^.*?: concept/, 'concept').replaceAll(origin.sha, '<pin>'));
    try {
      return {
        good: problemsOf({ id: 'list-price', kind: 'attribute', rest: { extends: r('price'), unit: 'USD' } }),
        summed: problemsOf({ id: 'summed-ratio', kind: 'measure', rest: { extends: r('per-capita-two'), measure: { formula: 'x', aggregation: 'sum' } } }),
        wrongUnits: problemsOf({ id: 'wrong-units', kind: 'attribute', rest: { extends: r('price'), 'units-of': r('country') } }),
        badUnit: problemsOf({ id: 'bad-unit', kind: 'attribute', rest: { extends: r('price'), unit: 'ZZZ' } }),
        cycle: problemsOf({ id: 'looping', kind: 'attribute', rest: { extends: r('loop-a') } }),
      };
    } finally { resolver.dispose(); }
  };
  const bare = consumerChecks((id) => id);
  const viaAddress = consumerChecks((id) => `meaning://${tinyRepo}/${id}`);
  assert.deepEqual(bare.good, []);
  assert.deepEqual(viaAddress, bare, 'every check gives the same answer whether the repository writes bare ids or its own address');
  assert.match(viaAddress.summed.join('\n'), /concept summed-ratio: aggregation sum on a ratio \(it is computed from the measure headcount\)/);
  assert.match(viaAddress.wrongUnits.join('\n'), /concept wrong-units: units-of .*country.* is neither currency nor a kind of it/);
  assert.match(viaAddress.badUnit.join('\n'), /concept bad-unit: unit "ZZZ" must name exactly one value of currency \(units-of\), but names none/);
  assert.match(viaAddress.cycle.join('\n'), /concept looping: extends forms a cycle \(looping -> loop-a -> loop-b -> loop-a\)/);
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
  const local = chinook();
  for (const id of ['music-sales', 'billing-country', 'population', 'music-sales-per-capita']) {
    const concept = local.concepts.get(id).concept;
    assert.ok(concept.labels.ru, `${id} has a Russian label`);
    const reused = concept.extends ?? concept['values-of'];
    const parent = coreIndex.concepts.get(parseConceptRef(reused).id).concept;
    assert.ok(parent.labels.ru, `${reused} has a Russian label`);
  }
  const perCapita = local.concepts.get('music-sales-per-capita').concept;
  assert.equal(perCapita.unit, 'USD per million people');
  assert.equal(perCapita.measure.scale, 1000000);
  assert.deepEqual(perCapita.measure.dimensions, ['billing-country']);
});

const mutate = (id, change) => {
  const doc = clone(meaning);
  change(doc.concepts.find((c) => c.id === id), doc);
  return check(doc).map((p) => p.replace(/^.*?: concept/, 'concept')).join('\n');
};

test('extends means "is a kind of" and joins compatible kinds only', () => {
  assert.match(mutate('customer', (c) => { c.extends = coreRef('revenue'); }), /concept customer: an entity cannot extend meaning:\/\/github.com\/meaninggraph\/core\/revenue\?ref=[0-9a-f]{40}, which is a measure; extends means "is a kind of", and an entity may extend only entity/);
  assert.match(mutate('music-sales', (c) => { c.extends = coreRef('invoice-total'); }), /a measure cannot extend .*invoice-total.*, which is an attribute/);
  // The draft's old double use: a dimension "extending" the entity whose instances it holds.
  assert.match(mutate('billing-country', (c) => { delete c['values-of']; c.extends = coreRef('country'); }), /a dimension cannot extend .*country.*, which is an entity; .* may extend only dimension or attribute/);
  assert.equal(mutate('invoice-date', (c) => { c.kind = 'attribute'; }), '', 'an attribute may extend an attribute');
});

test('values come from values-of only, and values-of and units-of name entities', () => {
  const local = chinook();
  const billing = local.concepts.get('billing-country').concept;
  assert.equal(effectiveValues(billing, local, resolve).length, 24, 'billing-country holds the universal countries');
  const { 'values-of': _, ...withoutValuesOf } = billing;
  assert.deepEqual(effectiveValues({ ...withoutValuesOf, extends: coreRef('date') }, local, resolve), [], 'extends passes no values');
  assert.match(mutate('billing-country', (c) => { c['values-of'] = 'music-sales'; }), /values-of names music-sales, which is a measure, not an entity/);
  assert.match(mutate('manager', (c) => { c['values-of'] = 'customer'; }), /concept manager: values-of customer is neither employee nor a kind of it, which .*\/manager.* requires/);
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
  // aggregation is inherited through extends like unit: a ratio that extends a measure which sums sums, unless it says none.
  const derived = (aggregation) => mutate('music-sales', (c, doc) => {
    doc.concepts.push({ id: 'summing-measure', kind: 'measure', labels: { en: 'Summing measure' }, description: 'A measure that adds up.', measure: { formula: 'x', aggregation: 'sum' } });
    doc.concepts.push({ id: 'derived-ratio', kind: 'measure', extends: 'summing-measure', labels: { en: 'Derived ratio' }, description: 'A ratio of a kind of the summing measure.', measure: { formula: 'x / y', inputs: ['music-sales'], ...(aggregation && { aggregation }) } });
    doc.concepts.push({ id: 'derived-total', kind: 'measure', extends: 'summing-measure', labels: { en: 'Derived total' }, description: 'A kind of the summing measure, no ratio.', measure: { formula: 'x + y' } });
  });
  assert.equal(derived(undefined), 'concept derived-ratio: aggregation sum on a ratio (it is computed from the measure music-sales); a ratio is recomputed per group from its inputs, so its aggregation is none; sum is inherited from summing-measure, state aggregation: none');
  assert.equal(derived('none'), '', 'saying none overrides the inherited sum, and a kind of a summing measure that is no ratio may sum');
});

test('a word names one value of a concept whatever the language', () => {
  const values = (...list) => ({ format: 'meaning/draft-1', id: 'v', concepts: [{ id: 'colour', kind: 'entity', labels: { en: 'Colour' }, description: 'd', values: list }] });
  const problemsOf = (doc) => checkMeaning({ local: indexConcepts([{ path: 'v.meaning.yaml', doc }]), resolve, models: {}, selfRepo }).map((p) => p.replace(/^.*?: concept/, 'concept'));
  const red = { id: 'red', labels: { en: 'Red', ru: 'Красный' } };
  assert.deepEqual(problemsOf(values(red, { id: 'rose', labels: { en: 'Rose' }, aliases: { en: ['Pink'] } })), []);
  assert.deepEqual(problemsOf(values(red, { id: 'rouge', labels: { fr: 'Rouge' }, aliases: { ru: ['красный'] } })), ['concept colour: "красный" names both red and rouge'], 'the same word in another language, ignoring case');
  assert.deepEqual(problemsOf(values(red, { id: 'rouge', labels: { fr: 'Rouge' }, aliases: { fr: ['RED'] } })), ['concept colour: "RED" names both red and rouge']);
  assert.deepEqual(problemsOf(values({ id: 'red', labels: { en: 'Red', ru: 'Red' }, aliases: { en: ['red'] } })), [], 'one value may repeat its own word');
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

test('identifier and display-name sit on the concept\'s own entity, a concept binds one entity, and a foreign key needs its target\'s entity binding', () => {
  const albumBinding = (role, property) => ({ model: 'modelspec:///chinook.Album', property, role });
  assert.match(mutate('artist', (c) => { c.bindings[1] = albumBinding('identifier', 'AlbumId'); }), /concept artist: Album.AlbumId has role identifier, but artist is bound to the entity Artist; the property must be on that entity/);
  assert.match(mutate('artist', (c) => { c.bindings[2] = albumBinding('display-name', 'Title'); }), /concept artist: Album.Title has role display-name, but artist is bound to the entity Artist; the property must be on that entity/);
  assert.match(mutate('artist', (c) => { c.bindings.push({ model: 'modelspec:///chinook.Album', role: 'entity' }); }), /concept artist: has 2 entity bindings \(chinook.Artist, chinook.Album\); a concept binds one entity/);
  const noEntity = mutate('artist', (c) => { c.bindings.splice(0, 1); });
  assert.match(noEntity, /Artist.ArtistId has role identifier, but artist has no entity binding, so it cannot be checked which entity the property must sit on/);
  assert.match(noEntity, /Artist.Name has role display-name, but artist has no entity binding/);
  assert.match(noEntity, /Album.ArtistId has role foreign-key, but artist has no entity binding in this repository, so it cannot be checked that Artist holds its instances/);
  const noTarget = mutate('employee', (c) => { delete c.bindings; });
  assert.match(noTarget, /concept manager: Employee.ReportsTo has role foreign-key, but employee has no entity binding in this repository, so it cannot be checked that Employee holds its instances/);
  assert.match(noTarget, /concept support-rep: Customer.SupportRepId has role foreign-key, but employee has no entity binding/);
  assert.equal(mutate('artist', () => {}), '', 'the unchanged concept passes');
});

test('music-sales binds only the measure\'s own column; the price and quantity it is computed from are inputs', () => {
  const sales = meaning.concepts.find((c) => c.id === 'music-sales');
  assert.deepEqual(sales.bindings.map((b) => `${parseModelRef(b.model).name}.${b.property} ${b.role}`), ['Invoice.Total value']);
  assert.deepEqual(sales.measure.inputs, ['invoice-total', 'unit-price', 'quantity']);
});

test('an extends cycle is reported through a meaning:// reference to the repository itself, and a self-reference cannot be pinned', () => {
  const self = (id) => `meaning://${selfRepo}/${id}`;
  const direct = mutate('invoice', (c) => { c.extends = self('invoice'); });
  assert.match(direct, /concept invoice: extends forms a cycle \(invoice -> invoice\)/);
  const cycle = clone(meaning);
  cycle.concepts.find((c) => c.id === 'invoice').extends = self('invoice-line');
  cycle.concepts.find((c) => c.id === 'invoice-line').extends = self('invoice');
  const problems = check(cycle).join('\n');
  assert.match(problems, /concept invoice: extends forms a cycle \(invoice -> invoice-line -> invoice\)/);
  assert.match(problems, /concept invoice-line: extends forms a cycle \(invoice-line -> invoice -> invoice-line\)/);
  assert.match(mutate('invoice', (c) => { c.extends = `${self('invoice')}?ref=${corePin}`; }), /cannot carry \?ref=/);
  // A self-reference to an existing concept of another kind is checked like a bare id.
  assert.match(mutate('customer', (c) => { c.extends = self('music-sales'); }), /an entity cannot extend .*music-sales, which is a measure/);
  assert.equal(mutate('manager', (c) => { c['values-of'] = self('employee'); }), '', 'a self-reference resolves to the concept of this repository');
});

test('a child\'s units-of may narrow its parent\'s, never change it', () => {
  assert.match(mutate('invoice-total', (c) => { c['units-of'] = coreRef('country'); }), /concept invoice-total: units-of .*country.* is neither currency nor a kind of it, which .*invoice-total.* requires/);
  assert.equal(mutate('invoice-total', (c) => { c['units-of'] = coreRef('currency'); }), '', 'the same entity is fine');
  assert.equal(mutate('invoice-total', (c) => { delete c['units-of']; }), '', 'inheriting it is fine');
});

test('licences are stated where files are published: the HCL, the meaning file, /about/ and the README', () => {
  assert.match(hcl, /^# Licence: MIT \(https:\/\/github.com\/datatug\/chinookdb\/blob\/main\/LICENSE\)\./);
  assert.match(hcl.split('\n').slice(0, 4).join('\n'), /Luis Rocha.*MIT/s, 'the upstream notice sits at the top of the HCL too');
  assert.equal(meaning.license, 'CC0-1.0');
  const about = read('src/pages/about/index.astro');
  for (const text of ['MIT', 'CC0-1.0', 'meaning file', 'model/chinook.modelspec.hcl']) assert.ok(about.includes(text), `/about/ mentions ${text}`);
  const readme = read('README.md');
  for (const text of ['`docs/`', '`model/checksums.json`', '`public/data/metadata/checksums.json`']) assert.ok(readme.includes(text), `the README licence split names ${text}`);
  assert.equal(JSON.parse(read('model/chinook.modelspec.json')).license, undefined, 'the ModelSpec JSON AST has no licence field to carry one');
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

// The OpenVaultDB publisher manifest: OVDB.md opts the repository in, ovdb.yaml describes the database.
// The checks read what git holds at HEAD (existence and content), so the negative cases run against a
// scratch repository that holds copies of the manifest files, a directory, a symlink, and untracked
// and ignored files. A case commits its changed files, checks, and then drops that commit.
const manifestRepository = `https://${selfRepo}`;
const commitAs = (dir, ...args) => gitIn(dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', ...args);
const manifestRepo = (() => {
  const dir = join(scratch, `manifest-repo-${scratchCount++}`);
  mkdirSync(join(dir, 'model'), { recursive: true });
  for (const path of ['OVDB.md', 'ovdb.yaml', 'model/chinook.modelspec.json', 'model/chinook.modelspec.hcl', 'model/chinook.meaning.yaml']) copyFileSync(join(root, path), join(dir, path));
  symlinkSync('chinook.meaning.yaml', join(dir, 'model', 'link.yaml'));
  writeFileSync(join(dir, '.gitignore'), 'ignored.json\n');
  writeFileSync(join(dir, 'ignored.json'), '{}');
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '.');
  commitAs(dir, '-m', 'files');
  writeFileSync(join(dir, 'untracked.json'), '{}');
  return dir;
})();
const manifestFiles = gitRepoFiles(manifestRepo);
// A write or a reset may only ever touch a scratch repository this test created under the temp directory,
// never the checkout and never any other repository.
const assertScratch = (dir) => {
  const inside = (parent, child) => !relative(realpathSync(parent), realpathSync(child)).startsWith('..');
  assert.ok(inside(scratch, dir) && dir !== scratch, `${dir} is not a scratch repository under ${scratch}`);
  assert.ok(inside(realpathSync(tmpdir()), dir), `${dir} is not under the temp directory`);
  assert.ok(!inside(root, dir), `${dir} is inside the checkout`);
  assert.equal(realpathSync(gitIn(dir, 'rev-parse', '--show-toplevel')), realpathSync(dir), `${dir} is not the top of its own repository`);
};
// Commits `changes` to the scratch repository, runs `check` on it, and drops the commit again.
const withCommitted = (changes, check) => {
  assertScratch(manifestRepo);
  for (const [path, text] of Object.entries(changes)) writeFileSync(join(manifestRepo, path), text);
  gitIn(manifestRepo, 'add', '--', ...Object.keys(changes));
  commitAs(manifestRepo, '-m', 'case');
  try {
    return check();
  } finally {
    assertScratch(manifestRepo);
    gitIn(manifestRepo, 'reset', '-q', '--hard', 'HEAD~1');
  }
};
const manifestProblems = (changes = {}, options = { repository: manifestRepository }) => withCommitted(changes, () => checkOvdbManifest(manifestFiles, options).join('\n'));
const manifestReport = (changes = {}, options = { repository: manifestRepository }) => withCommitted(changes, () => reportOvdbManifest(manifestFiles, options));
const manifestDoc = () => parseYaml(read('ovdb.yaml'));
const withManifest = (change) => {
  const doc = manifestDoc();
  change(doc);
  return manifestProblems({ 'ovdb.yaml': stringifyYaml(doc) });
};
// A hoster's manifest (the shared form): no model files and no meaning file of its own; the model and the meaning
// graph of datatug/chinookdb, each pinned by address. It is a manifest of another publisher's repository.
const hosterRepository = 'https://github.com/acme/chinook-hosting';
const sharedPin = 'a1'.repeat(20);
const sharedDoc = (change = () => {}) => {
  const doc = manifestDoc();
  delete doc.model.modelspec;
  delete doc.model.hcl;
  doc.id = 'chinook-acme';
  doc.url = 'https://ovdb.acme.com/dbs/chinook';
  doc.deployment = { url: 'https://cloud.acme.com/ovdb/dbs/chinook', engine: 'postgres', discovery: 'https://ovdb.acme.com/.well-known/openvaultdb', recordset_page: 'https://cloud.acme.com/ovdb/dbs/chinook/collections/{name}' };
  doc.model = { address: `modelspec://${selfRepo}/chinook?ref=${sharedPin}` };
  doc.meaning = { file: 'model/chinook.meaning.yaml', address: `meaning://${selfRepo}?ref=${sharedPin}`, graph: { id: 'chinook' } };
  doc.publisher = { name: 'Acme', url: 'https://github.com/acme', repository: hosterRepository };
  doc.licences = { data: 'MIT' };
  change(doc);
  return doc;
};
// The scratch repository holds the datatug/chinookdb files, which a shared manifest must not read: the checker
// looks at the manifest only. `repository` is the publisher's repository the manifest must say it is in.
const sharedManifest = (change, options = { repository: hosterRepository }) => manifestProblems({ 'ovdb.yaml': stringifyYaml(sharedDoc(change)) }, options);
const sharedReport = (change, options = { repository: hosterRepository }) => manifestReport({ 'ovdb.yaml': stringifyYaml(sharedDoc(change)) }, options);
const withFrontmatter = (publish, extra = '') => manifestProblems({ 'OVDB.md': `---\novdb: 1\npublish: ${publish}\n${extra}---\n` });

test('OVDB.md and ovdb.yaml in this repository are a valid publisher manifest', () => {
  // The real files, read from the real repository's HEAD.
  assert.deepEqual(checkOvdbManifest(gitRepoFiles(root), { repository: manifestRepository }), []);
  assert.equal(manifestProblems(), '', 'and so are the copies the negative tests start from');
  const { data } = parseFrontmatter(read('OVDB.md'));
  assert.deepEqual(data, { ovdb: 1, publish: ['./ovdb.yaml'] });
  const doc = manifestDoc();
  assert.equal(doc.url, 'https://chinookdb.com/ovdb/dbs/chinook');
  assert.equal(doc.deployment.discovery, 'https://chinookdb.com/.well-known/openvaultdb', 'discovery is where the canonical url is listed');
  assert.deepEqual([...doc.recordsets].sort(), Object.keys(model.entities).sort(), 'recordsets are exactly the ModelSpec entities');
  assert.deepEqual(doc.licences, { data: 'MIT', model: 'MIT', meaning: meaning.license });
  assert.equal(doc.model.address, `modelspec://${selfRepo}/${model.module.name}`, 'the registry address is this repository plus the module name');
  assert.equal(model.module.id, `${selfRepo}/model/${model.module.name}`, 'module.id includes the model/ directory; the registry address does not');
  assert.equal(doc.meaning.graph.id, meaning.id);
});

test('a broken OVDB.md fails the manifest check', () => {
  assert.match(manifestProblems({ 'OVDB.md': '# no frontmatter\n' }), /OVDB.md has no YAML frontmatter/);
  assert.match(manifestProblems({ 'OVDB.md': '---\novdb: 2\npublish: [./ovdb.yaml]\n---\n' }), /ovdb must be 1/);
  assert.match(withFrontmatter('[./nope.yaml]'), /publish entry .\/nope.yaml must be a tracked regular file, but it is missing/);
  assert.match(withFrontmatter('["./*.yaml"]'), /no glob/);
  assert.match(withFrontmatter('[/etc/passwd]'), /must be a path starting with .\//);
  assert.match(withFrontmatter('[./../outside.yaml]'), /no glob, no \.\./);
  assert.match(withFrontmatter('[]'), /publish must list at least one/);
  assert.match(withFrontmatter('[./ovdb.yaml, ./ovdb.yaml]'), /publish lists .\/ovdb.yaml twice/);
  assert.match(withFrontmatter('[./ovdb.yaml]', 'token: abc\n'), /unknown frontmatter keys: token/);
});

test('every file the manifest names must be a regular file that git tracks at HEAD', () => {
  const naming = (field, path) => withManifest((m) => { const [a, b] = field.split('.'); m[a][b] = path; });
  assert.match(naming('meaning.file', 'model/missing.meaning.yaml'), /meaning.file names model\/missing.meaning.yaml, which must be a tracked regular file, but it is missing/);
  assert.match(naming('model.hcl', 'model'), /model.hcl "model" must be a path ending in .modelspec.hcl/);
  assert.match(naming('meaning.file', 'model'), /meaning.file names model, which must be a tracked regular file, but it is directory/);
  assert.match(naming('meaning.file', 'model/link.yaml'), /meaning.file names model\/link.yaml, .* it is symlink/);
  assert.match(naming('meaning.file', 'untracked.json'), /untracked.json, .* it is untracked/);
  assert.match(naming('meaning.file', 'ignored.json'), /ignored.json, .* it is ignored/);
  assert.match(naming('model.hcl', '/etc/hosts'), /relative to the repository root \(no glob, no \.\., not absolute\)/);
  assert.match(naming('model.hcl', 'model/*.hcl'), /no glob/);
  assert.match(naming('model.modelspec', '../outside.json'), /no glob, no \.\./);
  assert.match(naming('model.modelspec', 'model/chinook.meaning.yaml'), /model.modelspec "model\/chinook.meaning.yaml" must be a path ending in .modelspec.json/);
  assert.match(naming('model.hcl', 'model/chinook.modelspec.json'), /model.hcl "model\/chinook.modelspec.json" must be a path ending in .modelspec.hcl/);
  assert.match(naming('model.hcl', 'OVDB.md'), /model.hcl "OVDB.md" must be a path ending in .modelspec.hcl/);
  // A path is relative to the repository root, not to the manifest.
  assert.match(naming('meaning.file', 'chinook.meaning.yaml'), /meaning.file names chinook.meaning.yaml, .* it is missing/);
  // The manifest files themselves are held to the same rule.
  assert.match(withFrontmatter('[./untracked.json]'), /publish entry .\/untracked.json must be a tracked regular file, but it is untracked/);
  assert.match(withFrontmatter('[./model]'), /but it is directory/);
});

test('the manifest holds identities and URLs a client can trust, and nothing else', () => {
  const url = (field, value) => withManifest((m) => { const [a, b] = field.split('.'); if (b) m[a][b] = value; else m[a] = value; });
  assert.match(withManifest((m) => { delete m.url; }), /url is required/);
  assert.match(url('url', 'http://chinookdb.com/ovdb/dbs/chinook'), /url must be an https URL/);
  assert.match(url('url', 'https://user:s3cret@chinookdb.com/ovdb/dbs/chinook'), /url must not carry credentials/);
  assert.match(url('url', 'https://chinookdb.com/ovdb/dbs/chinook?token=abc123'), /url must not carry a query string or fragment/);
  assert.match(url('url', 'https://chinookdb.com/ovdb/dbs/chinook#x'), /url must not carry a query string or fragment/);
  assert.match(url('url', 'https://127.0.0.1/ovdb/dbs/chinook'), /url must name a host, not an IP address/);
  assert.match(url('url', 'https://169.254.169.254/ovdb/dbs/chinook'), /url must name a host, not an IP address/);
  assert.match(url('url', 'https://[::1]/ovdb/dbs/chinook'), /url must name a host, not an IP address/);
  assert.match(url('url', 'https://localhost/ovdb/dbs/chinook'), /url must be a public host/);
  assert.match(url('url', 'https://metadata.google.internal/ovdb/dbs/chinook'), /url must be a public host/);
  assert.match(url('url', 'https://chinookdb.com/dbs/chinook'), /url must have an ovdb path segment or an ovdb subdomain/);
  assert.equal(url('url', 'https://ovdb.example.com/dbs/chinook').includes('url must have'), false, 'an ovdb subdomain is enough');
  assert.match(url('deployment.url', 'http://cloud.openvaultdb.com/ovdb/dbs/chinook'), /deployment.url must be an https URL/);
  assert.match(withManifest((m) => { delete m.deployment.engine; }), /deployment.engine is required/);
  assert.match(withManifest((m) => { m.api_key = 'sk-live-123'; }), /unknown keys: api_key/);
  assert.match(withManifest((m) => { m.deployment.token = 'abc'; }), /unknown deployment.keys: token/);
  assert.match(withManifest((m) => { m.meaning.graph.secret = 'abc'; }), /unknown meaning.graph.keys: secret/);
  assert.match(url('format', 'ovdb-manifest/v9'), /format must be ovdb-manifest\/draft-1/);
  assert.match(manifestProblems({ 'ovdb.yaml': 'format: [unterminated' }), /ovdb.yaml: is not valid YAML/);
});

test('homepage is an optional public https URL, in both forms, and need not be on the canonical origin', () => {
  assert.equal(manifestDoc().homepage, 'https://chinookdb.com/');
  for (const url of ['https://chinookdb.com/', 'https://www.example.com/chinook/', 'https://other-site.org/a/b']) {
    assert.equal(withManifest((m) => { m.homepage = url; }), '', url);
    assert.equal(sharedManifest((m) => { m.homepage = url; }), '', `shared ${url}`);
  }
  assert.equal(withManifest((m) => { delete m.homepage; }), '', 'it is optional');
  assert.equal(sharedManifest((m) => { delete m.homepage; }), '');
  for (const bad of ['http://chinookdb.com/', 'ftp://chinookdb.com/', 'chinookdb.com', 'https://user:pw@chinookdb.com/', 'https://chinookdb.com/?x=1', 'https://chinookdb.com/#top',
    'https://127.0.0.1/', 'https://10.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://intranet.corp/', 'https://printer.internal/', 'https://host.local/', 5, '', null, ['https://chinookdb.com/']]) {
    for (const [name, check] of [['own', withManifest], ['shared', sharedManifest]]) {
      assert.match(check((m) => { m.homepage = bad; }), /homepage (is required|must be|must not|must name|must be a public)/, `${name} homepage ${JSON.stringify(bad)}`);
    }
  }
});

test('discovery is the canonical url\'s own document, and recordset_page is a template on the deployment', () => {
  const deployment = (field, value) => withManifest((m) => { m.deployment[field] = value; });
  assert.match(deployment('discovery', 'https://evil.example.com/.well-known/openvaultdb'), /deployment.discovery must be on the origin of url \(https:\/\/chinookdb.com\)/);
  assert.match(deployment('discovery', 'https://cloud.openvaultdb.com/.well-known/openvaultdb'), /deployment.discovery must be on the origin of url/, 'the cloud document does not list the canonical url');
  assert.match(deployment('discovery', 'https://chinookdb.com/other'), /deployment.discovery must be https:\/\/chinookdb.com\/.well-known\/openvaultdb/);
  assert.match(withManifest((m) => { delete m.deployment.discovery; }), /deployment.discovery is required/);
  assert.equal(withManifest((m) => { delete m.deployment.recordset_page; }), '', 'recordset_page is optional');
  assert.match(deployment('recordset_page', 'https://cloud.openvaultdb.com/ovdb/dbs/chinook/collections/Customer'), /recordset_page must contain \{name\} exactly once/);
  assert.match(deployment('recordset_page', 'https://cloud.openvaultdb.com/{name}/{name}'), /recordset_page must contain \{name\} exactly once/);
  assert.match(deployment('recordset_page', 'https://evil.example.com/collections/{name}'), /recordset_page must be on the origin of deployment.url \(https:\/\/cloud.openvaultdb.com\)/);
  assert.match(deployment('recordset_page', 'http://cloud.openvaultdb.com/collections/{name}'), /recordset_page must be an https URL/);
  assert.match(deployment('recordset_page', 'https://cloud.openvaultdb.com/c/{name}?token=abc'), /recordset_page must not carry a query string/);
  // Only {name} is a placeholder; any other brace would reach a client unexpanded.
  assert.match(deployment('recordset_page', 'https://cloud.openvaultdb.com/c/{name}/{id}'), /recordset_page may contain only the \{name\} placeholder/);
  assert.match(deployment('recordset_page', 'https://cloud.openvaultdb.com/c/{name}/}'), /may contain only the \{name\} placeholder/);
  assert.match(deployment('recordset_page', 'https://cloud.openvaultdb.com/{{name}'), /may contain only the \{name\} placeholder/);
});

test('the publisher, the graph and the licences are stated and agree with the repository', () => {
  assert.match(withManifest((m) => { delete m.publisher.repository; }), /publisher.repository is required/);
  assert.match(withManifest((m) => { m.publisher.repository = 'http://github.com/datatug/chinookdb'; }), /publisher.repository must be an https URL/);
  assert.match(withManifest((m) => { m.publisher.repository = 'https://example.com/datatug/chinookdb'; }), /publisher.repository must be https:\/\/github.com\/<owner>\/<repository>/);
  assert.match(withManifest((m) => { m.publisher.repository = 'https://github.com/other/chinookdb'; }), /publisher.repository must belong to the owner in publisher.url/);
  assert.match(withManifest((m) => { m.publisher.repository = 'https://github.com/datatug/other'; }), /publisher.repository must be https:\/\/github.com\/datatug\/chinookdb, the repository this manifest is in/);
  assert.match(withManifest((m) => { m.publisher.url = 'https://example.com/datatug'; }), /publisher.url must be https:\/\/github.com\/<owner>/);
  assert.match(withManifest((m) => { m.meaning.graph.id = 'not-chinook'; }), /meaning.graph.id is not-chinook but the meaning file's id is "chinook"/);
  assert.match(withManifest((m) => { m.meaning.graph.address = 'meaning://github.com/someone/else'; }), /meaning.graph.address must be meaning:\/\/github.com\/datatug\/chinookdb, derived from publisher.repository/);
  assert.match(withManifest((m) => { delete m.licences.data; }), /licences.data is required/);
  assert.match(withManifest((m) => { m.licences.data = 'see the README'; }), /licences.data must be a known SPDX licence id/);
  assert.match(withManifest((m) => { m.licences.model = 'Foo'; }), /licences.model must be a known SPDX licence id .*got "Foo"/);
  assert.match(withManifest((m) => { m.licences.data = 'MTI'; }), /licences.data must be a known SPDX licence id/);
  for (const id of ['MIT', 'CC0-1.0', 'CC-BY-4.0', 'Apache-2.0', 'BSD-3-Clause']) {
    assert.equal(withManifest((m) => { m.licences.data = id; }), '', `${id} is accepted`);
  }
  assert.match(withManifest((m) => { m.licences.meaning = 'MIT'; }), /licences.meaning is MIT but the meaning file says CC0-1.0/);
});

test('the recordsets must be exactly the ModelSpec entities', () => {
  assert.match(withManifest((m) => { m.recordsets.pop(); }), /recordsets lacks ModelSpec entities: Track/);
  assert.match(withManifest((m) => { m.recordsets.push('Podcast'); }), /not ModelSpec entities: Podcast/);
  assert.match(withManifest((m) => { m.recordsets.push('Album'); }), /recordsets lists a name twice/);
  assert.match(withManifest((m) => { m.recordsets = []; }), /recordsets must be a non-empty list/);
});

test('the data licence is the upstream one: MIT, Copyright Luis Rocha', () => {
  assert.match(read('data-source/UPSTREAM-LICENSE.md'), /Copyright \(c\) 2008-2024 Luis Rocha/);
  assert.match(read('data-source/UPSTREAM-LICENSE.md'), /Permission is hereby granted, free of charge/);
  assert.equal(manifestDoc().licences.data, 'MIT');
});

test('model.hcl is required with local model files, and the files are read from HEAD', () => {
  assert.match(withManifest((m) => { delete m.model.hcl; }), /model.hcl is required with local model files/);
  assert.match(withManifest((m) => { delete m.model.modelspec; }), /model.modelspec is required with local model files/);
  assert.match(withManifest((m) => { m.model.hcl = ''; }), /model.hcl is required with local model files/);
  // An edit that is not committed is not seen: the content check reads HEAD, as the existence check does.
  writeFileSync(join(manifestRepo, 'ovdb.yaml'), 'format: [broken');
  try {
    assert.equal(checkOvdbManifest(manifestFiles, { repository: manifestRepository }).join('\n'), '');
    assert.equal(manifestFiles.read('ovdb.yaml').startsWith('# OpenVaultDB publisher manifest'), true);
  } finally {
    assertScratch(manifestRepo);
    gitIn(manifestRepo, 'checkout', '--', 'ovdb.yaml');
  }
});

test('git pathspec magic is a literal path, never a way to reach another file', () => {
  const naming = (path) => withManifest((m) => { m.model.hcl = path; });
  // `:/` would resolve to the repository root, `:(icase)` would match another case; neither may pass or throw.
  assert.match(naming(':/model/chinook.modelspec.hcl'), /model.hcl names :\/model\/chinook.modelspec.hcl, which must be a tracked regular file, but it is missing/);
  assert.match(naming(':(icase)MODEL/chinook.modelspec.hcl'), /model.hcl names :\(icase\)MODEL\/chinook.modelspec.hcl, .* it is missing/);
  assert.match(naming(':(top)model/chinook.modelspec.hcl'), /it is missing/);
  assert.match(naming(':!model/chinook.modelspec.hcl'), /it is missing/);
  assert.match(naming('MODEL/chinook.modelspec.hcl'), /it is (missing|untracked)/, 'a different case is a different path');
  assert.equal(manifestFiles.kind('model/chinook.modelspec.hcl'), 'file');
  assert.equal(manifestFiles.kind(':(icase)MODEL/chinook.modelspec.hcl'), 'missing');
});

test('model.address names the model in the registry: our own files and address, or another repository pinned by ref', () => {
  const address = (value) => withManifest((m) => { m.model.address = value; });
  const own = `modelspec://${selfRepo}/chinook`;
  const pin = 'a'.repeat(40);
  // Local files plus this repository's own address.
  assert.equal(address(own), '');
  assert.equal(withManifest((m) => { delete m.model.address; }), '', 'local files alone are enough');
  assert.match(address(`${own}?ref=${pin}`), /model.address must not carry \?ref= when the model files are in this repository/);
  assert.match(address(`modelspec://${selfRepo}/other`), /model.address must be modelspec:\/\/github.com\/datatug\/chinookdb\/chinook, this repository plus the module name/);
  assert.match(address('modelspec://github.com/someone/else/chinook'), /model.address must be modelspec:\/\/github.com\/datatug\/chinookdb\/chinook/);
  assert.match(address(`modelspec://${selfRepo}/model/chinook`), /model.address must be modelspec:\/\/github.com\/datatug\/chinookdb\/model\/chinook|must be modelspec:\/\/github.com\/<org>/);
  assert.match(address(own.replace('github.com/datatug/chinookdb', 'github.com/DataTug/chinookdb')), /model.address .* must be written in lower case \(host, organisation and repository; the module name is case-sensitive\)/);
  assert.match(address(own.replace(/\/chinook$/, '/Chinook')), /model.address must be modelspec:\/\/github.com\/datatug\/chinookdb\/chinook, this repository plus the module name/, 'the module name is case-sensitive');
  // Grammar.
  for (const bad of [
    'chinook', 'meaning://github.com/datatug/chinookdb/chinook', 'https://github.com/datatug/chinookdb/chinook',
    'modelspec://GitHub.com/datatug/chinookdb/chinook', 'modelspec://example.com/datatug/chinookdb/chinook',
    'modelspec://github.com/datatug/chinookdb', 'modelspec://github.com/datatug/chinookdb/model/chinook',
    'modelspec://github.com/datatug/chinookdb/chinook/', 'modelspec://github.com/datatug/chinookdb//chinook',
    'modelspec://user@github.com/datatug/chinookdb/chinook', 'modelspec://github.com:443/datatug/chinookdb/chinook',
    `${own}#x`, `${own}?`, `${own}?ref=abc`, `${own}?ref=${'A'.repeat(40)}`, `${own}?ref=${'a'.repeat(41)}`,
    `${own}?ref=${pin}&x=1`, `${own}?x=1`, `${own}?ref=${pin}#x`, `${own} `, 7,
  ]) {
    assert.match(address(bad), /model.address must be modelspec:\/\/github.com\/<org>\/<repository>\/<module>/, `refused: ${JSON.stringify(bad)}`);
  }
  assert.match(withManifest((m) => { m.model.address = 5; }), /model.address must be modelspec:/);
  // Another repository: no local files, both addresses pinned (the tests of the shared form are below).
  assert.equal(sharedManifest(), '');
});

test('one grammar for the address, the module and the repository, as the registries and the Directory accept them', () => {
  const pin = 'b'.repeat(40);
  const grammar = /model.address must be modelspec:\/\/github.com\/<org>\/<repository>\/<module>/;
  // Shared, so the exact-match rule for local files cannot hide a loose grammar.
  const remote = (address) => sharedManifest((m) => { m.model.address = address; });
  assert.equal(remote(`modelspec://github.com/acme/chinook-models/chinook?ref=${pin}`), '');
  assert.equal(remote(`modelspec://github.com/acme/my.repo_1-x/model_2?ref=${pin}`), '');
  // A module name is a letter, then letters, digits and _; upper case is a module name too.
  for (const good of ['Sales', 'chinook', 'ChinookDB2', 'a', 'Model_Two']) assert.equal(remote(`modelspec://github.com/acme/other/${good}?ref=${pin}`), '', `module ${good}`);
  for (const bad of ['chinook.Customer', 'chinook.', '.chinook', '1chinook', '_chinook', 'chinook-x', 'chinook.x.y', 'chinook/x', 'ch inook']) {
    assert.match(remote(`modelspec://github.com/acme/other/${bad}?ref=${pin}`), grammar, `module ${bad}`);
  }
  // Organisation and repository: [A-Za-z0-9_.-]+, not . or .., a repository never ends in .git (in any case).
  for (const good of ['.github', 'a.b', 'a_b', '-x', '.hidden', 'x.gitx', 'My.Repo']) {
    assert.doesNotMatch(remote(`modelspec://github.com/acme/${good}/chinook?ref=${pin}`), grammar, `repository ${good}`);
    assert.doesNotMatch(remote(`modelspec://github.com/${good}/other/chinook?ref=${pin}`), grammar, `owner ${good}`);
  }
  for (const bad of ['..', '.', 'chinookdb.git', 'a.git', 'a.GIT', 'x.Git', '', 'a b', 'a%2eb', 'a@b']) {
    assert.match(remote(`modelspec://github.com/acme/${bad}/chinook?ref=${pin}`), grammar, `repository ${JSON.stringify(bad)}`);
  }
  for (const bad of ['..', '.', '', 'a b', 'a@b']) {
    assert.match(remote(`modelspec://github.com/${bad}/other/chinook?ref=${pin}`), grammar, `owner ${JSON.stringify(bad)}`);
  }
  // The same segment grammar for the meaning address, publisher.repository and publisher.url.
  const graphGrammar = /meaning.address must be meaning:\/\/github.com\/<org>\/<repository>\?ref=<40 hex>/;
  assert.equal(sharedManifest((m) => { m.meaning.address = `meaning://github.com/acme/.github?ref=${pin}`; }), '');
  for (const bad of ['..', '.', 'x.git', 'x.GIT', '', 'a b']) {
    assert.match(sharedManifest((m) => { m.meaning.address = `meaning://github.com/acme/${bad}?ref=${pin}`; }), graphGrammar, `graph repository ${JSON.stringify(bad)}`);
  }
  assert.match(withManifest((m) => { m.publisher.repository = 'https://github.com/datatug/..'; }), /publisher.repository must be https:\/\/github.com\/<owner>\/<repository>/);
  assert.match(withManifest((m) => { m.publisher.repository = 'https://github.com/datatug/chinookdb.git'; }), /publisher.repository must be https:\/\/github.com\/<owner>\/<repository>/);
  assert.match(withManifest((m) => { m.publisher.repository = 'https://github.com/datatug/chinookdb.GIT'; }), /publisher.repository must be https:\/\/github.com\/<owner>\/<repository>/);
  assert.match(withManifest((m) => { m.publisher.url = 'https://github.com/..'; }), /publisher.url must be https:\/\/github.com\/<owner>/);
});

test('an own manifest of a mixed-case or dot-named repository addresses it in lower case, as the Directory requires', () => {
  const own = (repo, change = () => {}) => {
    const doc = manifestDoc();
    doc.publisher.url = `https://github.com/${repo.split('/')[0]}`;
    doc.publisher.repository = `https://github.com/${repo}`;
    doc.meaning.graph.address = `meaning://github.com/${repo}`;
    doc.model.address = `modelspec://github.com/${repo.toLowerCase()}/chinook`;
    change(doc);
    return manifestProblems({ 'ovdb.yaml': stringifyYaml(doc) }, {});
  };
  assert.equal(own('datatug/chinookdb'), '');
  assert.equal(own('DataTug/ChinookDB'), '', 'GitHub does not tell the cases apart; the address is the lower-case spelling');
  assert.equal(own('datatug/.github'), '', 'a repository whose name starts with a dot');
  assert.equal(own('My-Org/My.Repo_2'), '');
  assert.match(own('DataTug/ChinookDB', (doc) => { doc.model.address = 'modelspec://github.com/DataTug/ChinookDB/chinook'; }), /model.address .* must be written in lower case/);
  assert.match(own('DataTug/ChinookDB', (doc) => { doc.model.address = 'modelspec://github.com/datatug/chinookdb/Chinook'; }), /model.address must be modelspec:\/\/github.com\/datatug\/chinookdb\/chinook, this repository plus the module name/);
  assert.match(own('datatug/chinookdb', (doc) => { doc.model.address = 'modelspec://github.com/datatug/other/chinook'; }), /model.address must be modelspec:\/\/github.com\/datatug\/chinookdb\/chinook/);
});

test('a module with upper case letters is addressable, and the meaning file names it', () => {
  const json = JSON.parse(readFileSync(join(manifestRepo, 'model/chinook.modelspec.json'), 'utf8'));
  json.module.name = 'Sales';
  const meaningText = readFileSync(join(manifestRepo, 'model/chinook.meaning.yaml'), 'utf8').replace('  chinook: chinook.modelspec.hcl\n', '  Sales: chinook.modelspec.hcl\n');
  assert.notEqual(meaningText, readFileSync(join(manifestRepo, 'model/chinook.meaning.yaml'), 'utf8'), 'the models: entry was renamed');
  const changes = (address) => ({
    'model/chinook.modelspec.json': JSON.stringify(json),
    'model/chinook.meaning.yaml': meaningText,
    'ovdb.yaml': stringifyYaml({ ...manifestDoc(), model: { ...manifestDoc().model, address } }),
  });
  assert.equal(manifestProblems(changes('modelspec://github.com/datatug/chinookdb/Sales')), '');
  assert.match(manifestProblems(changes('modelspec://github.com/datatug/chinookdb/sales')), /model.address must be modelspec:\/\/github.com\/datatug\/chinookdb\/Sales, this repository plus the module name/);
  assert.match(manifestProblems(changes('modelspec://github.com/datatug/chinookdb/chinook')), /model.address must be modelspec:\/\/github.com\/datatug\/chinookdb\/Sales/);
});

test('a model file that is valid JSON but not a ModelSpec is a problem, never a silent pass', () => {
  // null, 0, false and "" used to skip every check that reads the model: the address, the entities and the models: entry.
  for (const text of ['null', '0', 'false', '""', '[]', '[1]', '7', '"chinook"', 'true']) {
    assert.match(manifestProblems({ 'model/chinook.modelspec.json': text }), /model\/chinook.modelspec.json is not a ModelSpec JSON file: it must be a JSON object/, `JSON ${text}`);
  }
  assert.match(manifestProblems({ 'model/chinook.modelspec.json': '{' }), /is not a ModelSpec JSON file: /);
  const named = (name) => JSON.stringify({ module: { name }, entities: { Album: {} } });
  // No module name, or one that is not a module name: reported, so the models: comparison is never silently skipped.
  for (const text of ['{}', '{"module":null}', '{"module":0}', '{"module":{}}', named(null), named(0), named(false), named(''), named('a b'), named('1x'), named('_x'), named('x.y'), named(['chinook'])]) {
    assert.match(manifestProblems({ 'model/chinook.modelspec.json': text }), /model\/chinook.modelspec.json has no module.name that is a ModelSpec module name/, `JSON ${text}`);
  }
  // No entities.
  for (const text of ['{"module":{"name":"chinook"}}', '{"module":{"name":"chinook"},"entities":null}', '{"module":{"name":"chinook"},"entities":[]}', '{"module":{"name":"chinook"},"entities":0}']) {
    assert.match(manifestProblems({ 'model/chinook.modelspec.json': text }), /model\/chinook.modelspec.json has no entities/, `JSON ${text}`);
  }
  // A module that the meaning file does not bind is reported, with an address too.
  const real = JSON.parse(readFileSync(join(manifestRepo, 'model/chinook.modelspec.json'), 'utf8'));
  assert.match(manifestProblems({ 'model/chinook.modelspec.json': JSON.stringify({ ...real, module: { name: 'other' } }) }), /the meaning file model\/chinook.meaning.yaml has no models: entry for module other/);
  // The recordsets comparison runs whenever the model has entities.
  assert.match(manifestProblems({ 'model/chinook.modelspec.json': JSON.stringify({ module: { name: 'chinook' }, entities: { Album: {} } }) }), /recordsets names things that are not ModelSpec entities: Artist/);
  // The meaning file: valid YAML that is not a mapping.
  for (const text of ['null', '0', '""', '[]', 'just text']) {
    assert.match(manifestProblems({ 'model/chinook.meaning.yaml': text }), /model\/chinook.meaning.yaml is not a MeaningGraph file: it must be a mapping/, `YAML ${text}`);
  }
  assert.equal(manifestProblems(), '');
});

// The shared form: a hoster's manifest has no model files and no meaning file; the model and the meaning graph
// are named by pinned addresses in other repositories. The check is offline, so only the shape is checked.
test('a shared manifest names the model and the meaning graph by pinned address, with no local files', () => {
  assert.equal(sharedManifest(), '');
  // The optional parts.
  assert.equal(sharedManifest((m) => { m.licences.model = 'MIT'; m.licences.meaning = 'CC0-1.0'; }), '', 'licences.model and licences.meaning are optional, and valid when given');
  assert.equal(sharedManifest((m) => { m.meaning.graph.address = 'meaning://github.com/datatug/chinookdb'; }), '', 'meaning.graph.address may be the unpinned address');
  assert.equal(sharedManifest((m) => { m.model.name = 'chinook'; }), '');
  assert.equal(sharedManifest((m) => { delete m.deployment.recordset_page; }), '');
  assert.equal(sharedManifest((m) => { m.recordsets_partial = true; m.recordsets = ['Artist']; }), '', 'a subset says so with recordsets_partial; the Directory checks it against the model');
  assert.equal(sharedManifest((m) => { m.recordsets_partial = false; }), '');
  assert.equal(sharedManifest((m) => { m.meaning.file = 'meaning/sub-dir/chinook.v2.meaning.yaml'; }), '', 'meaning.file is a path in the graph\'s repository: it is not looked up here');
  assert.equal(sharedManifest((m) => { m.model.address = `modelspec://github.com/acme/chinook-models/Sales?ref=${'c'.repeat(40)}`; }), '');
  // The model: named, pinned.
  assert.match(sharedManifest((m) => { delete m.model; }), /model must name the model by local files .* or by model.address/);
  assert.match(sharedManifest((m) => { m.model = {}; }), /model must name the model by local files/);
  assert.match(sharedManifest((m) => { m.model.address = 'modelspec://github.com/datatug/chinookdb/chinook'; }), /model.address must carry \?ref=<40 hex> when the model is not in this repository/);
  for (const ref of ['main', 'abc', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), '']) {
    assert.match(sharedManifest((m) => { m.model.address = `modelspec://github.com/datatug/chinookdb/chinook?ref=${ref}`; }), /model.address must be modelspec:/, `ref ${JSON.stringify(ref)}`);
  }
  assert.match(sharedManifest((m) => { m.model.name = 'other'; }), /model.name is other, but model.address names module chinook/);
  assert.match(sharedManifest((m) => { m.model.name = 'a b'; }), /model.name, when given, must be a ModelSpec module name/);
  // The meaning graph: named, pinned, a file, an id.
  assert.match(sharedManifest((m) => { delete m.meaning.address; }), /meaning.address is required when model.address names a model in another repository/);
  assert.match(sharedManifest((m) => { m.meaning.address = 'meaning://github.com/datatug/chinookdb'; }), /meaning.address must carry \?ref=<40 hex>/);
  for (const bad of ['chinook', 'modelspec://github.com/datatug/chinookdb?ref=' + 'a'.repeat(40), 'https://github.com/datatug/chinookdb', 'meaning://GitHub.com/datatug/chinookdb', 'meaning://example.com/datatug/chinookdb',
    `meaning://github.com/datatug/chinookdb/x?ref=${'a'.repeat(40)}`, 'meaning://github.com/datatug?ref=' + 'a'.repeat(40), 'meaning://github.com/datatug/chinookdb?ref=main', 'meaning://github.com/datatug/chinookdb?ref=' + 'a'.repeat(40) + '#x', 5, '']) {
    assert.match(sharedManifest((m) => { m.meaning.address = bad; }), /meaning.address must be meaning:\/\/github.com\/<org>\/<repository>\?ref=<40 hex>/, `meaning.address ${JSON.stringify(bad)}`);
  }
  assert.match(sharedManifest((m) => { delete m.meaning.file; }), /meaning.file \(the file of the graph, in the graph's repository, that binds the model\) is required/);
  for (const bad of ['../x.meaning.yaml', '/abs/x.yaml', 'dir/', 'a//b.yaml', './x.yaml', 'a/./b.yaml', 'a/../b.yaml', 'x*.yaml', 'a b.yaml', 'x?.yaml', 'é.yaml', 5, '']) {
    assert.match(sharedManifest((m) => { m.meaning.file = bad; }), /meaning.file .*(is required|must be a file path in the graph's repository)/, `meaning.file ${JSON.stringify(bad)}`);
  }
  assert.match(sharedManifest((m) => { delete m.meaning.graph; }), /meaning.graph.id \(the MeaningGraph registry id\) is required/);
  assert.match(sharedManifest((m) => { delete m.meaning.graph.id; }), /meaning.graph.id \(the MeaningGraph registry id\) is required/);
  for (const bad of ['Chinook', 'a b', 'a--b', '-a', 'a_b']) assert.match(sharedManifest((m) => { m.meaning.graph.id = bad; }), /meaning.graph.id must be a MeaningGraph registry id/, `graph id ${bad}`);
  assert.match(sharedManifest((m) => { m.meaning.graph.address = 'meaning://github.com/datatug/other'; }), /meaning.graph.address is meaning:\/\/github.com\/datatug\/other, but meaning.address names meaning:\/\/github.com\/datatug\/chinookdb; leave meaning.graph.address out/);
  assert.match(sharedManifest((m) => { m.meaning.graph.address = `meaning://github.com/datatug/chinookdb?ref=${'a'.repeat(40)}`; }), /meaning.graph.address is .*, but meaning.address names meaning:\/\/github.com\/datatug\/chinookdb/);
  assert.match(sharedManifest((m) => { m.meaning.graph.address = 'https://github.com/datatug/chinookdb'; }), /meaning.graph.address, when given, must be the graph's meaning:\/\/ address without a pin/);
  // Licences: the hoster's data licence is required; a model or meaning licence, when written, is a known one.
  assert.match(sharedManifest((m) => { delete m.licences.data; }), /licences.data is required/);
  assert.match(sharedManifest((m) => { delete m.licences; }), /licences.data is required/);
  assert.match(sharedManifest((m) => { m.licences.data = 'MTI'; }), /licences.data must be a known SPDX licence id/);
  assert.match(sharedManifest((m) => { m.licences.model = 'Foo'; }), /licences.model must be a known SPDX licence id/);
  assert.match(sharedManifest((m) => { m.licences.meaning = 7; }), /licences.meaning is required|licences.meaning must be a known SPDX licence id/);
  // recordsets_partial is a boolean.
  for (const bad of ['yes', 1, 'true', null, []]) assert.match(sharedManifest((m) => { m.recordsets_partial = bad; }), /recordsets_partial must be true or false/, `recordsets_partial ${JSON.stringify(bad)}`);
  // Unknown keys are still refused, in the new places too.
  assert.match(sharedManifest((m) => { m.meaning.secret = 'x'; }), /unknown meaning.keys: secret/);
  assert.match(sharedManifest((m) => { m.model.secret = 'x'; }), /unknown model.keys: secret/);
  assert.match(sharedManifest((m) => { m.secret = 'x'; }), /unknown keys: secret/);
});

test('a shared manifest never names the publisher\'s own repository, and writes both addresses in lower case', () => {
  const pin = 'd'.repeat(40);
  const own = 'acme/chinook-hosting';
  assert.match(sharedManifest((m) => { m.model.address = `modelspec://github.com/${own}/chinook?ref=${pin}`; }), /model.address .* names this repository; a model or meaning file in the publisher's own repository is named by local files \(model.modelspec and meaning.file\), not by a pinned address/);
  assert.match(sharedManifest((m) => { m.meaning.address = `meaning://github.com/${own}?ref=${pin}`; }), /meaning.address .* names this repository; a model or meaning file in the publisher's own repository is named by local files/);
  // A mixed-case spelling of the own repository is refused for its case, as the Directory refuses it.
  assert.match(sharedManifest((m) => { m.model.address = `modelspec://github.com/Acme/Chinook-Hosting/chinook?ref=${pin}`; }), /model.address .* must be written in lower case \(host, organisation and repository; the module name is case-sensitive\)/);
  // A publisher whose own repository is mixed-case is compared in lower case.
  assert.match(sharedManifest((m) => { m.publisher.repository = 'https://github.com/Acme/Chinook-Hosting'; m.model.address = `modelspec://github.com/acme/chinook-hosting/chinook?ref=${pin}`; }, { repository: 'https://github.com/Acme/Chinook-Hosting' }), /model.address .* names this repository/);
  for (const [where, address] of [
    ['model.address', `modelspec://github.com/Datatug/chinookdb/chinook?ref=${pin}`], ['model.address', `modelspec://github.com/datatug/ChinookDB/chinook?ref=${pin}`],
    ['meaning.address', `meaning://github.com/Datatug/chinookdb?ref=${pin}`], ['meaning.address', `meaning://github.com/datatug/ChinookDB?ref=${pin}`],
  ]) {
    assert.match(sharedManifest((m) => { m[where.split('.')[0]].address = address; }), new RegExp(`${where.replace('.', '\\.')} .* must be written in lower case`), address);
  }
  // Someone else's repository is fine, whatever its name.
  assert.equal(sharedManifest((m) => { m.model.address = `modelspec://github.com/acme/chinook-hosting-2/chinook?ref=${pin}`; }), '');
});

test('the two forms do not mix', () => {
  const pin = 'e'.repeat(40);
  // Local model files with meaning.address or recordsets_partial: those belong to the shared form.
  assert.match(withManifest((m) => { m.meaning.address = `meaning://github.com/datatug/chinookdb?ref=${pin}`; }), /meaning.address is only for a shared model/);
  assert.match(withManifest((m) => { m.recordsets_partial = true; }), /recordsets_partial is only for a shared model; a manifest with its own model files lists every ModelSpec entity/);
  assert.match(withManifest((m) => { m.recordsets_partial = false; }), /recordsets_partial is only for a shared model/);
  // Local model files with an address in another repository, pinned or not.
  for (const foreign of ['modelspec://github.com/acme/other/chinook', `modelspec://github.com/acme/other/chinook?ref=${pin}`]) {
    assert.match(withManifest((m) => { m.model.address = foreign; }), /model.address must be modelspec:\/\/github.com\/datatug\/chinookdb\/chinook, this repository plus the module name/);
  }
  // Either local model file makes it an own manifest, which then needs both and its own meaning graph address.
  assert.match(sharedManifest((m) => { m.model.hcl = 'model/chinook.modelspec.hcl'; }), /model.modelspec is required with local model files/);
  assert.match(sharedManifest((m) => { m.model.modelspec = 'model/chinook.modelspec.json'; }), /model.hcl is required with local model files/);
  assert.match(sharedManifest((m) => { m.model.modelspec = 'model/chinook.modelspec.json'; m.model.hcl = 'model/chinook.modelspec.hcl'; }), /meaning.address is only for a shared model/);
  // A shared model has no meaning file of its own: only meaning.address names the graph.
  assert.match(sharedManifest((m) => { delete m.meaning.address; }), /meaning.address is required/);
  assert.match(sharedManifest((m) => { delete m.model.address; }), /model must name the model by local files/);
  // The own form still needs everything it needed.
  assert.match(withManifest((m) => { delete m.licences.model; }), /licences.model is required/);
  assert.match(withManifest((m) => { delete m.licences.meaning; }), /licences.meaning is required/);
  assert.match(withManifest((m) => { delete m.meaning.graph.address; }), /meaning.graph.address is required/);
  assert.match(withManifest((m) => { delete m.meaning.file; }), /meaning.file is required/);
});

test('the report says what an offline check of a shared manifest leaves to the Directory', () => {
  const shared = sharedReport();
  assert.deepEqual(shared.problems, []);
  assert.equal(shared.notes.length, 1);
  assert.match(shared.notes[0], /^ovdb.yaml: shared model: this check is offline and validated only the shape of model.address, meaning.address, meaning.file, meaning.graph, the licences and recordsets\. The OVDB Directory checks both addresses against the ModelSpec registry and the MeaningGraph registry, reads both repositories at the pinned commits, and compares recordsets with the model's entities/);
  // An own manifest is checked in full, so there is nothing to leave to anyone.
  const own = manifestReport({});
  assert.deepEqual(own, { problems: [], notes: [] });
  // A refused shared manifest still carries its note, and the problems list stays what checkOvdbManifest returns.
  const refused = sharedReport((m) => { delete m.meaning.address; });
  assert.equal(refused.problems.length, 1);
  assert.equal(refused.notes.length, 1);
});

test('recordset names are checked in the shared form, where the model cannot be read', () => {
  const remote = (recordsets) => sharedManifest((m) => { m.recordsets = recordsets; });
  assert.equal(remote(['Album', 'Artist', '_Hidden', 'Track2']), '');
  assert.match(remote(['Album', 'Album']), /recordsets lists a name twice/);
  assert.match(remote([]), /recordsets must be a non-empty list/);
  assert.match(remote(['Album', 3]), /recordsets must be a non-empty list/);
  assert.match(remote(['Album', '']), /recordsets must be a non-empty list/);
  for (const bad of ['../../admin', 'a?b#c', 'x y', '1Album', 'chinook.Album', 'a-b']) {
    assert.match(remote(['Album', bad]), /recordsets names must look like ModelSpec entity names/, `name ${JSON.stringify(bad)}`);
  }
  // With local files the names are also compared with the model's entities.
  assert.match(withManifest((m) => { m.recordsets[0] = 'a b'; }), /recordsets names must look like ModelSpec entity names/);
  assert.match(withManifest((m) => { m.recordsets.pop(); }), /recordsets lacks ModelSpec entities: Track/);
});

test('model.hcl is the meaning file\'s models: entry for the module, a .modelspec.hcl file', () => {
  // Another tracked file with the right ending is still not the module's source.
  const copy = readFileSync(join(manifestRepo, 'model/chinook.modelspec.hcl'), 'utf8');
  assert.match(
    manifestProblems({ 'model/other.modelspec.hcl': copy, 'ovdb.yaml': stringifyYaml({ ...manifestDoc(), model: { ...manifestDoc().model, hcl: 'model/other.modelspec.hcl' } }) }),
    /model.hcl is model\/other.modelspec.hcl but the meaning file's models: entry for chinook is model\/chinook.modelspec.hcl/,
  );
  const meaningText = readFileSync(join(manifestRepo, 'model/chinook.meaning.yaml'), 'utf8');
  assert.match(
    manifestProblems({ 'model/chinook.meaning.yaml': meaningText.replace('  chinook: chinook.modelspec.hcl\n', '  other: chinook.modelspec.hcl\n') }),
    /the meaning file model\/chinook.meaning.yaml has no models: entry for module chinook/,
  );
  assert.equal(manifestProblems(), '');
});

test('a file that is too large, a missing HEAD and a missing repository are reported as what they are', () => {
  // Over 16 MB: reported once as too large, not as bad JSON or a missing module name.
  const big = `{"module":{"name":"chinook"},"pad":"${'x'.repeat(17 * 1024 * 1024)}"}`;
  const problems = manifestProblems({ 'model/chinook.modelspec.json': big });
  assert.match(problems, /model\/chinook.modelspec.json is larger than 16 MB/);
  assert.equal(problems.split('larger than 16 MB').length, 2, 'reported once');
  assert.doesNotMatch(problems, /not a ModelSpec JSON file|declares no module.name/);
  // A repository with no commit, and a directory that is not a repository.
  const unborn = join(scratch, `unborn-${scratchCount++}`);
  mkdirSync(unborn);
  gitIn(unborn, 'init', '-q', '-b', 'main');
  writeFileSync(join(unborn, 'OVDB.md'), read('OVDB.md'));
  gitIn(unborn, 'add', 'OVDB.md');
  const noCommit = checkOvdbManifest(gitRepoFiles(unborn)).join('\n');
  assert.match(noCommit, /git could not read HEAD of .*unborn-\d+: .*Is it a git repository with a commit\?/);
  assert.doesNotMatch(noCommit, /OVDB.md is missing/);
  const plain = join(scratch, `plain-${scratchCount++}`);
  mkdirSync(plain);
  writeFileSync(join(plain, 'OVDB.md'), read('OVDB.md'));
  const noRepo = checkOvdbManifest(gitRepoFiles(plain)).join('\n');
  assert.match(noRepo, /git could not read HEAD of .*plain-\d+: /);
  assert.doesNotMatch(noRepo, /OVDB.md is missing/);
});

test('git variables inherited from a hook never reach another repository', () => {
  // git sets GIT_DIR and GIT_INDEX_FILE for a hook it runs from a linked worktree. Point them at a decoy
  // repository and prove the manifest helpers neither read nor change it.
  const decoy = join(scratch, `decoy-${scratchCount++}`);
  mkdirSync(decoy);
  gitIn(decoy, 'init', '-q', '-b', 'decoy');
  writeFileSync(join(decoy, 'kept.txt'), 'kept');
  gitIn(decoy, 'add', 'kept.txt');
  commitAs(decoy, '-m', 'decoy commit');
  writeFileSync(join(decoy, 'staged.txt'), 'staged');
  gitIn(decoy, 'add', 'staged.txt');
  const snapshot = () => ({
    head: gitIn(decoy, 'rev-parse', 'HEAD'),
    branch: gitIn(decoy, 'rev-parse', '--abbrev-ref', 'HEAD'),
    commits: gitIn(decoy, 'rev-list', '--count', 'HEAD'),
    staged: gitIn(decoy, 'diff', '--cached', '--name-only'),
    index: readFileSync(join(decoy, '.git', 'index')).toString('hex'),
    tree: readdirSync(decoy).sort().join(','),
  });
  const before = snapshot();
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  Object.assign(process.env, { GIT_DIR: join(decoy, '.git'), GIT_INDEX_FILE: join(decoy, '.git', 'index'), GIT_WORK_TREE: decoy });
  try {
    // The test's own helper (commit, check, reset) and the checker, with the decoy in the environment.
    assert.equal(manifestProblems(), '');
    assert.match(manifestProblems({ 'ovdb.yaml': 'format: [broken' }), /ovdb.yaml: is not valid YAML/);
    assert.equal(manifestFiles.kind('ovdb.yaml'), 'file');
    assert.equal(manifestFiles.kind('kept.txt'), 'missing', 'the decoy is not the repository being read');
    assert.equal(gitIn(manifestRepo, 'rev-parse', '--show-toplevel'), realpathSync(manifestRepo));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.deepEqual(snapshot(), before, 'the decoy repository is untouched');
});

// examples/hoster: what someone who hosts their own copy of Chinook commits to their repository.
const exampleDir = join(root, 'examples', 'hoster');
const exampleRepository = 'https://github.com/example-co/chinook-hosting';
const examplePin = '8c9e62ed6641c0a00faa3867167d928af4c44b06'; // the commit of this repository that the three registries pin
const exampleRepo = (() => {
  const dir = join(scratch, `example-repo-${scratchCount++}`);
  mkdirSync(dir);
  for (const name of ['OVDB.md', 'ovdb.yaml']) copyFileSync(join(exampleDir, name), join(dir, name));
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '.');
  commitAs(dir, '-m', 'example');
  return dir;
})();
const atPin = (path) => exec('git', ['-C', root, 'show', `${examplePin}:${path}`], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).toString();
const exampleDoc = () => parseYaml(readFileSync(join(exampleDir, 'ovdb.yaml'), 'utf8'));

// The URL rules of the Directory's own checker (scripts/lib/urls.mjs and urlProblem in its directory.mjs), as far as
// they can be checked on the text: https, no credentials, query or fragment, a public-looking host (no IP address,
// no single label, no reserved or local zone), one canonical spelling.
const reservedZones = ['localhost', 'local', 'internal', 'localdomain', 'lan', 'home.arpa', 'arpa', 'intranet', 'corp', 'private', 'svc', 'home', 'test', 'example', 'invalid', 'onion'];
const directoryUrlProblem = (value, { template = false } = {}) => {
  const probe = template ? value.replace('{name}', 'name') : value;
  if (typeof value !== 'string' || /[\u0000- \u007f\\]/.test(value) || (template && value.split('{name}').length !== 2)) return 'is not a URL';
  if (template && value.indexOf('{name}') < value.indexOf('/', value.indexOf('//') + 2)) return '{name} outside the path';
  const url = new URL(probe);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || probe.includes('?') || url.hash || probe.includes('#')) return 'is not plain https';
  const host = url.hostname;
  if (host.includes(':') || host.endsWith('.') || /^\d+(\.\d+)*$/.test(host) || !host.includes('.') || host.split('.').includes('')) return 'is not a public host name';
  if (reservedZones.some((zone) => host === zone || host.endsWith(`.${zone}`))) return 'is in a reserved zone';
  if (url.pathname.includes('//') || url.href !== probe) return 'is not written canonically';
  return null;
};

test('examples/hoster is a valid shared manifest, pinned at the commit the registries pin, and agrees with the Directory\'s own fixture', () => {
  const report = reportOvdbManifest(gitRepoFiles(exampleRepo), { repository: exampleRepository });
  assert.deepEqual(report.problems, []);
  assert.equal(report.notes.length, 1, 'and it says the Directory checks the addresses');
  assert.match(report.notes[0], /The OVDB Directory checks both addresses against the ModelSpec registry and the MeaningGraph registry/);
  const { data } = parseFrontmatter(readFileSync(join(exampleDir, 'OVDB.md'), 'utf8'));
  assert.deepEqual(data, { ovdb: 1, publish: ['./ovdb.yaml'] });
  const doc = exampleDoc();

  // Field by field with the shared-form manifest of the Directory's test (hosterManifest in openvaultdb/directory
  // scripts/test.mjs): the same keys at every level, nothing more, and values of the same kind.
  assert.deepEqual(Object.keys(doc).sort(), ['deployment', 'description', 'format', 'homepage', 'id', 'licences', 'meaning', 'model', 'publisher', 'recordsets', 'title', 'url']);
  assert.deepEqual(Object.keys(doc.deployment).sort(), ['discovery', 'engine', 'recordset_page', 'url']);
  assert.deepEqual(Object.keys(doc.model), ['address']);
  assert.deepEqual(Object.keys(doc.meaning).sort(), ['address', 'file', 'graph']);
  assert.deepEqual(Object.keys(doc.meaning.graph), ['id']);
  assert.deepEqual(Object.keys(doc.publisher).sort(), ['name', 'repository', 'url']);
  assert.deepEqual(Object.keys(doc.licences), ['data']);
  assert.equal(doc.format, 'ovdb-manifest/draft-1');
  assert.match(doc.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'the Directory\'s id pattern');
  assert.ok(doc.id.length <= 80);
  assert.equal(doc.model.address, `modelspec://github.com/datatug/chinookdb/chinook?ref=${examplePin}`);
  assert.equal(doc.meaning.address, `meaning://github.com/datatug/chinookdb?ref=${examplePin}`);
  assert.equal(doc.meaning.file, 'model/chinook.meaning.yaml');
  assert.deepEqual(doc.meaning.graph, { id: 'chinook' });
  assert.equal(doc.licences.data, 'MIT');
  assert.equal(doc.publisher.repository, exampleRepository);
  assert.equal(doc.publisher.url, 'https://github.com/example-co');

  // The Directory's URL rules, and its rules for the canonical url and the discovery document.
  for (const [label, value] of [['url', doc.url], ['deployment.url', doc.deployment.url], ['deployment.discovery', doc.deployment.discovery], ['publisher.url', doc.publisher.url]]) {
    assert.equal(directoryUrlProblem(value), null, label);
  }
  assert.equal(directoryUrlProblem(doc.deployment.recordset_page, { template: true }), null, 'recordset_page');
  assert.equal(directoryUrlProblem(doc.homepage), null, 'homepage');
  assert.match(new URL(doc.homepage).hostname, /(^|\.)example\.com$/, 'a placeholder');
  assert.ok(!doc.url.endsWith('/'));
  const canonical = new URL(doc.url);
  assert.ok(canonical.pathname.split('/').includes('ovdb') || canonical.hostname.split('.').slice(0, -2).includes('ovdb'), 'ovdb as a path segment or a subdomain');
  assert.equal(new URL(doc.deployment.discovery).origin, canonical.origin, 'the discovery document is on the canonical origin');
  assert.equal(doc.deployment.discovery, `${canonical.origin}/.well-known/openvaultdb`);
  assert.match(doc.deployment.engine, /^[A-Za-z][A-Za-z0-9_.+-]{0,39}$/);
  assert.equal(doc.deployment.recordset_page.split('{name}').length, 2);

  // The pin: a commit of this repository, with the model and the meaning file the addresses name.
  assert.equal(exec('git', ['-C', root, 'cat-file', '-t', `${examplePin}^{commit}`], { stdio: 'pipe' }).toString().trim(), 'commit');
  exec('git', ['-C', root, 'merge-base', '--is-ancestor', examplePin, 'HEAD'], { stdio: 'pipe' }); // throws when the pin is not in this history
  const pinned = JSON.parse(atPin('model/chinook.modelspec.json'));
  assert.equal(pinned.module.name, 'chinook', 'the module of the address');
  assert.deepEqual([...doc.recordsets].sort(), Object.keys(pinned.entities).sort(), 'recordsets are exactly the entities of the model at the pin');
  assert.equal(parseYaml(atPin('model/chinook.meaning.yaml')).id, doc.meaning.graph.id, 'the meaning file at the pin is the graph the id names');
  assert.ok(atPin('model/chinook.modelspec.hcl').length > 0, 'the model source exists at the pin');

  // Placeholders are marked, and are example.com (which is nobody's) or an organisation named example-co.
  const text = readFileSync(join(exampleDir, 'ovdb.yaml'), 'utf8');
  assert.ok(text.split('PLACEHOLDER').length - 1 >= 6, 'each value to replace is marked');
  for (const value of [doc.url, doc.deployment.url, doc.deployment.discovery, doc.deployment.recordset_page]) {
    assert.match(new URL(value.replace('{name}', 'x')).hostname, /(^|\.)example\.com$/, value);
  }
  assert.match(readFileSync(join(exampleDir, 'OVDB.md'), 'utf8'), /placeholders/);
});

test('examples/hoster fails the checker when it is damaged the way a hoster could damage it', () => {
  const broken = (change, options = { repository: exampleRepository }) => {
    const doc = exampleDoc();
    change(doc);
    const dir = join(scratch, `example-broken-${scratchCount++}`);
    mkdirSync(dir);
    copyFileSync(join(exampleDir, 'OVDB.md'), join(dir, 'OVDB.md'));
    writeFileSync(join(dir, 'ovdb.yaml'), stringifyYaml(doc));
    gitIn(dir, 'init', '-q', '-b', 'main');
    gitIn(dir, 'add', '.');
    commitAs(dir, '-m', 'broken');
    return reportOvdbManifest(gitRepoFiles(dir), options).problems.join('\n');
  };
  assert.equal(broken(() => {}), '');
  assert.match(broken((d) => { d.model.address = d.model.address.replace(/\?ref=.*/, ''); }), /model.address must carry \?ref=<40 hex>/);
  assert.match(broken((d) => { d.meaning.address = d.meaning.address.replace(/\?ref=.*/, ''); }), /meaning.address must carry \?ref=<40 hex>/);
  assert.match(broken((d) => { delete d.meaning.address; }), /meaning.address is required/);
  assert.match(broken((d) => { d.model.modelspec = 'model/chinook.modelspec.json'; }), /model.hcl is required with local model files/);
  assert.match(broken((d) => { d.recordsets.pop(); d.recordsets.push('Album'); }), /recordsets lists a name twice/);
  assert.match(broken((d) => { d.publisher.repository = 'https://github.com/datatug/chinookdb'; }), /publisher.repository must be https:\/\/github.com\/example-co\/chinook-hosting/);
  assert.match(broken((d) => { d.publisher.repository = 'https://github.com/datatug/chinookdb'; d.publisher.url = 'https://github.com/datatug'; }, {}), /model.address .* names this repository/);
  assert.match(broken((d) => { d.url = 'https://example.com/dbs/chinook'; }), /url must have an ovdb path segment or an ovdb subdomain/);
});

test('the command line reports a manifest, and the notes of a shared one', () => {
  const run = (...args) => spawnSync(process.execPath, [join(root, 'scripts', 'check-ovdb-manifest.mjs'), ...args], { encoding: 'utf8', env: cleanGitEnv() });
  const shared = run('--repository', exampleRepository, exampleRepo);
  assert.equal(shared.status, 0, shared.stderr);
  assert.match(shared.stdout, /OVDB manifest check passed for .*example-repo-\d+ \(HEAD\)\./);
  assert.match(shared.stdout, /note: ovdb.yaml: shared model: this check is offline .* The OVDB Directory checks both addresses against the ModelSpec registry and the MeaningGraph registry/);
  const wrongRepository = run('--repository', 'https://github.com/someone/else', exampleRepo);
  assert.equal(wrongRepository.status, 1);
  assert.match(wrongRepository.stderr, /ovdb manifest: ovdb.yaml: publisher.repository must be https:\/\/github.com\/someone\/else, the repository this manifest is in/);
  const own = run('--repository', manifestRepository);
  assert.equal(own.status, 0, own.stderr);
  assert.doesNotMatch(own.stdout, /note:/, 'this repository\'s own manifest is checked in full');
  const plain = join(scratch, `plain-${scratchCount++}`);
  mkdirSync(plain);
  assert.equal(run(plain).status, 1);
  assert.equal(run('--bogus').status, 2);
  assert.equal(run('a', 'b').status, 2);
  assert.equal(run('--repository').status, 2);
});

test('the lint script and the drift guard act on their own repositories, whatever git variables a hook passes down', () => {
  // git sets GIT_DIR and GIT_INDEX_FILE for a hook it runs from a linked worktree; `git init` under GIT_DIR once set
  // core.bare = true in the repository the hook came from.
  const decoy = join(scratch, `decoy-${scratchCount++}`);
  mkdirSync(decoy);
  gitIn(decoy, 'init', '-q', '-b', 'decoy');
  writeFileSync(join(decoy, 'kept.txt'), 'kept');
  gitIn(decoy, 'add', 'kept.txt');
  commitAs(decoy, '-m', 'decoy commit');
  const snapshot = () => ({
    head: gitIn(decoy, 'rev-parse', 'HEAD'),
    bare: gitIn(decoy, 'config', 'core.bare'),
    config: readFileSync(join(decoy, '.git', 'config'), 'utf8'),
    index: readFileSync(join(decoy, '.git', 'index')).toString('hex'),
    tree: readdirSync(decoy).sort().join(','),
  });
  const before = snapshot();
  assert.equal(before.bare, 'false');
  const hook = { ...process.env, GIT_DIR: join(decoy, '.git'), GIT_INDEX_FILE: join(decoy, '.git', 'index') };

  // scripts/lint-modelspec.sh, with a stand-in for the specscore CLI that records the git variables it is started with.
  const log = join(scratch, `specscore-${scratchCount++}.log`);
  const fake = join(scratch, `specscore-${scratchCount++}`);
  writeFileSync(fake, `#!/bin/sh\necho "GIT_DIR=\${GIT_DIR-unset} GIT_INDEX_FILE=\${GIT_INDEX_FILE-unset} GIT_WORK_TREE=\${GIT_WORK_TREE-unset}" >> "${log}"\n[ "$1" = "--version" ] && echo "fake 0"\nexit 0\n`, { mode: 0o755 });
  const lint = spawnSync('bash', [join(root, 'scripts', 'lint-modelspec.sh')], { encoding: 'utf8', env: { ...hook, SPECSCORE: fake, TMPDIR: scratch } });
  assert.equal(lint.status, 0, lint.stderr);
  assert.match(lint.stdout, /ModelSpec lint passed/);
  const seen = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(seen.length >= 3, 'the CLI was started for init, new module, lint and version');
  assert.deepEqual([...new Set(seen)], ['GIT_DIR=unset GIT_INDEX_FILE=unset GIT_WORK_TREE=unset'], 'no git variable of the hook reaches the CLI');
  assert.deepEqual(snapshot(), before, 'the repository the hook came from is untouched by the lint script');

  // scripts/check-data-drift.mjs, in a repository of its own: it reads that repository's diff, not the hook's.
  const repo = join(scratch, `drift-${scratchCount++}`);
  mkdirSync(join(repo, 'public', 'data'), { recursive: true });
  writeFileSync(join(repo, 'public', 'data', 'chinook.json'), '{}');
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'add', '.');
  commitAs(repo, '-m', 'base');
  const base = gitIn(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'public', 'data', 'chinook.json'), '{"changed":true}');
  gitIn(repo, 'add', '.');
  commitAs(repo, '-m', 'data without checksums');
  const drift = (revision) => spawnSync(process.execPath, [join(root, 'scripts', 'check-data-drift.mjs'), revision], { encoding: 'utf8', cwd: repo, env: hook });
  const refused = drift(base);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /data drift: published data changed but public\/data\/.* did not/);
  assert.doesNotMatch(refused.stderr, /fatal|bad revision|ambiguous/, 'git read the repository of the script, not the hook\'s');
  writeFileSync(join(repo, 'README.md'), 'x');
  gitIn(repo, 'add', '.');
  commitAs(repo, '-m', 'readme only');
  const allowed = drift(gitIn(repo, 'rev-parse', 'HEAD~1'));
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /Data drift guard passed against .* \(1 changed files\)/);
  assert.equal(drift('0'.repeat(40)).status, 0, 'no base revision, nothing to compare');
  assert.deepEqual(snapshot(), before, 'the repository the hook came from is untouched by the drift guard');
});

test('the test helpers refuse to write outside a scratch repository', () => {
  assert.throws(() => assertScratch(root), /is not a scratch repository|inside the checkout/);
  assert.throws(() => assertScratch(tmpdir()), /not a scratch repository/);
  assert.doesNotThrow(() => assertScratch(manifestRepo));
});
