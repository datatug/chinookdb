// Tests for the deploy marker and the deploy workflow: node --test scripts/test-deploy.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUILD_INFO_FORMAT, FreshnessError, MARKER_PATH, buildInfo, compareBuild, expectOk, fetchJson, markerFacts, printable, shortCommit, verifyLive } from './lib/freshness.mjs';
import { writeBuildInfo } from './write-build-info.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const MARKER_URL = `https://site.test${MARKER_PATH}`;
const noSleep = async () => {};

// A fake fetch over {url: body | (call) => Response-like}. Counts calls per URL.
function fakeFetch(routes) {
  const calls = new Map();
  const impl = async url => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    const route = routes[url];
    if (route === undefined) return { ok: false, status: 404, text: async () => 'not found' };
    const answer = typeof route === 'function' ? route(calls.get(url)) : route;
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'number') return { ok: answer < 400, status: answer, text: async () => '' };
    return { ok: true, status: 200, text: async () => (typeof answer === 'string' ? answer : JSON.stringify(answer)) };
  };
  impl.calls = calls;
  return impl;
}

test('buildInfo records the commit, lower-cased, and refuses anything but a full commit id', () => {
  assert.deepEqual(buildInfo(COMMIT.toUpperCase()), { format: BUILD_INFO_FORMAT, commit: COMMIT });
  for (const bad of [undefined, '', 'abc', 'main', 'g'.repeat(40), `${COMMIT}0`]) {
    assert.throws(() => buildInfo(bad), error => error instanceof FreshnessError && /40-digit/.test(error.message), String(bad));
  }
});

test('writeBuildInfo writes dist/build-info.json and refuses to run without dist/', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chinook-marker-'));
  try {
    await assert.rejects(writeBuildInfo({ root: dir, commit: COMMIT }), /does not exist: run pnpm build first/);
    await mkdir(join(dir, 'dist'));
    const { file } = await writeBuildInfo({ root: dir, commit: COMMIT });
    assert.equal(file, join(dir, 'dist', 'build-info.json'));
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { format: BUILD_INFO_FORMAT, commit: COMMIT });
    await assert.rejects(writeBuildInfo({ root: dir, commit: 'main' }), /40-digit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the CLI exits 1 without BUILD_COMMIT and writes nothing', async () => {
  const run = spawnSync(process.execPath, ['scripts/write-build-info.mjs'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /40-digit/);
});

test('compareBuild: same commit is current, another commit or an unreadable marker is a change', () => {
  assert.deepEqual(compareBuild({ live: { commit: COMMIT }, commit: COMMIT }), { changed: false, reasons: [] });
  const other = compareBuild({ live: { commit: OTHER }, commit: COMMIT });
  assert.equal(other.changed, true);
  assert.match(other.reasons[0], /site commit bbbbbbbbbbbb is live, aaaaaaaaaaaa is current/);
  for (const live of [null, 'text', {}, { commit: 7 }]) assert.equal(compareBuild({ live, commit: COMMIT }).changed, true, JSON.stringify(live));
  assert.deepEqual(markerFacts({ commit: COMMIT }), { commit: COMMIT, checksums: {} });
});

test('fetchJson retries a 5xx and a network error, but not a 404 or rubbish', async () => {
  const flaky = fakeFetch({ 'https://x.test/a': n => (n === 1 ? 503 : n === 2 ? new Error('reset') : { ok: 1 }) });
  assert.deepEqual(await fetchJson(flaky, 'https://x.test/a', { sleep: noSleep }), { ok: 1 });
  assert.equal(flaky.calls.get('https://x.test/a'), 3);
  const missing = fakeFetch({});
  await assert.rejects(fetchJson(missing, 'https://x.test/b', { sleep: noSleep }), /HTTP 404/);
  assert.equal(missing.calls.get('https://x.test/b'), 1);
  await assert.rejects(fetchJson(fakeFetch({ 'https://x.test/c': '{broken' }), 'https://x.test/c', { sleep: noSleep }), /is not valid JSON/);
  const down = fakeFetch({ 'https://x.test/d': 502 });
  await assert.rejects(fetchJson(down, 'https://x.test/d', { sleep: noSleep }), /cannot fetch https:\/\/x\.test\/d: HTTP 502/);
  assert.equal(down.calls.get('https://x.test/d'), 3);
});

test('verifyLive: the live site serves the build at once or after a few attempts, and gives up with the reasons otherwise', async () => {
  const built = buildInfo(COMMIT);
  assert.deepEqual(await verifyLive({ fetch: fakeFetch({ [MARKER_URL]: { commit: COMMIT } }), markerUrl: MARKER_URL, built, sleep: noSleep }), { ok: true, reasons: [] });
  const slow = fakeFetch({ [MARKER_URL]: n => ({ commit: n < 3 ? OTHER : COMMIT }) });
  assert.equal((await verifyLive({ fetch: slow, markerUrl: MARKER_URL, built, sleep: noSleep })).ok, true);
  assert.equal(slow.calls.get(MARKER_URL), 3);
  const stale = fakeFetch({ [MARKER_URL]: { commit: OTHER } });
  const result = await verifyLive({ fetch: stale, markerUrl: MARKER_URL, built, delaysMs: [1, 1, 1], sleep: noSleep });
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /site commit bbbbbbbbbbbb is live/);
  assert.equal(stale.calls.get(MARKER_URL), 4, 'one read, then one per wait');
  const gone = await verifyLive({ fetch: fakeFetch({ [MARKER_URL]: 404 }), markerUrl: MARKER_URL, built, delaysMs: [1], sleep: noSleep });
  assert.equal(gone.ok, false);
  assert.match(gone.reasons[0], /HTTP 404/);
  assert.equal((await verifyLive({ fetch: fakeFetch({}), markerUrl: MARKER_URL, built: {}, sleep: noSleep })).ok, false);
});

