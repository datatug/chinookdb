import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The checksums file describes every published data file except itself.
export const checksumsPath = 'metadata/checksums.json';

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Lists files under `dir` as '/'-separated paths relative to it, sorted by code
// point (never by locale) so the result is identical on every machine.
export async function listDataFiles(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await listDataFiles(dir, path));
    else if (path !== checksumsPath) found.push(path);
  }
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Builds the checksums document for the files currently in `dir`. `source`
// names the pinned upstream input the files were generated from.
export async function buildChecksums(dir, source) {
  const files = {};
  for (const path of await listDataFiles(dir)) {
    const bytes = await readFile(join(dir, path));
    files[path] = { sha256: sha256Hex(bytes), bytes: bytes.length };
  }
  return {
    algorithm: 'sha256',
    note: 'Paths are relative to /data/. This file lists every other published data file with its SHA-256 and size in bytes.',
    source,
    files,
  };
}

export const serializeChecksums = (checksums) => `${JSON.stringify(checksums, null, 2)}\n`;

// Compares a checksums document with the files in `dir` and returns a list of
// problems (empty when every file matches and none is missing or unlisted).
export async function verifyChecksums(dir, checksums) {
  const problems = [];
  const listed = Object.keys(checksums.files ?? {});
  const actual = await listDataFiles(dir);
  for (const path of actual) if (!listed.includes(path)) problems.push(`${path} is published but not listed in ${checksumsPath}`);
  for (const path of listed) {
    if (!actual.includes(path)) { problems.push(`${path} is listed in ${checksumsPath} but missing`); continue; }
    const bytes = await readFile(join(dir, path));
    const { sha256, bytes: size } = checksums.files[path];
    if (bytes.length !== size) problems.push(`${path} is ${bytes.length} bytes, ${checksumsPath} says ${size}`);
    if (sha256Hex(bytes) !== sha256) problems.push(`${path} SHA-256 differs from ${checksumsPath}`);
  }
  if (JSON.stringify(listed) !== JSON.stringify([...listed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))) problems.push(`${checksumsPath} is not sorted by path`);
  return problems;
}
