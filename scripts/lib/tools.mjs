// The released command-line tools that validate the model and the meaning graph, pinned in scripts/tools.json
// by version and by the SHA-256 of each release archive: the installer that downloads and verifies them
// (scripts/install-tools.mjs) and the runner that refuses a missing or another-version binary
// (scripts/run-tool.mjs, scripts/check-meaning.mjs).
//
// Nothing here reads a version from the network, follows `latest` or runs anything that was not verified:
// an archive is hashed before a byte of it is unpacked, and a binary is run only after the installer put it
// in the directory the caller named.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const pinsPath = join(root, 'scripts', 'tools.json');
// The platforms that have a pinned archive (the releases also hold windows_amd64.zip: not pinned, see the README).
export const platforms = ['darwin_amd64', 'darwin_arm64', 'linux_amd64', 'linux_arm64'];
export const installCommand = 'pnpm tools:install';

/** An error with the exit code the command line ends with: 1 for a refused or failed download, 2 for a usage or environment problem. */
export class ToolsError extends Error {
  constructor(message, exit = 1) {
    super(message);
    this.exit = exit;
  }
}

const sha256Pattern = /^[0-9a-f]{64}$/;

/** Reads and checks scripts/tools.json: every tool has a release version, a repository and a SHA-256 for every platform. */
export function loadPins(path = pinsPath) {
  const pins = JSON.parse(readFileSync(path, 'utf8'));
  if (pins.format !== 'chinookdb-tools/1' || !pins.tools || typeof pins.tools !== 'object') throw new ToolsError(`${path} is not a chinookdb-tools/1 file`, 2);
  for (const [name, pin] of Object.entries(pins.tools)) {
    if (!/^\d+\.\d+\.\d+$/.test(pin.version ?? '')) throw new ToolsError(`${name}: version must be a release number such as 0.1.0, not ${JSON.stringify(pin.version)} (no latest, no range)`, 2);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pin.repository ?? '')) throw new ToolsError(`${name}: repository must be owner/name`, 2);
    for (const platform of platforms) if (!sha256Pattern.test(pin.sha256?.[platform] ?? '')) throw new ToolsError(`${name}: no SHA-256 pinned for ${platform}`, 2);
  }
  return pins;
}

/** `linux_amd64` and its kind for this machine, or null for a platform no archive is pinned for. */
export function platformKey(platform = process.platform, arch = process.arch) {
  const os = { darwin: 'darwin', linux: 'linux' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  return os && cpu ? `${os}_${cpu}` : null;
}

export const archiveName = (name, pin, key) => `${name}_${pin.version}_${key}.tar.gz`;
export const releaseUrl = (name, pin, key) => `https://github.com/${pin.repository}/releases/download/v${pin.version}/${archiveName(name, pin, key)}`;
export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Where the binaries live unless the caller names another directory: git-ignored, under the repository.
export const defaultBinDir = (env = process.env) => env.TOOLS_BIN || join(root, '.tools', 'bin');

const maxArchiveBytes = 64 * 1024 * 1024;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Downloads `url` into memory over HTTPS, retrying a network error or a 5xx; a 4xx is final. */
export async function download(url, { fetchImpl = fetch, attempts = 3, sleep = pause } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: 'follow' });
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxArchiveBytes) throw new ToolsError(`${url} is larger than ${maxArchiveBytes} bytes`);
        return bytes;
      }
      last = new Error(`HTTP ${response.status}`);
      if (response.status < 500) break;
    } catch (error) {
      if (error instanceof ToolsError) throw error;
      last = error;
    }
    if (attempt < attempts) await sleep(attempt * 2000);
  }
  throw last;
}

/** Unpacks the one named member of a .tar.gz into `into`. */
export function extractWithTar(archive, member, into) {
  const run = spawnSync('tar', ['-xzf', archive, '-C', into, member], { encoding: 'utf8' });
  if (run.error || run.status !== 0) throw new ToolsError(`cannot unpack ${member} from ${archive}: ${run.error?.message ?? run.stderr.trim()}`);
}

