import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cleanGitEnv } from './lib/git-env.mjs';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { listDataFiles, listTrackedFiles, verifyChecksums } from './lib/checksums.mjs';
import { checkMeaning, checkoutGit, coreRepo, createResolver, effectiveValues, indexConcepts, loadMeaningDir, matchValues, parseConceptRef, parseModelRef, pinsOf, valueCoverageProblems } from './lib/meaning.mjs';
import { compareModelWithData, parseHcl, toModelspecJson, validateModel } from './lib/modelspec.mjs';
import { checkOvdbManifest, gitRepoFiles, parseFrontmatter } from './lib/ovdb-manifest.mjs';
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
const manifestProblems = (changes = {}, options = { repository: manifestRepository }) => {
  assertScratch(manifestRepo);
  for (const [path, text] of Object.entries(changes)) writeFileSync(join(manifestRepo, path), text);
  gitIn(manifestRepo, 'add', '--', ...Object.keys(changes));
  commitAs(manifestRepo, '-m', 'case');
  try {
    return checkOvdbManifest(manifestFiles, options).join('\n');
  } finally {
    assertScratch(manifestRepo);
    gitIn(manifestRepo, 'reset', '-q', '--hard', 'HEAD~1');
  }
};
const manifestDoc = () => parseYaml(read('ovdb.yaml'));
const withManifest = (change) => {
  const doc = manifestDoc();
  change(doc);
  return manifestProblems({ 'ovdb.yaml': stringifyYaml(doc) });
};
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
  // Another repository: no local files, a ref is required, and the recordsets are not checked against files.
  const remote = (change = () => {}) => withManifest((m) => {
    delete m.model.modelspec;
    delete m.model.hcl;
    m.model.address = `modelspec://github.com/datatug/chinookdb/chinook?ref=${pin}`;
    change(m);
  });
  assert.equal(remote(), '');
  assert.match(remote((m) => { m.model.address = 'modelspec://github.com/datatug/chinookdb/chinook'; }), /model.address must carry \?ref=<40 hex> when the model is not in this repository/);
  assert.match(remote((m) => { delete m.model.address; }), /model must name the model by local files .* or by model.address/);
  assert.match(remote((m) => { m.model = {}; }), /model must name the model by local files/);
  assert.match(remote((m) => { m.recordsets = []; }), /recordsets must be a non-empty list/);
  assert.match(remote((m) => { m.model.hcl = 'model/chinook.modelspec.hcl'; }), /model.modelspec is required with local model files/);
  assert.match(withManifest((m) => { m.model.address = 5; }), /model.address must be modelspec:/);
});

test('the address grammar follows GitHub names and ModelSpec module names', () => {
  const pin = 'b'.repeat(40);
  // Address-only, so the exact-match rule for local files cannot hide a loose grammar.
  const remote = (address) => withManifest((m) => {
    delete m.model.modelspec;
    delete m.model.hcl;
    m.model.address = address;
  });
  assert.equal(remote(`modelspec://github.com/acme/chinook-hoster/chinook?ref=${pin}`), '');
  assert.equal(remote(`modelspec://github.com/acme/my.repo_1-x/model_2?ref=${pin}`), '');
  for (const bad of [
    'chinook.Customer', 'chinook.', '.chinook', 'Chinook', '1chinook', 'chinook-x', 'chinook.x.y',
  ]) {
    assert.match(remote(`modelspec://github.com/datatug/chinookdb/${bad}?ref=${pin}`), /model.address must be modelspec:\/\/github.com\/<org>\/<repository>\/<module>/, `module ${bad}`);
  }
  for (const bad of ['..', '.', '---', '...', 'chinookdb.git', '.hidden', 'a.git', '']) {
    assert.match(remote(`modelspec://github.com/datatug/${bad}/chinook?ref=${pin}`), /model.address must be modelspec:\/\/github.com\/<org>\/<repository>\/<module>/, `repository ${JSON.stringify(bad)}`);
  }
  for (const bad of ['..', '.', '-x', 'a.b', 'a_b', '']) {
    assert.match(remote(`modelspec://github.com/${bad}/chinookdb/chinook?ref=${pin}`), /model.address must be modelspec:\/\/github.com\/<org>\/<repository>\/<module>/, `owner ${JSON.stringify(bad)}`);
  }
  // publisher.repository follows the same repository-name rule.
  assert.match(withManifest((m) => { m.publisher.repository = 'https://github.com/datatug/..'; }), /publisher.repository must be https:\/\/github.com\/<owner>\/<repository>/);
  assert.match(withManifest((m) => { m.publisher.repository = 'https://github.com/datatug/chinookdb.git'; }), /publisher.repository must be https:\/\/github.com\/<owner>\/<repository>/);
});

test('recordset names are checked even when the model is in another repository', () => {
  const pin = 'c'.repeat(40);
  const remote = (recordsets) => withManifest((m) => {
    delete m.model.modelspec;
    delete m.model.hcl;
    m.model.address = `modelspec://github.com/acme/other/chinook?ref=${pin}`;
    m.recordsets = recordsets;
  });
  assert.equal(remote(['Album', 'Artist', '_Hidden', 'Track2']), '');
  assert.match(remote(['Album', 'Album']), /recordsets lists a name twice/);
  for (const bad of ['../../admin', 'a?b#c', 'x y', '1Album', 'chinook.Album', 'a-b']) {
    assert.match(remote(['Album', bad]), /recordsets names must look like ModelSpec entity names/, `name ${JSON.stringify(bad)}`);
  }
  // With local files the names are also compared with the model's entities.
  assert.match(withManifest((m) => { m.recordsets[0] = 'a b'; }), /recordsets names must look like ModelSpec entity names/);
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

test('the test helpers refuse to write outside a scratch repository', () => {
  assert.throws(() => assertScratch(root), /is not a scratch repository|inside the checkout/);
  assert.throws(() => assertScratch(tmpdir()), /not a scratch repository/);
  assert.doesNotThrow(() => assertScratch(manifestRepo));
});
