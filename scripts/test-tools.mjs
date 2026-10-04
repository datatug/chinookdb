// Tests for the pinned tools (modelspec, meaninggraph), their installer, and the workflows that run them:
// node --test scripts/test-tools.mjs. No network unless CHINOOK_TOOLS_ONLINE=1 (then every pinned archive is
// downloaded and its SHA-256 compared with scripts/tools.json).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { checkInvocations, corePin, main as checkMeaning, meaningFile, ownAddress } from './check-meaning.mjs';
import { main as install, parseArguments } from './install-tools.mjs';
import { cleanGitEnv, isolatedGitEnv } from './lib/git-env.mjs';
import { coreRepo, createResolver } from './lib/meaning.mjs';
import { ToolsError, archiveName, download, installTool, loadPins, locateTool, platformKey, platforms, releaseUrl, root, runTool, sha256Hex } from './lib/tools.mjs';
import { main as run } from './run-tool.mjs';

const read = (path) => readFileSync(join(root, path), 'utf8');
const pins = loadPins();
const scratch = mkdtempSync(join(tmpdir(), 'chinook-tools-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;
const fresh = (name) => join(scratch, `${name}-${count++}`);

/** A real .tar.gz holding one executable file, as a release archive does, and its bytes. */
function archiveOf(name, content = '#!/bin/sh\necho fake\n') {
  const dir = fresh('archive');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', name), content, { mode: 0o755 });
  writeFileSync(join(dir, 'src', 'README.md'), 'readme');
  execFileSync('tar', ['-czf', join(dir, 'a.tar.gz'), '-C', join(dir, 'src'), name, 'README.md']);
  return readFileSync(join(dir, 'a.tar.gz'));
}
/** Pins for a tool whose linux_amd64 archive is `bytes`. */
const pinFor = (name, bytes, version = '1.2.3') => ({ format: 'chinookdb-tools/1', tools: { [name]: { version, repository: 'acme/cli', sha256: Object.fromEntries(platforms.map((platform) => [platform, platform === 'linux_amd64' ? sha256Hex(bytes) : 'f'.repeat(64)])) } } });
const never = (what) => () => { throw new Error(`${what} must not be called`); };
/** What the installer leaves for a real pinned tool on this platform, without downloading: the binary and its receipt. */
function fakeInstall(binDir, name, content = '#!/bin/sh\nexit 0\n') {
  const key = platformKey();
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, name), content, { mode: 0o755 });
  writeFileSync(join(binDir, `${name}.receipt.json`), JSON.stringify({ tool: name, version: pins.tools[name].version, platform: key, archiveSha256: pins.tools[name].sha256[key], binarySha256: sha256Hex(content) }));
}

// ---------------------------------------------------------------- the pins

test('both tools are pinned to a release number and a SHA-256 for every platform, in one file', () => {
  assert.deepEqual(Object.keys(pins.tools).sort(), ['meaninggraph', 'modelspec']);
  for (const [name, pin] of Object.entries(pins.tools)) {
    assert.match(pin.version, /^\d+\.\d+\.\d+$/, `${name}: a release, never latest`);
    assert.deepEqual(Object.keys(pin.sha256).sort(), [...platforms].sort(), `${name}: every platform`);
    for (const hash of Object.values(pin.sha256)) assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(new Set(Object.values(pin.sha256)).size, platforms.length, `${name}: one archive each`);
  }
  assert.equal(pins.tools.modelspec.repository, 'modelspec-org/cli');
  assert.equal(pins.tools.meaninggraph.repository, 'meaninggraph/cli');
});

test('loadPins refuses latest, a range, a short hash and a missing platform', () => {
  const broken = (change) => {
    const doc = structuredClone(pins);
    change(doc.tools.modelspec);
    const path = fresh('pins') + '.json';
    writeFileSync(path, JSON.stringify(doc));
    return () => loadPins(path);
  };
  assert.throws(broken((tool) => { tool.version = 'latest'; }), /no latest, no range/);
  assert.throws(broken((tool) => { tool.version = '^0.1.0'; }), /no latest, no range/);
  assert.throws(broken((tool) => { tool.sha256.linux_amd64 = 'abc'; }), /no SHA-256 pinned for linux_amd64/);
  assert.throws(broken((tool) => { delete tool.sha256.darwin_arm64; }), /no SHA-256 pinned for darwin_arm64/);
  assert.throws(broken((tool) => { tool.repository = 'https://example.com/x'; }), /repository must be owner\/name/);
  const other = fresh('pins') + '.json';
  writeFileSync(other, '{"tools":{}}');
  assert.throws(() => loadPins(other), /not a chinookdb-tools\/1 file/);
});