// ---------------------------------------------------------------- values from public URLs

test('printable drops control characters and colon runs; commits print only with the right shape', () => {
  assert.equal(printable('z\n::error::x\r\u0007'), 'z  error x ');
  for (const text of ['::::warning::', ':::', ': ::: :', '\n::\n::']) assert.ok(!/::/.test(printable(text)), text);
  assert.equal(shortCommit(COMMIT), 'aaaaaaaaaaaa');
  assert.equal(shortCommit('z\n::error::x'), 'invalid');
  const hostile = compareBuild({ live: { commit: 'z\n::error::x' }, commit: COMMIT });
  assert.match(hostile.reasons[0], /site commit invalid is live/);
  assert.ok(!hostile.reasons.join('').includes('::'));
  assert.throws(() => buildInfo('z\n::error::x'), error => !/\n|::/.test(error.message));
});

test('expectOk retries with growing waits, then fails with a cleaned reason; verifyLive waits as long', async () => {
  const waits = [];
  const sleep = async ms => { waits.push(ms); };
  assert.deepEqual(await expectOk({ fetch: fakeFetch({ 'https://site.test/': n => (n < 3 ? 503 : { ok: 1 }) }), url: 'https://site.test/', sleep }), { ok: true, reason: '' });
  assert.deepEqual(waits, [5000, 10000]);
  waits.length = 0;
  const down = await expectOk({ fetch: fakeFetch({ 'https://site.test/': new Error('boom\n::error::x') }), url: 'https://site.test/', sleep });
  assert.equal(down.ok, false);
  assert.ok(!/\n|::/.test(down.reason));
  assert.deepEqual(waits, [5000, 10000, 15000, 20000, 30000, 30000, 30000], 'about two and a half minutes in all');
  waits.length = 0;
  const stale = await verifyLive({ fetch: fakeFetch({ [MARKER_URL]: { commit: OTHER } }), markerUrl: MARKER_URL, built: buildInfo(COMMIT), sleep });
  assert.equal(stale.ok, false);
  assert.equal(waits.reduce((a, b) => a + b, 0), 140_000);
});

// ---------------------------------------------------------------- the workflow

