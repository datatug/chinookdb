// The released command-line tools that validate the model and the meaning graph, pinned in scripts/tools.json
// by version and by the SHA-256 of each release archive: the installer that downloads and verifies them
// (scripts/install-tools.mjs) and the runner that refuses a binary the installer did not install
// (scripts/run-tool.mjs, scripts/check-meaning.mjs).
//
// What is guaranteed: nothing here reads a version from the network or follows `latest`; an archive is hashed
// before a byte of it is unpacked; the installer records the SHA-256 of the binary it unpacked in a receipt beside
// it (<name>.receipt.json, with the version and the pinned archive hash); and the runner executes a binary only
// when its hash is the one in a receipt that names the pinned version and archive, so another file in the
// directory, or a binary of an earlier pin, is refused with a pointer to the installer.
// What is not: the receipt sits next to the binary, so a local user who can write the directory can replace both.
// That is a guard against a stale or wrong binary, not against someone with write access to .tools/. CI always
// runs the installer first in the same job, which replaces both files. Nor is the window between the hash check
// and the spawn closed: a binary swapped in that moment would run. It takes the same actor, one who can write
// the directory, so it adds nothing to the limit above.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
// A tool name becomes a file name (the binary, its receipt, its archive): a plain identifier, never a path.
export const toolNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Reads and checks scripts/tools.json: every tool has a release version, a repository and a SHA-256 for every platform. */
export function loadPins(path = pinsPath) {
  const pins = JSON.parse(readFileSync(path, 'utf8'));
  if (pins.format !== 'chinookdb-tools/1' || !pins.tools || typeof pins.tools !== 'object') throw new ToolsError(`${path} is not a chinookdb-tools/1 file`, 2);
  for (const [name, pin] of Object.entries(pins.tools)) {
    if (!toolNamePattern.test(name)) throw new ToolsError(`tool name ${JSON.stringify(name)} is not a plain name (lower-case letters and digits, hyphens inside): it names a file in the install directory`, 2);
    if (!/^\d+\.\d+\.\d+$/.test(pin.version ?? '')) throw new ToolsError(`${name}: version must be a release number such as 0.1.0, not ${JSON.stringify(pin.version)} (a pinned release, never a moving name or a range)`, 2);
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

export const maxArchiveBytes = 64 * 1024 * 1024;
export const downloadTimeoutMs = 120_000;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Downloads `url` into memory over HTTPS, retrying a network error or a 5xx; a 4xx is final. The body is read as a
 * stream and the download stops at `maxBytes` (a larger Content-Length is refused before the body is read), and one
 * deadline of `timeoutMs` covers every attempt, enforced with an abort signal.
 */
export async function download(url, { fetchImpl = fetch, attempts = 3, sleep = pause, maxBytes = maxArchiveBytes, timeoutMs = downloadTimeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const tooLarge = () => new ToolsError(`${url} is larger than ${maxBytes} bytes`);
  let last;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
        if (response.ok) {
          const length = Number(response.headers?.get('content-length'));
          if (Number.isFinite(length) && length > maxBytes) throw tooLarge();
          const chunks = [];
          let total = 0;
          const reader = response.body?.getReader();
          if (reader) {
            for (let part = await reader.read(); !part.done; part = await reader.read()) {
              total += part.value.length;
              if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                throw tooLarge();
              }
              chunks.push(part.value);
            }
            return Buffer.concat(chunks);
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > maxBytes) throw tooLarge();
          return bytes;
        }
        last = new Error(`HTTP ${response.status}`);
        if (response.status < 500) break;
      } catch (error) {
        if (error instanceof ToolsError) throw error;
        last = error;
      }
      if (controller.signal.aborted) break;
      if (attempt < attempts) await sleep(attempt * 2000);
    }
    if (controller.signal.aborted) throw new Error(`timed out after ${timeoutMs / 1000} seconds`);
    throw last;
  } finally {
    clearTimeout(timer);
    // Whatever way out (a body, a refusal, an error), nothing of the request stays open: an unread body would keep the process alive.
    controller.abort();
  }
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
export async function installTool(name, { pins, dir, platform = process.platform, arch = process.arch, download: fetchArchive = download, extract = extractWithTar, now = Date.now() }) {
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
    const binary = readFileSync(unpacked);
    const receipt = { tool: name, version: pin.version, platform: key, archiveSha256: actual, binarySha256: sha256Hex(binary) };
    try {
      mkdirSync(dir, { recursive: true });
      sweepStaging(dir, name, now);
      unlinkSync(receiptPath(dir, name)); // a receipt never outlives the binary it describes
    } catch (error) {
      if (error.code !== 'ENOENT') throw new ToolsError(`cannot install ${name} into ${dir}: ${error.message.split('\n')[0]}`);
    }
    const target = join(dir, name);
    placeFile(target, binary, 0o755);
    placeFile(receiptPath(dir, name), `${JSON.stringify(receipt, null, 2)}\n`, 0o644);
    return { name, version: pin.version, key, archive, sha256: actual, binarySha256: receipt.binarySha256, path: target, receipt: receiptPath(dir, name) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const receiptPath = (dir, name) => join(dir, `${name}.receipt.json`);

// A staging file older than this is a leftover of a run that died; a younger one may be another installer's.
export const stagingMaxAgeMs = 5 * 60 * 1000;
/** Removes the leftover staging files (`<name>.new-<pid>` and `<name>.receipt.json.new-<pid>`) older than stagingMaxAgeMs. Links are removed, never followed. */
function sweepStaging(dir, name, now) {
  const leftover = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.receipt\\.json)?\\.new-\\d+$`);
  for (const entry of readdirSync(dir)) {
    if (!leftover.test(entry)) continue;
    const stat = lstatSync(join(dir, entry), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory() && now - stat.mtimeMs > stagingMaxAgeMs) rmSync(join(dir, entry), { force: true });
  }
}

/**
 * Writes `content` to `target` through a staging file made exclusively (O_EXCL: it fails when the name exists and
 * never follows a symbolic link there), then renames it into place. Any failure removes the staging file this call
 * made and ends as a one-line ToolsError.
 */
function placeFile(target, content, mode) {
  const staged = `${target}.new-${process.pid}`;
  let created = false;
  try {
    try {
      writeFileSync(staged, content, { flag: 'wx', mode });
    } catch (error) {
      // A leftover of an earlier run (or of one with this pid) must not block the install: remove it (a link is
      // removed, not followed) and create the file again, still exclusively.
      if (error.code !== 'EEXIST') throw error;
      // The installer never makes a directory here, so it does not remove one either: refuse, and say what to do.
      if (lstatSync(staged, { throwIfNoEntry: false })?.isDirectory()) throw new ToolsError(`cannot install ${target}: ${staged} is a directory, which the installer did not make and will not remove; remove it by hand`, 2);
      rmSync(staged, { force: true });
      writeFileSync(staged, content, { flag: 'wx', mode });
    }
    created = true;
    chmodSync(staged, mode);
    renameSync(staged, target);
  } catch (error) {
    if (created) rmSync(staged, { force: true });
    if (error instanceof ToolsError) throw error;
    throw new ToolsError(`cannot install ${target}: ${error.message.split('\n')[0]}`);
  }
}

/**
 * The path of an installed tool that is the pinned release: its receipt names the pinned version and the pinned
 * archive hash of this platform, and the binary's SHA-256 is the one the receipt recorded. A missing binary or
 * receipt, a binary that was replaced and a receipt of another pin each end in a one-line pointer to the
 * installer (exit 2). The binary is hashed, not run.
 */
export function locateTool(name, { pins, binDir = defaultBinDir(), platform = process.platform, arch = process.arch } = {}) {
  const pin = pins.tools[name];
  if (!pin) throw new ToolsError(`unknown tool ${name}; pinned: ${Object.keys(pins.tools).join(', ')}`, 2);
  const path = join(binDir, name);
  if (!lstatSync(path, { throwIfNoEntry: false })) throw new ToolsError(`${name} is not installed in ${binDir}; run: ${installCommand}`, 2);
  const stale = (why) => new ToolsError(`${path} is not the pinned ${name} ${pin.version} (${why}); run: ${installCommand}`, 2);
  if (!lstatSync(path).isFile()) throw stale('it is not a regular file');
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath(binDir, name), 'utf8'));
  } catch {
    throw stale('no readable receipt from the installer');
  }
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) throw stale('its receipt is not a receipt');
  const key = platformKey(platform, arch);
  if (!key) throw new ToolsError(`no pinned ${name} build for ${platform}/${arch}; pinned platforms: ${platforms.join(', ')}`, 2);
  if (receipt.tool !== name || receipt.version !== pin.version || receipt.platform !== key || receipt.archiveSha256 !== pin.sha256[key]) throw stale('its receipt is of another release or platform');
  let actual;
  try {
    actual = sha256Hex(readFileSync(path));
  } catch {
    throw stale('the file cannot be read');
  }
  if (!sha256Pattern.test(receipt.binarySha256 ?? '') || actual !== receipt.binarySha256) throw stale('the file is not the one the installer installed');
  return path;
}

/**
 * Runs a pinned, installed tool with the terminal as its output and returns its exit code (0 clean, 1 findings, 2 usage).
 * `args` may be a function, called once the binary is found, for arguments that cost something to prepare.
 */
export function runTool(name, args, { pins = loadPins(), binDir = defaultBinDir(), run = spawnSync, cwd = root, platform, arch } = {}) {
  const path = locateTool(name, { pins, binDir, platform, arch });
  const result = run(path, typeof args === 'function' ? args() : args, { stdio: 'inherit', cwd });
  if (result.error) throw new ToolsError(`cannot run ${path}: ${result.error.message}`, 2);
  return result.status ?? 2;
}

/** Runs a pinned, installed tool and returns { status, stdout (a Buffer, byte for byte), stderr }, for output that is compared and not shown. */
export function captureTool(name, args, { pins = loadPins(), binDir = defaultBinDir(), run = spawnSync, cwd = root, platform, arch } = {}) {
  const path = locateTool(name, { pins, binDir, platform, arch });
  const result = run(path, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new ToolsError(`cannot run ${path}: ${result.error.message}`, 2);
  return { status: result.status ?? 2, stdout: result.stdout ?? Buffer.alloc(0), stderr: String(result.stderr ?? '') };
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