test('the platform names are those of the release archives, and anything else has no build', () => {
  assert.equal(platformKey('linux', 'x64'), 'linux_amd64');
  assert.equal(platformKey('linux', 'arm64'), 'linux_arm64');
  assert.equal(platformKey('darwin', 'x64'), 'darwin_amd64');
  assert.equal(platformKey('darwin', 'arm64'), 'darwin_arm64');
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'ia32'], ['freebsd', 'x64'], ['linux', 'ppc64']]) assert.equal(platformKey(platform, arch), null, `${platform}/${arch}`);
  assert.equal(archiveName('modelspec', pins.tools.modelspec, 'linux_amd64'), `modelspec_${pins.tools.modelspec.version}_linux_amd64.tar.gz`);
  assert.equal(releaseUrl('meaninggraph', pins.tools.meaninggraph, 'darwin_arm64'), `https://github.com/meaninggraph/cli/releases/download/v${pins.tools.meaninggraph.version}/meaninggraph_${pins.tools.meaninggraph.version}_darwin_arm64.tar.gz`);
});

// ---------------------------------------------------------------- the installer

test('installTool accepts the archive with the pinned hash, unpacks only the binary and makes it executable', async () => {
  const bytes = archiveOf('widget');
  const dir = fresh('bin');
  const urls = [];
  const done = await installTool('widget', { pins: pinFor('widget', bytes), dir, platform: 'linux', arch: 'x64', download: async (url) => { urls.push(url); return bytes; } });
  assert.deepEqual(urls, ['https://github.com/acme/cli/releases/download/v1.2.3/widget_1.2.3_linux_amd64.tar.gz']);
  assert.equal(done.path, join(dir, 'widget'));
  assert.equal(done.sha256, sha256Hex(bytes));
  assert.equal(readFileSync(done.path, 'utf8'), '#!/bin/sh\necho fake\n');
  assert.ok(statSync(done.path).mode & 0o100, 'executable');
  assert.deepEqual(readdirSync(dir).sort(), ['widget', 'widget.receipt.json'], 'only the binary and its receipt: no archive, no README, no staging file');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'widget.receipt.json'), 'utf8')), { tool: 'widget', version: '1.2.3', platform: 'linux_amd64', archiveSha256: sha256Hex(bytes), binarySha256: sha256Hex('#!/bin/sh\necho fake\n') });
  assert.equal(spawnSync(done.path, { encoding: 'utf8' }).stdout, 'fake\n');
});

test('the hash is compared whole: a pin that differs in its last digit, or only the first 16 digits match, is refused', async () => {
  const bytes = archiveOf('widget');
  const actual = sha256Hex(bytes);
  const lastDigit = actual.slice(0, -1) + (actual.endsWith('0') ? '1' : '0');
  const prefixOnly = actual.slice(0, 16) + [...actual.slice(16)].reverse().join('');
  const firstDigit = (actual[0] === '0' ? '1' : '0') + actual.slice(1);
  for (const expected of [lastDigit, prefixOnly, firstDigit]) {
    assert.notEqual(expected, actual);
    const wrong = pinFor('widget', bytes);
    wrong.tools.widget.sha256.linux_amd64 = expected;
    const dir = fresh('bin');
    await assert.rejects(installTool('widget', { pins: wrong, dir, platform: 'linux', arch: 'x64', download: async () => bytes, extract: never('extract') }), /nothing was unpacked or installed/, expected);
    assert.ok(!existsSync(dir));
  }
});

