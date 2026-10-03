import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The checksums file describes every published data file except itself.
export const checksumsPath = 'metadata/checksums.json';

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Dotfiles and dot-directories (.DS_Store, .git) are never published.
const isDotPath = (path) => path.split('/').some((segment) => segment.startsWith('.'));

// Lists files under `dir` as '/'-separated paths relative to it, sorted by code
// point (never by locale) so the result is identical on every machine.
// `exclude` is the checksums file's own path, which never lists itself.
// Dotfiles are skipped.
export async function listDataFiles(dir, prefix = '', exclude = checksumsPath) {
  const found = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await listDataFiles(dir, path, exclude));
    else if (path !== exclude) found.push(path);
  }
  return found.sort(byCodePoint);
}

// Lists the git-tracked files under `dir` (relative to the repository at
// `root`) as '/'-separated paths relative to `dir`, without dotfiles, sorted
// by code point. Only committed or staged files are published, so a stray
// local file never reaches the site. Fails loudly outside a git checkout.
export function listTrackedFiles(root, dir) {
  const output = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', dir], { encoding: 'utf8' });
  return output.split('\0').filter(Boolean).map((path) => path.slice(dir.length + 1)).filter((path) => !isDotPath(path)).sort(byCodePoint);
}

// Builds the checksums document for the files currently in `dir` (or the
// given `files`, paths relative to `dir`). `source` names the pinned upstream
// input the files were generated from.
export async function buildChecksums(dir, source, { exclude = checksumsPath, files: only, note = 'Paths are relative to /data/. This file lists every other published data file with its SHA-256 and size in bytes.' } = {}) {
  const files = {};
  for (const path of only ? only.filter((path) => path !== exclude) : await listDataFiles(dir, '', exclude)) {
    const bytes = await readFile(join(dir, path));
    files[path] = { sha256: sha256Hex(bytes), bytes: bytes.length };
  }
  return { algorithm: 'sha256', note, source, files };
}

export const serializeChecksums = (checksums) => `${JSON.stringify(checksums, null, 2)}\n`;

// Compares a checksums document with the files in `dir` and returns a list of
// problems (empty when every file matches and none is missing or unlisted).
export async function verifyChecksums(dir, checksums, exclude = checksumsPath, files = undefined) {
  const problems = [];
  const listed = Object.keys(checksums.files ?? {});
  const actual = files ? files.filter((path) => path !== exclude) : await listDataFiles(dir, '', exclude);
  for (const path of actual) if (!listed.includes(path)) problems.push(`${path} is published but not listed in ${exclude}`);
  for (const path of listed) {
    if (!actual.includes(path)) { problems.push(`${path} is listed in ${exclude} but missing`); continue; }
    const bytes = await readFile(join(dir, path));
    const { sha256, bytes: size } = checksums.files[path];
    if (bytes.length !== size) problems.push(`${path} is ${bytes.length} bytes, ${exclude} says ${size}`);
    if (sha256Hex(bytes) !== sha256) problems.push(`${path} SHA-256 differs from ${exclude}`);
  }
  if (JSON.stringify(listed) !== JSON.stringify([...listed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))) problems.push(`${exclude} is not sorted by path`);
  return problems;
}
