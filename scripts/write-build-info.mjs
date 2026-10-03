// Writes dist/build-info.json, the marker the deploy workflow reads back from the live site to confirm that
// it serves the build it just deployed. Run it after `pnpm build` (it refuses to run without dist/):
//
//   BUILD_COMMIT=<40-digit commit> node scripts/write-build-info.mjs
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER_PATH, buildInfo, printable } from './lib/freshness.mjs';

export async function writeBuildInfo({ root, commit }) {
  const info = buildInfo(commit);
  const dist = join(root, 'dist');
  if (!(await stat(dist).catch(() => null))?.isDirectory()) throw new Error(`${dist} does not exist: run pnpm build first`);
  const file = join(dist, MARKER_PATH);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(info, null, 2)}\n`);
  return { file, info };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const { file, info } = await writeBuildInfo({ root, commit: process.env.BUILD_COMMIT });
    console.log(`Wrote ${file} (commit ${info.commit.slice(0, 12)}).`);
  } catch (error) {
    console.error(`::error::${printable(error.message)}`);
    process.exit(1);
  }
}