test('the staging file is made exclusively: a link planted at its name is not followed, and a failed rename leaves nothing behind', async () => {
  const bytes = archiveOf('widget');
  const download = async () => bytes;
  const install = (dir) => installTool('widget', { pins: pinFor('widget', bytes), dir, platform: 'linux', arch: 'x64', download });
  // A symbolic link where the staging file would go, pointing at a file elsewhere.
  const dir = fresh('bin');
  mkdirSync(dir);
  const victim = join(fresh('victim'));
  writeFileSync(victim, 'precious');
  symlinkSync(victim, join(dir, `widget.new-${process.pid}`));
  await assert.rejects(install(dir), (error) => error instanceof ToolsError && /^cannot install .*\/widget: EEXIST.*widget\.new-\d+/.test(error.message) && !error.message.includes('\n'));
  assert.equal(readFileSync(victim, 'utf8'), 'precious', 'the file behind the link is untouched');
  assert.ok(!existsSync(join(dir, 'widget')));
  // The target is a directory: the rename fails, as one line, and the staged file is removed.
  const blocked = fresh('bin');
  mkdirSync(join(blocked, 'widget'), { recursive: true });
  writeFileSync(join(blocked, 'widget', 'keep'), 'x');
  await assert.rejects(install(blocked), (error) => error instanceof ToolsError && error.exit === 1 && /^cannot install .*widget: /.test(error.message) && !error.message.includes('\n') && !error.message.includes(' at '));
  assert.deepEqual(readdirSync(blocked), ['widget'], 'no staged file is left');
  // The directory itself cannot be made (a file is in the way): one line too.
  const file = fresh('file');
  writeFileSync(file, 'x');
  await assert.rejects(install(join(file, 'bin')), (error) => error instanceof ToolsError && /^cannot install widget into /.test(error.message) && !error.message.includes('\n'));
});

test('installTool refuses a wrong hash before it unpacks anything or writes to the directory', async () => {
  const bytes = archiveOf('widget');
  const tampered = archiveOf('widget', '#!/bin/sh\necho evil\n');
  const dir = fresh('bin');
  await assert.rejects(
    installTool('widget', { pins: pinFor('widget', bytes), dir, platform: 'linux', arch: 'x64', download: async () => tampered, extract: never('extract') }),
    (error) => {
      assert.ok(error instanceof ToolsError);
      assert.equal(error.exit, 1);
      assert.ok(error.message.includes(sha256Hex(tampered)) && error.message.includes(sha256Hex(bytes)), 'the message names both hashes');
      assert.match(error.message, /nothing was unpacked or installed/);
      return true;
    },
  );
  assert.ok(!existsSync(dir), 'the directory was not even created');
  // The same archive for the platform whose pinned hash is something else is refused too.
  await assert.rejects(installTool('widget', { pins: pinFor('widget', bytes), dir, platform: 'darwin', arch: 'arm64', download: async () => bytes, extract: never('extract') }), /pins f{64}/);
});

test('installTool refuses a platform with no pinned build, before it downloads', async () => {
  const bytes = archiveOf('widget');
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'ia32']]) {
    await assert.rejects(
      installTool('widget', { pins: pinFor('widget', bytes), dir: fresh('bin'), platform, arch, download: never('download'), extract: never('extract') }),
      (error) => error instanceof ToolsError && error.exit === 2 && error.message.includes(`no pinned widget build for ${platform}/${arch}`) && error.message.includes('linux_amd64'),
    );
  }
  await assert.rejects(installTool('nope', { pins: pinFor('widget', bytes), dir: fresh('bin'), download: never('download') }), /unknown tool nope; pinned: widget/);
});

test('installTool turns a failed download into a clear refusal and installs nothing', async () => {
  const dir = fresh('bin');
  await assert.rejects(
    installTool('widget', { pins: pinFor('widget', archiveOf('widget')), dir, platform: 'linux', arch: 'x64', download: async () => { throw new Error('HTTP 404'); }, extract: never('extract') }),
    (error) => error instanceof ToolsError && error.exit === 1 && /cannot download https:\/\/github\.com\/acme\/cli\/releases\/download\/v1\.2\.3\/widget_1\.2\.3_linux_amd64\.tar\.gz: HTTP 404/.test(error.message),
  );
  assert.ok(!existsSync(dir));
});

test('installTool refuses a verified archive that does not hold the binary as a regular file', async () => {
  const bytes = archiveOf('other');
  const dir = fresh('bin');
  await assert.rejects(installTool('widget', { pins: pinFor('widget', bytes), dir, platform: 'linux', arch: 'x64', download: async () => bytes }), /cannot unpack widget/);
  assert.ok(!existsSync(dir));
  const link = archiveOf('widget');
  await assert.rejects(installTool('widget', { pins: pinFor('widget', link), dir, platform: 'linux', arch: 'x64', download: async () => link, extract: (_archive, name, into) => symlinkSync('/bin/sh', join(into, name)) }), /holds no regular file widget/);
  assert.ok(!existsSync(dir), 'a link is never installed');
});