const clean = text => text.replace(/^[ \t]*#.*$/gm, '').replace(/[ \t]+#.*$/gm, '').replace(/\n{2,}/g, '\n');
const workflow = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8');
const code = clean(workflow);

/** The steps of the job as {name, uses, run, if, continueOnError, env, with, raw}. */
function parseSteps(text) {
  const start = text.indexOf('\n    steps:\n');
  assert.notEqual(start, -1, 'the job has steps');
  return text.slice(start + '\n    steps:\n'.length).split('\n      - ').map((piece, i) => {
    const lines = (i === 0 ? piece.replace(/^ {6}- /, '') : piece).split('\n');
    const step = { raw: lines.join('\n'), env: '', with: '', run: '' };
    let mode = '';
    for (const [n, line] of lines.entries()) {
      const at = n === 0 ? line : line.slice(8); // the lines after the first are indented by the width of "      - "
      const key = /^([a-z-]+):(?: (.*))?$/.exec(at);
      if (key) {
        mode = key[1];
        if (mode === 'run') step.run = key[2] === '|' ? '' : key[2];
        else if (mode !== 'env' && mode !== 'with') step[mode === 'continue-on-error' ? 'continueOnError' : mode] = key[2];
      } else if (mode === 'run') step.run += `${at.replace(/^ {2}/, '')}\n`;
      else if (mode === 'env' || mode === 'with') step[mode] += `${at}\n`;
    }
    return step;
  });
}
const steps = parseSteps(code);
const named = name => {
  const step = steps.find(candidate => candidate.name === name);
  assert.ok(step, `step ${name}`);
  return step;
};
const index = step => steps.indexOf(step);
const DEPLOYING = "env.DEPLOY_EVENT == 'true' && env.HAS_CREDENTIALS == 'true'";

test('the deploy workflow runs on pull requests, pushes to main and by hand, with read-only permissions', () => {
  assert.match(code, /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\npermissions:/m);
  assert.ok(!/schedule:/.test(code) && !/pull_request_target/.test(code), 'built from this repository alone: no schedule');
  assert.match(code, /^permissions:\n {2}contents: read$/m);
  assert.equal([...code.matchAll(/^\s*permissions:/gm)].length, 1);
  assert.ok(code.includes("if: github.repository == 'datatug/chinookdb'"));
});

test('every run that can deploy shares one group; a pull request or a manual run on another ref has its own and can never replace a pending run on main', () => {
  assert.ok(code.includes("group: ${{ (github.event_name == 'pull_request' || github.ref != 'refs/heads/main') && format('check-{0}', github.ref) || 'deploy' }}"));
  assert.match(code, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('every action is pinned by full commit SHA with its version in a comment, and nothing can fail silently', () => {
  const uses = steps.filter(step => step.uses);
  assert.ok(uses.length >= 4, 'checkout, pnpm, node, cache');
  for (const step of uses) assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, step.uses);
  for (const line of workflow.split('\n').filter(candidate => /^\s*- uses: /.test(candidate))) assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, 'the version is in a comment');
  assert.ok(!/continue-on-error/.test(code));
  assert.match(code, /persist-credentials: false/);
});

test('the deploy and the smoke check run only for a push to main or a manual run, and only with credentials; the token is in one step', () => {
  assert.ok(code.includes("DEPLOY_EVENT: ${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/main' }}"));
  assert.ok(code.includes("HAS_CREDENTIALS: ${{ secrets.CLOUDFLARE_API_TOKEN != '' && vars.CLOUDFLARE_ACCOUNT_ID != '' }}"));
  assert.equal(named('Deploy').if, DEPLOYING);
  assert.equal(named('Smoke check (the live site serves this build)').if, DEPLOYING);
  assert.equal(named('Deploy skipped, no credentials').if, "env.DEPLOY_EVENT == 'true' && env.HAS_CREDENTIALS != 'true'");
  assert.match(named('Deploy skipped, no credentials').run, /::notice::/);
  assert.match(named('Deploy skipped, no credentials').run, /GITHUB_STEP_SUMMARY/);
  assert.equal(named('Deploy').run.trim(), 'pnpm exec wrangler deploy --config wrangler.jsonc');
  assert.equal([...code.matchAll(/wrangler deploy/g)].length, 1, 'only the deploy step runs wrangler');
  assert.equal([...code.matchAll(/secrets\./g)].length, 2);
  assert.deepEqual(steps.filter(step => /CLOUDFLARE_/.test(step.env)).map(step => step.name), ['Deploy']);
  assert.match(named('Deploy').env, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.ok(!/echo[^\n]*\$\{?CLOUDFLARE_API_TOKEN/.test(code));
  assert.ok(index(named('Smoke check (the live site serves this build)')) > index(named('Deploy')));
});

test('the only expression that feeds a run: block goes through env', () => {
  for (const step of steps) assert.ok(!step.run.includes('${{'), `an expression inside run: of "${step.name ?? step.run.trim().split('\n')[0]}"`);
});

// ---- ci.yml and deploy.yml run the same checks ----

const ci = parseSteps(clean(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')));
/** What identifies a step: its action and settings, or its command; the name is compared when ci.yml gives one. */
// (deploy.yml adds persist-credentials: false to the checkout, and pins by SHA where ci.yml uses a tag.)
const identity = step => (step.uses ? `uses ${step.uses.replace(/@.*$/, '')} ${JSON.stringify(step.with.split('\n').filter(line => !/persist-credentials/.test(line)))}` : `run ${step.run.trim()}`);

test('deploy.yml runs every step of ci.yml, whatever its command, in the same order, unconditionally, and before the deploy', () => {
  const deploy = index(named('Deploy'));
  assert.ok(ci.length >= 18, 'ci.yml has its steps');
  for (const wanted of ['pnpm tools:install', 'pnpm lint:model', 'pnpm check:model-twin', 'pnpm check:meaning', 'pnpm test:tools']) assert.ok(ci.some((step) => step.run.trim() === wanted), `ci.yml runs ${wanted}`);
  let last = -1;
  for (const wanted of ci) {
    const mine = steps.find(step => identity(step) === identity(wanted));
    assert.ok(mine, `ci.yml has the step "${wanted.name ?? identity(wanted)}", deploy.yml does not`);
    if (wanted.name) assert.equal(mine.name, wanted.name, `the step has the same name in both: ${wanted.name}`);
    assert.equal(mine.if, wanted.if, `"${wanted.name ?? identity(wanted)}" has another condition in deploy.yml`);
    assert.equal(wanted.if, undefined, 'a ci.yml step has no condition');
    assert.equal(mine.continueOnError, undefined, `${mine.name ?? identity(mine)} can fail silently`);
    assert.equal(mine.env.replace(/ +/g, ' '), wanted.env.replace(/ +/g, ' '), `"${wanted.name ?? identity(wanted)}" has another environment in deploy.yml`);
    assert.ok(index(mine) > last, `"${mine.name ?? identity(mine)}" is out of order`);
    assert.ok(index(mine) < deploy, `"${mine.name ?? identity(mine)}" runs after the deploy`);
    last = index(mine);
  }
  assert.ok(index(named('Write the build marker')) > last, 'the marker is written after the checks');
  assert.ok(code.includes('fetch-depth: 0'), 'the drift guard needs the history');
});
