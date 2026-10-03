// Tests for the deploy marker and the deploy workflow: node --test scripts/test-deploy.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUILD_INFO_FORMAT, FreshnessError, MARKER_PATH, buildInfo, compareBuild, fetchJson, markerFacts, verifyLive } from './lib/freshness.mjs';
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
  const result = await verifyLive({ fetch: stale, markerUrl: MARKER_URL, built, attempts: 4, sleep: noSleep });
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /site commit bbbbbbbbbbbb is live/);
  assert.equal(stale.calls.get(MARKER_URL), 4);
  const gone = await verifyLive({ fetch: fakeFetch({ [MARKER_URL]: 404 }), markerUrl: MARKER_URL, built, attempts: 2, sleep: noSleep });
  assert.equal(gone.ok, false);
  assert.match(gone.reasons[0], /HTTP 404/);
  assert.equal((await verifyLive({ fetch: fakeFetch({}), markerUrl: MARKER_URL, built: {}, sleep: noSleep })).ok, false);
});

// ---------------------------------------------------------------- the workflow

const workflow = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8');
const code = workflow.replace(/^[ \t]*#.*$/gm, '').replace(/[ \t]+#.*$/gm, '').replace(/\n{2,}/g, '\n');
const stepText = name => {
  const start = code.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `step ${name}`);
  const next = code.indexOf('\n      - ', start + 1);
  return code.slice(start, next === -1 ? undefined : next);
};

test('the deploy workflow runs on pull requests, pushes to main and by hand, with read-only permissions and one deploy at a time', () => {
  assert.match(code, /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\njobs|^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\npermissions:/m);
  assert.ok(!/schedule:/.test(code) && !/pull_request_target/.test(code), 'built from this repository alone: no schedule');
  assert.match(code, /^permissions:\n {2}contents: read$/m);
  assert.equal([...code.matchAll(/^\s*permissions:/gm)].length, 1);
  assert.ok(code.includes("if: github.repository == 'datatug/chinookdb'"));
  assert.match(code, /group: \$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.ref\) \|\| 'deploy' \}\}/);
  assert.match(code, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test('the deploy and the smoke check run only for a push to main or a manual run, and only with credentials', () => {
  assert.ok(code.includes("DEPLOY_EVENT: ${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/main' }}"));
  assert.ok(code.includes("HAS_CREDENTIALS: ${{ secrets.CLOUDFLARE_API_TOKEN != '' && vars.CLOUDFLARE_ACCOUNT_ID != '' }}"));
  for (const name of ['Deploy', 'Smoke check (the live site serves this build)']) {
    assert.match(stepText(name), /if: env\.DEPLOY_EVENT == 'true' && env\.HAS_CREDENTIALS == 'true'/, name);
  }
  assert.match(stepText('Deploy skipped, no credentials'), /if: env\.DEPLOY_EVENT == 'true' && env\.HAS_CREDENTIALS != 'true'/);
  assert.match(stepText('Deploy skipped, no credentials'), /::notice::/);
  assert.match(stepText('Deploy skipped, no credentials'), /GITHUB_STEP_SUMMARY/);
  assert.match(stepText('Deploy'), /run: pnpm exec wrangler deploy --config wrangler\.jsonc$/m);
  assert.equal([...code.matchAll(/wrangler deploy/g)].length, 1, 'only the deploy step runs wrangler');
  // the token is read in two places only and never echoed
  assert.equal([...code.matchAll(/secrets\./g)].length, 2);
  assert.match(stepText('Deploy'), /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.ok(!/echo[^\n]*\$\{?CLOUDFLARE_API_TOKEN/.test(code));
});

test('the workflow repeats every check of ci.yml before it deploys, in the same order', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace(/^[ \t]*#.*$/gm, '');
  const commands = text => [...text.matchAll(/^\s+(?:- )?run: (pnpm [^\n]+)$/gm)].map(match => match[1]);
  const mine = commands(code);
  const theirs = commands(ci);
  assert.ok(theirs.length >= 6);
  for (const command of theirs) assert.ok(mine.includes(command), `ci.yml runs ${command}, this workflow does not`);
  assert.deepEqual(mine.filter(command => theirs.includes(command)), theirs, 'the same order');
  assert.ok(code.indexOf('pnpm test:worker') < code.indexOf('- name: Write the build marker'), 'the marker is written after the checks');
  assert.ok(code.includes('fetch-depth: 0'), 'the drift guard needs the history');
});