/**
 * Installs one pinned tool into `dir`: downloads its archive for this platform from the GitHub release, checks
 * the SHA-256 against scripts/tools.json, and only then unpacks it. Returns { name, version, key, archive, sha256, path }.
 * `download` and `extract` are injected by the tests. A wrong hash, a platform with no pin and a failed download
 * throw a ToolsError before anything is unpacked or written to `dir`.
 */
export async function installTool(name, { pins, dir, platform = process.platform, arch = process.arch, download: fetchArchive = download, extract = extractWithTar }) {
  const pin = pins.tools[name];
  if (!pin) throw new ToolsError(`unknown tool ${name}; pinned: ${Object.keys(pins.tools).join(', ')}`, 2);
  const key = platformKey(platform, arch);
  if (!key) throw new ToolsError(`no pinned ${name} build for ${platform}/${arch}; pinned platforms: ${platforms.join(', ')}`, 2);
  const archive = archiveName(name, pin, key);
  const url = releaseUrl(name, pin, key);
  let bytes;
  try {
    bytes = await fetchArchive(url);
  } catch (error) {
    throw new ToolsError(`cannot download ${url}: ${error.message}`);
  }
  const actual = sha256Hex(bytes);
  const expected = pin.sha256[key];
  if (actual !== expected) throw new ToolsError(`${archive} has SHA-256 ${actual}, but scripts/tools.json pins ${expected}; nothing was unpacked or installed`);

  const work = mkdtempSync(join(tmpdir(), 'chinook-tool-'));
  try {
    writeFileSync(join(work, archive), bytes);
    extract(join(work, archive), name, work);
    const unpacked = join(work, name);
    if (!lstatSync(unpacked, { throwIfNoEntry: false })?.isFile()) throw new ToolsError(`${archive} holds no regular file ${name}`);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, name);
    const staged = `${target}.new-${process.pid}`;
    copyFileSync(unpacked, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, target);
    return { name, version: pin.version, key, archive, sha256: actual, path: target };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The path of an installed tool whose `version` is the pinned one. A missing binary, one that cannot run and
 * one of another version each end in a one-line pointer to the installer (exit 2).
 */
export function locateTool(name, { pins, binDir = defaultBinDir(), run = spawnSync } = {}) {
  const pin = pins.tools[name];
  if (!pin) throw new ToolsError(`unknown tool ${name}; pinned: ${Object.keys(pins.tools).join(', ')}`, 2);
  const path = join(binDir, name);
  if (!existsSync(path)) throw new ToolsError(`${name} is not installed in ${binDir}; run: ${installCommand}`, 2);
  const result = run(path, ['version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new ToolsError(`${path} does not run (${result.error?.message ?? `exit ${result.status}`}); run: ${installCommand}`, 2);
  const line = String(result.stdout).split('\n')[0].trim();
  if (line !== `${name} ${pin.version}` && !line.startsWith(`${name} ${pin.version} `)) throw new ToolsError(`${path} is "${line}", the pinned release is ${name} ${pin.version}; run: ${installCommand}`, 2);
  return path;
}

/**
 * Runs a pinned, installed tool with the terminal as its output and returns its exit code (0 clean, 1 findings, 2 usage).
 * `args` may be a function, called once the binary is found, for arguments that cost something to prepare.
 */
export function runTool(name, args, { pins = loadPins(), binDir = defaultBinDir(), run = spawnSync, cwd = root } = {}) {
  const path = locateTool(name, { pins, binDir, run });
  const result = run(path, typeof args === 'function' ? args() : args, { stdio: 'inherit', cwd });
  if (result.error) throw new ToolsError(`cannot run ${path}: ${result.error.message}`, 2);
  return result.status ?? 2;
}

/** Runs `main` as a command line: a ToolsError prints its message and exits with its code. */
export async function commandLine(main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (!(error instanceof ToolsError)) throw error;
    console.error(`chinookdb: ${error.message}`);
    process.exitCode = error.exit;
  }
}