test('download retries a network error and a 5xx, and does not retry a 4xx', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const answers = [new Error('reset'), { ok: false, status: 503 }, { ok: true, arrayBuffer: async () => Buffer.from('ok') }];
  const calls = [];
  const flaky = async (url, options) => { calls.push([url, options.redirect]); const answer = answers[calls.length - 1]; if (answer instanceof Error) throw answer; return answer; };
  assert.equal((await download('https://x.test/a', { fetchImpl: flaky, sleep })).toString(), 'ok');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ['https://x.test/a', 'follow']);
  assert.deepEqual(waits, [2000, 4000]);
  let missing = 0;
  await assert.rejects(download('https://x.test/b', { fetchImpl: async () => { missing += 1; return { ok: false, status: 404 }; }, sleep }), /HTTP 404/);
  assert.equal(missing, 1);
  let down = 0;
  await assert.rejects(download('https://x.test/c', { fetchImpl: async () => { down += 1; return { ok: false, status: 502 }; }, sleep }), /HTTP 502/);
  assert.equal(down, 3);
});

/** A fetch answer whose body is read chunk by chunk through a reader that counts the reads. */
const streamed = (chunks, { length, onAbort } = {}) => {
  const state = { reads: 0, cancelled: 0 };
  const answer = (options) => ({
    ok: true,
    headers: { get: (name) => (name === 'content-length' && length !== undefined ? String(length) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          state.reads += 1;
          if (onAbort) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
          return state.reads <= chunks ? { done: false, value: Buffer.alloc(4) } : { done: true };
        },
        cancel: async () => { state.cancelled += 1; },
      }),
    },
  });
  return { state, fetchImpl: async (_url, options) => answer(options) };
};

test('download refuses a Content-Length over the cap before reading, stops a body without one at the cap, and gives up on a stalled body', async () => {
  const sleep = async () => {};
  const declared = streamed(3, { length: 11 });
  await assert.rejects(download('https://x.test/a', { fetchImpl: declared.fetchImpl, maxBytes: 10, sleep }), /larger than 10 bytes/);
  assert.equal(declared.state.reads, 0, 'the body was not read');
  const endless = streamed(1000);
  await assert.rejects(download('https://x.test/b', { fetchImpl: endless.fetchImpl, maxBytes: 10, sleep }), /larger than 10 bytes/);
  assert.equal(endless.state.reads, 3, 'reading stopped at the first chunk over the cap (4, 8, 12 bytes)');
  assert.equal(endless.state.cancelled, 1, 'and the body was cancelled');
  const within = streamed(2, { length: 8 });
  assert.equal((await download('https://x.test/c', { fetchImpl: within.fetchImpl, maxBytes: 8, sleep })).length, 8, 'exactly the cap is fine');
  const stalled = streamed(0, { onAbort: true });
  let calls = 0;
  await assert.rejects(download('https://x.test/d', { fetchImpl: async (...args) => { calls += 1; return stalled.fetchImpl(...args); }, timeoutMs: 20, sleep }), /timed out after 0\.02 seconds/);
  assert.equal(calls, 1, 'the one deadline covers every attempt: no retry after it');
  await assert.rejects(installTool('widget', { pins: pinFor('widget', archiveOf('widget')), dir: fresh('bin'), platform: 'linux', arch: 'x64', download: (url) => download(url, { fetchImpl: endless.fetchImpl, maxBytes: 10, sleep }) }), /cannot download .*larger than 10 bytes/);
});

test('the installer command line needs a directory, names no unknown tool, and installs every pinned tool by default', async () => {
  assert.throws(() => parseArguments([], ['a', 'b']), (error) => error.exit === 2 && /--dir is required/.test(error.message));
  assert.throws(() => parseArguments(['--dir', 'x', 'c'], ['a', 'b']), (error) => error.exit === 2 && /unknown tool c; pinned: a, b/.test(error.message));
  assert.throws(() => parseArguments(['--dir', 'x', '--latest'], ['a', 'b']), /unknown option --latest/);
  assert.deepEqual(parseArguments(['--dir', 'x'], ['a', 'b']).names, ['a', 'b']);
  assert.deepEqual(parseArguments(['b', '--dir', 'x'], ['a', 'b']).names, ['b']);
  const bytes = archiveOf('widget');
  const dir = fresh('bin');
  assert.equal(await install(['--dir', dir], { pins: pinFor('widget', bytes), platform: 'linux', arch: 'x64', download: async () => bytes }), 0);
  assert.deepEqual(readdirSync(dir).sort(), ['widget', 'widget.receipt.json']);
});

