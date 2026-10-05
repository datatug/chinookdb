import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cleanGitEnv, isolatedGitEnv } from './lib/git-env.mjs';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { listDataFiles, listTrackedFiles, verifyChecksums } from './lib/checksums.mjs';
import { checkoutGit, coreRepo, createResolver, effectiveValues, indexConcepts, matchValues, parseConceptRef, parseModelRef, pinsOf, valueCoverageProblems } from './lib/meaning.mjs';
import { compareModelWithData, parseHcl, toModelspecJson, validateModel } from './lib/modelspec.mjs';
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
// Every process this file starts gets an environment without GIT_* variables (git sets GIT_DIR and
// GIT_INDEX_FILE for a hook it runs from a linked worktree) and without the configuration of the machine
// (a global commit.gpgsign or core.hooksPath must neither break nor run inside the suite): see isolatedGitEnv.
// Every git call names its repository with -C.
const exec = (command, args, options = {}) => execFileSync(command, args, { ...options, env: isolatedGitEnv() });
const plainRun = (command, args) => exec(command, args, { stdio: 'pipe' }).toString();
// The universal concepts and the schema come from one checkout of meaninggraph/core at the
// commit that the meaning file's references pin; the resolver returns its directory.
const resolve = createResolver({ root, run: plainRun });
after(() => resolve.dispose());
const [corePin] = pinsOf(meaning, coreRepo);
const coreIndex = resolve(coreRepo, corePin);
if (coreIndex.error) throw new Error(coreIndex.error);
const chinook = (doc = meaning) => indexConcepts([{ path: join(root, meaningPath), doc }]);
const clone = (value) => structuredClone(value);
const coreUrl = `meaning://${coreRepo}`;
const coreRef = (id, pin = corePin) => `${coreUrl}/${id}?ref=${pin}`;

// Where the network is not the point, a local git repository stands in for github.com.
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
  gitIn(dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'files');
  return { dir, url: `file://${dir}`, sha: gitIn(dir, 'rev-parse', 'HEAD') };
}
// A resolver that reads the universal concepts' address from a local repository instead of github.com.
const localResolver = (url, repo = coreRepo) => createResolver({ root, sources: { [repo]: { git: url } }, cacheDir: join(scratch, `cache-${scratchCount++}`), run: plainRun });
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

test('every concept links to the model, names its external source, or is derived from concepts that do', () => {
  // The meaning file is validated by the released meaninggraph tool (pnpm check:meaning); this is a rule it does not make.
  for (const concept of meaning.concepts) assert.ok(concept.bindings || concept.source || concept.measure?.inputs, `${concept.id} links to the model, names its external source, or is derived from concepts that do`);
});