test('the installer and the runner never ask for latest, a version from the network or a shell pipe', () => {
  for (const file of ['scripts/install-tools.mjs', 'scripts/run-tool.mjs', 'scripts/check-meaning.mjs', 'scripts/lib/tools.mjs']) {
    const text = read(file).replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /releases\/latest|api\.github\.com|self-update|curl|wget|\| *(ba)?sh\b|shell: *true|(?<![.\w])exec\(/, file);
  }
});

// Downloads every pinned archive and compares its SHA-256 with the pin: how the hashes are confirmed.
test('every pinned archive downloads and hashes to its pin', { skip: process.env.CHINOOK_TOOLS_ONLINE !== '1' }, async () => {
  for (const [name, pin] of Object.entries(pins.tools)) {
    for (const key of platforms) {
      const bytes = await download(releaseUrl(name, pin, key));
      assert.equal(sha256Hex(bytes), pin.sha256[key], `${archiveName(name, pin, key)}`);
    }
  }
});

// ---------------------------------------------------------------- the runner

test('a binary runs only when the installer\'s receipt for the pinned release holds its hash, and anything else ends in a pointer to the installer', async () => {
  const bytes = archiveOf('widget');
  const pinned = pinFor('widget', bytes);
  const dir = fresh('bin');
  const at = (overrides = {}) => ({ pins: pinned, binDir: dir, platform: 'linux', arch: 'x64', ...overrides });
  const installIt = (using = pinned) => installTool('widget', { pins: using, dir, platform: 'linux', arch: 'x64', download: async () => bytes });
  const oneLinePointer = (pattern) => (error) => error.exit === 2 && pattern.test(error.message) && error.message.includes('run: pnpm tools:install') && !error.message.includes('\n');
  assert.throws(() => locateTool('widget', at()), oneLinePointer(/widget is not installed/));
  await installIt();
  assert.equal(locateTool('widget', at()), join(dir, 'widget'));
  // A file that merely says it is the right version is not accepted: the binary is hashed, not asked.
  writeFileSync(join(dir, 'widget'), '#!/bin/sh\necho "widget 1.2.3 (not-the-release)"\n', { mode: 0o755 });
  assert.throws(() => locateTool('widget', at()), oneLinePointer(/the file is not the one the installer installed/));
  // No receipt, and a receipt that is not JSON.
  await installIt();
  rmSync(join(dir, 'widget.receipt.json'));
  assert.throws(() => locateTool('widget', at()), oneLinePointer(/no readable receipt/));
  writeFileSync(join(dir, 'widget.receipt.json'), '{broken');
  assert.throws(() => locateTool('widget', at()), oneLinePointer(/no readable receipt/));
  // A receipt of another pin: another version, or another archive hash for this platform.
  await installIt();
  assert.throws(() => locateTool('widget', at({ pins: pinFor('widget', bytes, '1.2.4') })), oneLinePointer(/another release or platform/));
  assert.throws(() => locateTool('widget', at({ pins: pinFor('widget', archiveOf('widget', 'other\n')) })), oneLinePointer(/another release or platform/));
  assert.throws(() => locateTool('widget', at({ platform: 'win32' })), /no pinned widget build for win32\/x64/);
  assert.throws(() => locateTool('nope', at()), /unknown tool nope/);
});

test('runTool runs the verified binary from the repository root and returns its exit code', () => {
  const binDir = fresh('bin');
  fakeInstall(binDir, 'modelspec');
  const calls = [];
  const exec = (path, args, options) => { calls.push({ path, args, options }); return { status: 1 }; };
  assert.equal(runTool('modelspec', ['lint', '--profile', 'publish', 'model'], { pins, binDir, run: exec }), 1, 'findings are exit 1');
  assert.deepEqual(calls, [{ path: join(binDir, 'modelspec'), args: ['lint', '--profile', 'publish', 'model'], options: { stdio: 'inherit', cwd: root } }], 'the binary is run once, never asked for its version');
  assert.equal(runTool('modelspec', ['lint'], { pins, binDir, run: () => ({ status: null }) }), 2, 'a killed tool is not a pass');
  writeFileSync(join(binDir, 'modelspec'), '#!/bin/sh\necho "modelspec 0.1.0 (fake)"\n');
  let ran = 0;
  assert.throws(() => runTool('modelspec', ['lint'], { pins, binDir, run: () => { ran += 1; return { status: 0 }; } }), /the file is not the one the installer installed/);
  assert.equal(ran, 0, 'a replaced binary is not run');
  assert.throws(() => run([], { pins }), (error) => error.exit === 2 && /usage: node scripts\/run-tool\.mjs <modelspec\|meaninggraph>/.test(error.message));
  assert.throws(() => run(['specscore', 'lint'], { pins }), /usage/);
});

// ---------------------------------------------------------------- the core graph is the commit the meaning file pins

const meaningText = read(meaningFile);
const filePin = [...new Set([...meaningText.matchAll(/meaning:\/\/github\.com\/meaninggraph\/core\/[a-z-]+\?ref=([0-9a-f]{40})/g)].map((match) => match[1]))];

const address = 'github.com/datatug/chinookdb';

test('the commit of meaninggraph/core that is checked out is the one the meaning file pins, read from the file', () => {
  assert.equal(filePin.length, 1, 'the meaning file has one pin');
  assert.equal(corePin(meaningText), filePin[0]);
  const asked = [];
  const resolve = (repo, ref) => { asked.push([repo, ref]); return { dir: '/checkout/core' }; };
  assert.deepEqual(checkInvocations({ resolve }), [
    ['check', '/checkout/core', '--address', coreRepo],
    ['check', 'model', '--address', address, '--graph', 'github.com/meaninggraph/core=/checkout/core'],
  ]);
  assert.deepEqual(asked, [[coreRepo, filePin[0]]], 'the checkout is asked for at the pin and nothing else');
  assert.throws(() => checkInvocations({ resolve: () => ({ error: 'meaning://x cannot be read' }) }), (error) => error.exit === 2 && /cannot be read/.test(error.message));
});

test('the core checkout is checked as a graph of its own (a path operand) as well as supplied with --graph, and the repository\'s address is passed', () => {
  const [coreRun, modelRun] = checkInvocations({ resolve: () => ({ dir: '/checkout/core' }) });
  assert.equal(coreRun[0], 'check');
  assert.ok(coreRun.includes('/checkout/core') && !coreRun.includes('--graph'), 'run 1: core is a path operand, so every rule is applied to it');
  assert.ok(modelRun.includes('model') && modelRun.at(-1) === `${coreRepo}=/checkout/core`, 'run 2: the model graph, with core supplied by --graph');
  assert.equal(modelRun[modelRun.indexOf('--address') + 1], address, 'the repository\'s own address is passed, so a reference to itself resolves');
  assert.equal(coreRun[coreRun.indexOf('--address') + 1], coreRepo);
  assert.equal(ownAddress(read('ovdb.yaml')), address, 'the address is the one ovdb.yaml states for the meaning graph');
  assert.throws(() => ownAddress('meaning:\n  graph:\n    address: meaning://github.com/x/y?ref=abc\n'), /meaning.graph.address must be meaning:\/\/<host>\/<org>\/<repo>/);
  assert.throws(() => ownAddress('a: [unclosed'), (error) => error.exit === 2 && /ovdb\.yaml is not valid YAML/.test(error.message) && !error.message.includes('\n'));
});

test('a meaning file with two pins, or a pin that is not a full commit, is refused before anything is fetched', () => {
  const mixed = meaningText.replace(filePin[0], 'a'.repeat(40));
  assert.throws(() => corePin(mixed), (error) => error.exit === 2 && /exactly one commit/.test(error.message));
  assert.throws(() => corePin(meaningText.replaceAll(filePin[0], 'main')), /not a full 40-digit commit id/);
  assert.throws(() => corePin('format: meaning/draft-1\nconcepts: []\n'), (error) => error.exit === 2 && /exactly one commit, found \[\]/.test(error.message), 'a meaning file with no reference to core is refused: Chinook depends on it');
  assert.throws(() => corePin('concepts: [unclosed'), (error) => error instanceof ToolsError && error.exit === 2 && /model\/chinook\.meaning\.yaml is not valid YAML/.test(error.message) && !error.message.includes('\n'), 'a syntax error is one line, not a stack');
  assert.throws(() => checkInvocations({ file: join(scratch, 'missing.yaml'), resolve: never('resolve') }), (error) => error.exit === 2 && /cannot read .*missing\.yaml/.test(error.message));
  assert.throws(() => corePin(meaningText.replaceAll(`?ref=${filePin[0]}`, '')), /pins github.com\/meaninggraph\/core to "", which is not a full 40-digit commit id/);
});