test('every country spelling in the bound data columns names exactly one universal country', () => {
  assert.deepEqual(valueCoverageProblems({ local: chinook(), resolve, data }), []);
  assert.ok(data.Invoice.some((row) => row.BillingCountry === 'USA'), 'Chinook spells United States "USA"; the universal alias covers it');
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

test('every concept reference to meaninggraph/core pins one full commit, and the resolver reads that checkout', () => {
  const pins = pinsOf(meaning, coreRepo);
  assert.equal(pins.length, 1, `one pin for the repository, got ${JSON.stringify(pins)}`);
  assert.match(pins[0], /^[0-9a-f]{40}$/, 'a pin is a full commit id, never a branch or tag');
  assert.equal(corePin, pins[0]);
  assert.ok(read('README.md').includes(`\`${corePin}\``), 'the README names the pinned commit in full, so a pin bump updates it too');
  assert.ok(existsSync(join(coreIndex.dir, 'meaning.schema.json')), 'the resolver returns the directory of the pinned checkout');
  assert.ok(coreIndex.concepts.has('country') && coreIndex.concepts.has('currency'));
  assert.match(resolve(coreRepo, undefined).error, /read from git and needs a \?ref= pin/);
  assert.ok(!existsSync(join(root, 'model', 'vendor')), 'no vendored copy of the universal concepts');
});

test('the git source fails on a ?ref= that does not exist', () => {
  const nowhere = '0'.repeat(40);
  const origin = localOrigin({ 'a.meaning.yaml': 'format: meaning/draft-1\n' });
  const offline = localResolver(origin.url);
  const { error } = offline(coreRepo, nowhere);
  offline.dispose();
  // The message is the permanent failure of the repository, not a network error that merely looks like one.
  assert.match(error, new RegExp(`meaning://${coreRepo}\\?ref=${nowhere} cannot be read: cannot fetch ${nowhere} from ${origin.url}: .*(not our ref|couldn't find remote ref)`));
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
    'a meaning file hidden by .git/info/exclude': (k) => { mkdirSync(join(k, '.git', 'info'), { recursive: true }); appendFileSync(join(k, '.git', 'info', 'exclude'), 'evil.meaning.yaml\n'); writeFileSync(join(k, 'evil.meaning.yaml'), 'POISON\n'); },
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
      const work = args[args.indexOf('-C') + 1];
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
    const child = spawn(process.execPath, ['--input-type=module', '-e', loader, url, sha, cacheDir], { env: isolatedGitEnv(), stdio: 'pipe' });
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
  assert.deepEqual(calls.filter((args) => args.some((arg) => ['read-tree', 'checkout-index', 'fetch', 'init'].includes(arg)) || (args.includes('clean') && !args.includes('-n'))), [], 'nothing is written to an entry that is already the commit');
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
    if (args.includes('checkout') && !raced) { raced = true; exec('git', ['clone', '-q', args[args.indexOf('-C') + 1], kept2], { stdio: 'pipe' }); }
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

test('every git call of checkoutGit is hardened, and a cache entry cannot make git run its commands or read other objects', () => {
  const { url, sha } = localOrigin({ 'a.meaning.yaml': 'format: meaning/draft-1\n' });
  const hardening = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.useReplaceRefs=false'];
  // The calls: the flags in front of every one, no template for the new repository, and a url, ref or path only after --end-of-options.
  const cacheDir = join(scratch, `cache-${scratchCount++}`);
  const calls = [];
  const spy = (command, args) => { calls.push(args); return plainRun(command, args); };
  checkoutGit(url, sha, { cacheDir, run: spy });
  assert.ok(calls.length >= 6);
  for (const args of calls) assert.deepEqual(args.slice(0, hardening.length), hardening, args.join(' '));
  const init = calls.find((args) => args.includes('init'));
  assert.ok(init.includes('--template=') && init.indexOf('--end-of-options') > init.indexOf('--template=') && init.indexOf('--end-of-options') === init.length - 2, 'init: --template=, then --end-of-options, then the directory');
  const fetch = calls.find((args) => args.includes('fetch'));
  assert.deepEqual(fetch.slice(fetch.indexOf('--end-of-options')), ['--end-of-options', url, sha], 'fetch: the url and the ref only after --end-of-options');
  assert.deepEqual(calls.find((args) => args.includes('checkout')).slice(-2), ['--end-of-options', 'FETCH_HEAD']);
  const kept = join(cacheDir, sha);
  assert.ok(!existsSync(join(kept, '.git', 'hooks')), 'a repository made without a template has no sample hooks');

  // core.fsmonitor in the entry's own config: git status would run the command. Positive control first.
  const marker = join(scratch, `fsmonitor-ran-${scratchCount++}`);
  const monitor = join(scratch, `fsmonitor-${scratchCount++}.sh`);
  writeFileSync(monitor, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
  gitIn(kept, 'config', 'core.fsmonitor', monitor);
  try { plainRun('git', ['-C', kept, 'status', '--porcelain']); } catch { /* the command's answer is not the point */ }
  assert.ok(existsSync(marker), 'control: git status in the planted entry does run the command');
  rmSync(marker);
  assert.equal(checkoutGit(url, sha, { cacheDir, run: plainRun }).dir, kept);
  assert.ok(!existsSync(marker), 'checkoutGit never runs core.fsmonitor');

  // A replace ref in the entry: git would read another commit's tree for HEAD and "repair" the entry from it.
  const other = localOrigin({ 'a.meaning.yaml': 'POISON\n' });
  gitIn(kept, 'config', '--unset', 'core.fsmonitor');
  gitIn(kept, 'fetch', '-q', other.url, other.sha);
  gitIn(kept, 'replace', sha, other.sha);
  assert.notEqual(gitIn(kept, 'status', '--porcelain'), '', 'control: with the replace ref git reads the other commit as HEAD');
  assert.equal(checkoutGit(url, sha, { cacheDir, run: plainRun }).dir, kept);
  assert.equal(readFileSync(join(kept, 'a.meaning.yaml'), 'utf8'), 'format: meaning/draft-1\n', 'the replace ref did not change what the entry holds');

  // A hook: a core.hooksPath from the machine's own configuration, with a post-checkout hook that a fresh checkout would run.
  const hooks = join(scratch, `hooks-${scratchCount++}`);
  const hookMarker = join(scratch, `hook-ran-${scratchCount++}`);
  const globalConfig = join(scratch, `global-config-${scratchCount++}`);
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch "${hookMarker}"\n`, { mode: 0o755 });
  writeFileSync(globalConfig, `[core]\n\thooksPath = ${hooks}\n`);
  const withHooks = (command, args) => execFileSync(command, args, { env: { ...isolatedGitEnv(), GIT_CONFIG_GLOBAL: globalConfig }, stdio: 'pipe' }).toString();
  const control = join(scratch, `hook-control-${scratchCount++}`);
  mkdirSync(control);
  withHooks('git', ['-C', control, 'init', '-q', '-b', 'main']);
  withHooks('git', ['-C', control, 'fetch', '-q', url, sha]);
  withHooks('git', ['-C', control, 'checkout', '-q', 'FETCH_HEAD']);
  assert.ok(existsSync(hookMarker), 'control: git runs the post-checkout hook of core.hooksPath');
  rmSync(hookMarker);
  checkoutGit(url, sha, { cacheDir: join(scratch, `cache-${scratchCount++}`), run: withHooks });
  assert.ok(!existsSync(hookMarker), 'a fresh checkout runs no hook');
});

test('a cache entry that is a symbolic link is replaced, and what it points at is never touched', () => {
  const { url, sha } = localOrigin({ 'a.meaning.yaml': 'format: meaning/draft-1\n' });
  const elsewhere = join(scratch, `elsewhere-${scratchCount++}`);
  exec('git', ['clone', '-q', url, elsewhere], { stdio: 'pipe' });
  appendFileSync(join(elsewhere, 'a.meaning.yaml'), 'LOCAL EDIT\n');
  writeFileSync(join(elsewhere, 'precious.txt'), 'untracked and precious');
  const intact = () => {
    assert.equal(readFileSync(join(elsewhere, 'a.meaning.yaml'), 'utf8'), 'format: meaning/draft-1\nLOCAL EDIT\n', 'the target\'s edit survives');
    assert.equal(readFileSync(join(elsewhere, 'precious.txt'), 'utf8'), 'untracked and precious', 'the target\'s untracked file survives');
  };
  // The entry itself is a link to a checkout of the same commit.
  const cacheDir = join(scratch, `cache-${scratchCount++}`);
  mkdirSync(cacheDir);
  symlinkSync(elsewhere, join(cacheDir, sha));
  const { dir } = checkoutGit(url, sha, { cacheDir, run: plainRun });
  assert.equal(dir, join(cacheDir, sha));
  assert.ok(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), 'a real directory now');
  assert.equal(readFileSync(join(dir, 'a.meaning.yaml'), 'utf8'), 'format: meaning/draft-1\n');
  intact();
  // A dangling link, and a plain file, in the entry's place.
  for (const [name, make] of [['dangling link', (path) => symlinkSync(join(scratch, 'nowhere'), path)], ['file', (path) => writeFileSync(path, 'x')]]) {
    const cache = join(scratch, `cache-${scratchCount++}`);
    mkdirSync(cache);
    make(join(cache, sha));
    assert.ok(lstatSync(checkoutGit(url, sha, { cacheDir: cache, run: plainRun }).dir).isDirectory(), name);
    assert.deepEqual(readdirSync(cache), [sha], name);
  }
  // The entry is a real directory but its .git is a link to the other checkout's .git.
  const cache3 = join(scratch, `cache-${scratchCount++}`);
  mkdirSync(join(cache3, sha), { recursive: true });
  symlinkSync(join(elsewhere, '.git'), join(cache3, sha, '.git'));
  const replaced = checkoutGit(url, sha, { cacheDir: cache3, run: plainRun }).dir;
  assert.ok(lstatSync(join(replaced, '.git')).isDirectory() && !lstatSync(join(replaced, '.git')).isSymbolicLink());
  assert.deepEqual(readdirSync(cache3), [sha]);
  intact();
  assert.equal(gitIn(elsewhere, 'rev-parse', 'HEAD'), sha, 'and the target repository still has its HEAD');
});

test('an entry is removed only when this process examined it and condemned it', () => {
  const { url, sha } = localOrigin({ 'a.meaning.yaml': 'format: meaning/draft-1\n' });
  const cacheDir = join(scratch, `cache-${scratchCount++}`);
  const kept = join(cacheDir, sha);
  checkoutGit(url, sha, { cacheDir, run: plainRun });
  // The entry is broken (HEAD names nothing), so this process condemns it ...
  writeFileSync(join(kept, '.git', 'HEAD'), 'ref: refs/heads/nowhere\n');
  const calls = [];
  const run = (command, args) => { calls.push(args); return plainRun(command, args); };
  // ... and between the verdict and the removal another process replaces it with a good entry and starts reading it.
  let replaced = 0;
  const onCondemned = (dir) => {
    assert.equal(dir, kept);
    replaced += 1;
    renameSync(kept, join(scratch, `broken-${scratchCount++}`));
    exec('git', ['clone', '-q', url, kept], { stdio: 'pipe' });
    writeFileSync(join(kept, '.git', 'marker'), 'the good entry another process is reading');
  };
  const { dir } = checkoutGit(url, sha, { cacheDir, run, onCondemned, retryDelayMs: 1 });
  assert.equal(replaced, 1);
  assert.equal(dir, kept);
  assert.equal(readFileSync(join(kept, '.git', 'marker'), 'utf8'), 'the good entry another process is reading', 'the good entry was not removed');
  assert.equal(readFileSync(join(kept, 'a.meaning.yaml'), 'utf8'), 'format: meaning/draft-1\n');
  assert.deepEqual(calls.filter((args) => args.includes('fetch')), [], 'it was adopted, not fetched again');
  assert.deepEqual(readdirSync(cacheDir), [sha], 'and nothing is left aside');

  // The condemned entry itself is removed, and the replacement is fetched.
  writeFileSync(join(kept, '.git', 'HEAD'), 'ref: refs/heads/nowhere\n');
  writeFileSync(join(kept, '.git', 'marker'), 'the condemned entry');
  checkoutGit(url, sha, { cacheDir, run: plainRun });
  assert.ok(!existsSync(join(kept, '.git', 'marker')));
  assert.deepEqual(readdirSync(cacheDir), [sha]);

  // A rename that fails is reported as what it is, not swallowed: here the cache directory cannot be written to.
  writeFileSync(join(kept, '.git', 'HEAD'), 'ref: refs/heads/nowhere\n');
  chmodSync(cacheDir, 0o555);
  try {
    assert.throws(() => checkoutGit(url, sha, { cacheDir, run: plainRun, retryDelayMs: 1 }), /cannot move the unusable cache entry .* aside: .*(EACCES|EPERM)/);
  } finally {
    chmodSync(cacheDir, 0o755);
  }
  assert.ok(existsSync(kept), 'and the entry stays where it was');
});

test('leftovers of a crash are swept from the cache: parked entries of a dead process or older than ten minutes, and work directories nobody has touched for an hour', () => {
  const { url, sha } = localOrigin({ 'a.meaning.yaml': 'format: meaning/draft-1\n' });
  const cacheDir = join(scratch, `cache-${scratchCount++}`);
  checkoutGit(url, sha, { cacheDir, run: plainRun });
  // A process that has exited: its pid is not alive (spawnSync waits for it).
  const deadPid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  assert.throws(() => process.kill(deadPid, 0), /ESRCH/, 'control: the pid is dead');
  const now = Date.now();
  const parked = {
    [`.discard-${deadPid}-${now}-dead`]: 'swept: its process is gone',
    [`.discard-${process.pid}-${now - 11 * 60 * 1000}-old`]: 'swept: older than ten minutes',
    [`.discard-${process.pid}-${now}-mine`]: 'kept: a live process may be about to put it back',
    [`.discard-${process.ppid}-${now - 5 * 60 * 1000}-parent`]: 'kept: another live process, young',
  };
  for (const name of [...Object.keys(parked), '.discard-1-x', '.meaning-source-old', '.meaning-source-fresh']) {
    mkdirSync(join(cacheDir, name));
    writeFileSync(join(cacheDir, name, 'file'), 'x');
  }
  const longAgo = new Date(now - 2 * 60 * 60 * 1000);
  utimesSync(join(cacheDir, '.meaning-source-old'), longAgo, longAgo);
  assert.equal(checkoutGit(url, sha, { cacheDir, run: plainRun }).dir, join(cacheDir, sha));
  assert.deepEqual(readdirSync(cacheDir).sort(), [`.discard-${process.pid}-${now}-mine`, `.discard-${process.ppid}-${now - 5 * 60 * 1000}-parent`, '.discard-1-x', '.meaning-source-fresh', sha].sort(), 'a parked entry of a live process stays while it is young; so does a work directory that may be in use');
  // A name this code does not make is judged by its age alone.
  utimesSync(join(cacheDir, '.discard-1-x'), longAgo, longAgo);
  assert.equal(checkoutGit(url, sha, { cacheDir, run: plainRun, staleMs: -1, discardStaleMs: 60 * 1000 }).dir, join(cacheDir, sha));
  assert.deepEqual(readdirSync(cacheDir).sort(), [`.discard-${process.pid}-${now}-mine`, sha].sort(), 'with a limit of a minute the five-minute-old one goes, the fresh one stays');
  assert.equal(checkoutGit(url, sha, { cacheDir, run: plainRun, discardStaleMs: -1 }).dir, join(cacheDir, sha));
  assert.deepEqual(readdirSync(cacheDir), [sha]);
});

test('a sweep by another process never removes the entry this one has parked and is about to put back', () => {
  const { url, sha } = localOrigin({ 'a.meaning.yaml': 'format: meaning/draft-1\n' });
  const cacheDir = join(scratch, `cache-${scratchCount++}`);
  const kept = join(cacheDir, sha);
  checkoutGit(url, sha, { cacheDir, run: plainRun });
  writeFileSync(join(kept, '.git', 'HEAD'), 'ref: refs/heads/nowhere\n');
  // Process 1 condemns the entry; process 2 replaces it with a good one and reads it; process 1 parks that good entry (it is not the one
  // it examined); process 3 enters checkoutGit, which sweeps, between the parking and the comparison.
  const onCondemned = () => {
    renameSync(kept, join(scratch, `broken-${scratchCount++}`));
    exec('git', ['clone', '-q', url, kept], { stdio: 'pipe' });
    writeFileSync(join(kept, '.git', 'marker'), 'the good entry process 2 is reading');
  };
  let parkedAs;
  const onParked = (aside) => {
    parkedAs = aside;
    assert.ok(existsSync(join(aside, '.git', 'marker')), 'the good entry is parked');
    // Process 3 (this process, another call: the parked name carries a live pid and is young): it sweeps on entry, and fills the
    // entry itself, as a process that finds none does.
    assert.equal(checkoutGit(url, sha, { cacheDir, run: plainRun }).dir, kept);
    assert.ok(existsSync(join(aside, '.git', 'marker')), 'the sweep of process 3 left the parked entry alone');
  };
  assert.equal(checkoutGit(url, sha, { cacheDir, run: plainRun, onCondemned, onParked }).dir, kept);
  assert.ok(parkedAs);
  assert.ok(existsSync(join(parkedAs, '.git', 'marker')), 'the good entry is still there: it could not be put back over process 3\'s entry, and it was not swept');
  assert.equal(readdirSync(cacheDir).filter((name) => name.startsWith('.discard-')).length, 1, 'one duplicate, left for a later sweep');

  // Without the nested call: the good entry is put back, and nothing is left aside.
  const cache2 = join(scratch, `cache-${scratchCount++}`);
  const kept2 = join(cache2, sha);
  checkoutGit(url, sha, { cacheDir: cache2, run: plainRun });
  writeFileSync(join(kept2, '.git', 'HEAD'), 'ref: refs/heads/nowhere\n');
  const replace2 = () => {
    renameSync(kept2, join(scratch, `broken-${scratchCount++}`));
    exec('git', ['clone', '-q', url, kept2], { stdio: 'pipe' });
    writeFileSync(join(kept2, '.git', 'marker'), 'the good entry');
  };
  const { dir } = checkoutGit(url, sha, { cacheDir: cache2, run: plainRun, onCondemned: replace2 });
  assert.equal(dir, kept2);
  assert.equal(readFileSync(join(kept2, '.git', 'marker'), 'utf8'), 'the good entry', 'put back untouched');
  assert.deepEqual(readdirSync(cache2), [sha]);

  // The parked entry vanishes before the comparison (a sweep that did not wait): "gone", and the entry is fetched anew; no bare ENOENT.
  const cache3 = join(scratch, `cache-${scratchCount++}`);
  const kept3 = join(cache3, sha);
  checkoutGit(url, sha, { cacheDir: cache3, run: plainRun });
  writeFileSync(join(kept3, '.git', 'HEAD'), 'ref: refs/heads/nowhere\n');
  const result = checkoutGit(url, sha, { cacheDir: cache3, run: plainRun, onParked: (aside) => rmSync(aside, { recursive: true, force: true }) });
  assert.equal(result.dir, kept3);
  assert.equal(readFileSync(join(kept3, 'a.meaning.yaml'), 'utf8'), 'format: meaning/draft-1\n');
  assert.deepEqual(readdirSync(cache3), [sha]);

  // It vanishes between the comparison and the put-back: a clear message, not a bare ENOENT from lstat or rename.
  const cache4 = join(scratch, `cache-${scratchCount++}`);
  const kept4 = join(cache4, sha);
  checkoutGit(url, sha, { cacheDir: cache4, run: plainRun });
  writeFileSync(join(kept4, '.git', 'HEAD'), 'ref: refs/heads/nowhere\n');
  const replace4 = () => {
    renameSync(kept4, join(scratch, `broken-${scratchCount++}`));
    exec('git', ['clone', '-q', url, kept4], { stdio: 'pipe' });
  };
  // The fault is injected where the put-back is made: the cache directory stops being writable after the entry was parked.
  assert.throws(() => checkoutGit(url, sha, { cacheDir: cache4, run: plainRun, onCondemned: replace4, onParked: () => chmodSync(cache4, 0o555) }), /cannot put the cache entry .* back from .*: .*(EACCES|EPERM|operation not permitted|permission denied)/i);
  chmodSync(cache4, 0o755);
});

test('the suite\'s git calls ignore the configuration of the machine: a global commit.gpgsign or core.hooksPath neither breaks nor runs', () => {
  const home = join(scratch, `home-${scratchCount++}`);
  const hooks = join(scratch, `global-hooks-${scratchCount++}`);
  const ran = join(scratch, `global-hook-ran-${scratchCount++}`);
  mkdirSync(home);
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch "${ran}"\n`, { mode: 0o755 });
  writeFileSync(join(home, '.gitconfig'), `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n[core]\n\thooksPath = ${hooks}\n`);
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
  delete process.env.GIT_CONFIG_GLOBAL;
  try {
    // Control: a plain git, with this environment but not the suite's, is broken by the decoy and runs its hook.
    const repo = join(scratch, `decoy-config-${scratchCount++}`);
    mkdirSync(repo);
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env: cleanGitEnv(), stdio: 'pipe' });
    assert.throws(() => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x'], { env: cleanGitEnv(), stdio: 'pipe' }), 'control: the decoy config breaks a commit');
    assert.ok(existsSync(ran), 'control: and the global hook ran');
    rmSync(ran);
    // The suite's helpers: the same operations work, and no hook runs.
    const origin = localOrigin({ 'a.meaning.yaml': 'format: meaning/draft-1\n' });
    commitAs(origin.dir, '-m', 'another');
    assert.match(gitIn(origin.dir, 'log', '--format=%s', '-1'), /another/);
    const cacheDir = join(scratch, `cache-${scratchCount++}`);
    checkoutGit(origin.url, origin.sha, { cacheDir, run: plainRun });
    assert.ok(!existsSync(ran), 'no global hook ran in the suite');
    assert.equal(isolatedGitEnv().GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(isolatedGitEnv().GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(isolatedGitEnv({ GIT_DIR: '/x', PATH: process.env.PATH }).GIT_DIR, undefined, 'and the GIT_* variables of a hook are still dropped');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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

test('values come from values-of only, never through extends', () => {
  const local = chinook();
  const billing = local.concepts.get('billing-country').concept;
  assert.equal(effectiveValues(billing, local, resolve).length, 24, 'billing-country holds the universal countries');
  const { 'values-of': _, ...withoutValuesOf } = billing;
  assert.deepEqual(effectiveValues({ ...withoutValuesOf, extends: coreRef('date') }, local, resolve), [], 'extends passes no values');
});

test('music-sales binds only the measure\'s own column; the price and quantity it is computed from are inputs', () => {
  const sales = meaning.concepts.find((c) => c.id === 'music-sales');
  assert.deepEqual(sales.bindings.map((b) => `${parseModelRef(b.model).name}.${b.property} ${b.role}`), ['Invoice.Total value']);
  assert.deepEqual(sales.measure.inputs, ['invoice-total', 'unit-price', 'quantity']);
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

// Helpers of the git tests below (the drift guard, the checksums): a commit in a scratch repository, and the guard that refuses to write or reset anywhere else.
const commitAs = (dir, ...args) => gitIn(dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', ...args);
const assertScratch = (dir) => {
  const inside = (parent, child) => !relative(realpathSync(parent), realpathSync(child)).startsWith('..');
  assert.ok(inside(scratch, dir) && dir !== scratch, `${dir} is not a scratch repository under ${scratch}`);
  assert.ok(inside(realpathSync(tmpdir()), dir), `${dir} is not under the temp directory`);
  assert.ok(!inside(root, dir), `${dir} is inside the checkout`);
  assert.equal(realpathSync(gitIn(dir, 'rev-parse', '--show-toplevel')), realpathSync(dir), `${dir} is not the top of its own repository`);
};

test('the drift guard acts on its own repository, whatever git variables a hook passes down', () => {
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
  const hook = { ...isolatedGitEnv(), GIT_DIR: join(decoy, '.git'), GIT_INDEX_FILE: join(decoy, '.git', 'index') };

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
  const own = join(scratch, `own-${scratchCount++}`);
  mkdirSync(own);
  gitIn(own, 'init', '-q', '-b', 'main');
  assert.doesNotThrow(() => assertScratch(own));
});