test('with a local repository standing in for github.com the checkout handed to meaninggraph is that commit', () => {
  const env = isolatedGitEnv();
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env, stdio: 'pipe' }).toString().trim();
  const origin = fresh('origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'a.meaning.yaml'), 'format: meaning/draft-1\n');
  git(origin, 'add', '.');
  git(origin, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one');
  const sha = git(origin, 'rev-parse', 'HEAD');
  const file = fresh('meaning') + '.yaml';
  writeFileSync(file, stringifyYaml({ format: 'meaning/draft-1', concepts: [{ id: 'x', extends: `meaning://${coreRepo}/a?ref=${sha}` }] }));
  const resolve = createResolver({ root, sources: { [coreRepo]: { git: `file://${origin}` } }, cacheDir: fresh('cache'), run: (command, args) => execFileSync(command, args, { env, stdio: 'pipe' }).toString() });
  try {
    const [coreRun, modelRun] = checkInvocations({ file, resolve });
    const supplied = modelRun.at(-1).slice(`${coreRepo}=`.length);
    assert.equal(coreRun[1], supplied, 'one directory, checked and supplied');
    assert.equal(git(supplied, 'rev-parse', 'HEAD'), sha, 'meaninggraph reads .git/HEAD of this directory and compares it with the pin');
  } finally { resolve.dispose(); }
  // A second commit in the origin does not move the checkout: the pin is a commit, not a branch.
  assert.ok(!/[0-9a-f]{40}/.test(read('scripts/check-meaning.mjs').replace(/^\s*\/\/.*$/gm, '')), 'no commit id is written in check-meaning.mjs');
});

test('check-meaning runs meaninggraph twice, disposes the resolver and returns the highest exit code', () => {
  const binDir = fresh('bin');
  fakeInstall(binDir, 'meaninggraph');
  const calls = [];
  const exitCodes = [0, 2];
  const exec = (path, args, options) => { calls.push({ args, options }); return { status: exitCodes[calls.length - 1] }; };
  let disposed = 0;
  const resolve = () => ({ dir: '/checkout/core' });
  resolve.dispose = () => { disposed += 1; };
  const previous = process.env.TOOLS_BIN;
  const restore = () => { if (previous === undefined) delete process.env.TOOLS_BIN; else process.env.TOOLS_BIN = previous; };
  process.env.TOOLS_BIN = binDir;
  try {
    assert.equal(checkMeaning({ resolve, run: exec }), 2, 'both runs happen, and the worse code is the result');
  } finally { restore(); }
  assert.deepEqual(calls.map((call) => call.args), checkInvocations({ resolve }));
  assert.equal(disposed, 1);
  // Without the binary nothing is fetched: the pointer to the installer comes first.
  process.env.TOOLS_BIN = fresh('empty');
  let fetched = 0;
  const counting = () => { fetched += 1; return { dir: '/checkout/core' }; };
  try {
    assert.throws(() => checkMeaning({ resolve: counting }), (error) => error.exit === 2 && /meaninggraph is not installed.*pnpm tools:install/.test(error.message));
  } finally { restore(); }
  assert.equal(fetched, 0);
});

test('the pinned commit is written in the meaning file and the README (which the model tests compare), and nowhere else outside the tests', () => {
  const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'scripts', '.github', 'docs', 'src', 'model', 'package.json', 'wrangler.jsonc', 'astro.config.mjs', '*.md', '*.yaml'], { env: cleanGitEnv(), encoding: 'utf8' }).split('\0').filter(Boolean);
  const holders = tracked.filter((path) => existsSync(join(root, path)) && lstatSync(join(root, path)).isFile() && read(path).includes(filePin[0])).sort();
  assert.deepEqual(holders.filter((path) => !/^scripts\/test-/.test(path)), ['README.md', 'model/chinook.meaning.yaml']);
});

// ---------------------------------------------------------------- the package scripts and the workflows

const scripts = JSON.parse(read('package.json')).scripts;
const workflows = Object.fromEntries(['ci', 'deploy'].map((name) => [name, parseYaml(read(`.github/workflows/${name}.yml`))]));
const jobSteps = (workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps);
/** The commands a workflow runs, with each `pnpm <script>` resolved to the package script it names. */
const commands = (workflow) => jobSteps(workflow).filter((step) => step.run).map((step) => {
  const text = step.run.trim();
  const named = /^pnpm ([a-z:-]+)$/.exec(text);
  return named ? scripts[named[1]] ?? `pnpm ${named[1]} (no such script)` : text;
});

const MODEL_LINT = 'node scripts/run-tool.mjs modelspec lint --profile publish model';
const MODEL_TWIN = 'node scripts/run-tool.mjs modelspec export --check model/chinook.modelspec.hcl model/chinook.modelspec.json';
const MEANING_CHECK = 'node scripts/check-meaning.mjs';
const INSTALL = 'node scripts/install-tools.mjs --dir .tools/bin';

test('the package scripts are the three commands, the installer and nothing that guesses', () => {
  assert.equal(scripts['lint:model'], MODEL_LINT);
  assert.equal(scripts['check:model-twin'], MODEL_TWIN);
  assert.equal(scripts['check:meaning'], MEANING_CHECK);
  assert.equal(scripts['tools:install'], INSTALL);
  assert.equal(scripts['test:tools'], 'node --test scripts/test-tools.mjs');
  assert.ok(!('lint:modelspec' in scripts), 'the repository\'s own lint script is gone');
  assert.ok(!existsSync(join(root, 'scripts', 'lint-modelspec.sh')));
  assert.ok(!/(^|\s)(modelspec|meaninggraph)\s/.test(Object.values(scripts).join('\n').replace(/scripts\/run-tool\.mjs (modelspec|meaninggraph)/g, '')), 'a tool is only run through the runner, which checks the pinned release');
});

for (const name of ['ci', 'deploy']) {
  test(`${name}.yml installs both tools with the installer, then runs the three commands, in that order`, () => {
    const ran = commands(workflows[name]);
    const at = (command) => {
      assert.equal(ran.filter((candidate) => candidate === command).length, 1, `exactly one step runs: ${command}`);
      return ran.indexOf(command);
    };
    const installAt = at(INSTALL);
    const lintAt = at(MODEL_LINT);
    const twinAt = at(MODEL_TWIN);
    const meaningAt = at(MEANING_CHECK);
    assert.ok(installAt < lintAt && lintAt < twinAt && twinAt < meaningAt, 'install, lint, twin, meaning graph');
    assert.ok(installAt < ran.indexOf(scripts.build), 'the tools are installed before the build');
    assert.ok(ran.includes(scripts['test:tools']), 'the tool tests run in this workflow');
    assert.ok(ran.includes(scripts['test:model']) && ran.includes(scripts['check:ovdb']), 'the checks that stay still run');
    if (name === 'deploy') {
      const steps = jobSteps(workflows.deploy);
      const deployAt = steps.findIndex((step) => step.name === 'Deploy');
      const checkAt = steps.findIndex((step) => step.run === 'pnpm check:meaning');
      assert.ok(checkAt > -1 && checkAt < deployAt, 'every check runs before the deploy');
    }
  });

  test(`${name}.yml uses no unpinned tool or action, never downloads by hand, and every job has a timeout`, () => {
    const steps = jobSteps(workflows[name]);
    for (const step of steps.filter((candidate) => candidate.uses)) assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, step.uses);
    for (const step of steps.filter((candidate) => candidate.run)) {
      assert.doesNotMatch(step.run, /\b(curl|wget|brew|go install|self-update|npx|latest)\b/, step.run);
      assert.doesNotMatch(step.run, /(^|[\s;&|])(modelspec|meaninggraph)(\s|$)/, `${step.run}: a tool is run through its package script, not by name`);
    }
    for (const [id, job] of Object.entries(workflows[name].jobs)) assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0, `job ${id} has a timeout`);
    assert.ok(!steps.some((step) => step['continue-on-error']), 'no check can fail silently');
  });

  test(`${name}.yml does not write the pinned core commit anywhere: it comes from the meaning file`, () => {
    const text = read(`.github/workflows/${name}.yml`);
    for (const [hash] of text.matchAll(/\b[0-9a-f]{40}\b/g)) assert.notEqual(hash, filePin[0]);
    assert.ok(!/repository: *meaninggraph\/core/.test(text), 'no checkout step of core with a pin of its own');
    assert.ok(text.includes('key: meaning-sources-${{ hashFiles(\'model/*.meaning.yaml\') }}'), 'the cache of the checkout is keyed by the meaning file, so a pin change is a new entry');
  });
}

test('ci.yml and deploy.yml give the tool steps the same names', () => {
  const names = (workflow) => jobSteps(workflow).map((step) => step.name).filter((stepName) => /pinned modelspec|ModelSpec|Meaning graph|Tool pin/.test(stepName ?? ''));
  assert.deepEqual(names(workflows.ci), names(workflows.deploy));
  assert.equal(names(workflows.ci).length, 5);
});
