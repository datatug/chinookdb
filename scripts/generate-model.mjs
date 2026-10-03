// Writes model/chinook.modelspec.json (the ModelSpec JSON AST of
// model/chinook.modelspec.hcl) and model/checksums.json (SHA-256 and size of
// every git-tracked file published under /model/). Deterministic: running it twice
// produces the same bytes.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChecksums, listTrackedFiles, serializeChecksums } from './lib/checksums.mjs';
import { parseHcl, serializeModel, toModelspecJson, validateModel } from './lib/modelspec.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const modelDir = join(root, 'model');
export const modelChecksumsPath = 'checksums.json';
// Standalone ModelSpec HCL has no place for module identity, so it is stated
// here. Bump `version` whenever the model changes.
export const chinookModule = { id: 'github.com/datatug/chinookdb/model/chinook', name: 'chinook', version: '0.1.0' };

export async function buildModelJson() {
  const hcl = await readFile(join(modelDir, 'chinook.modelspec.hcl'), 'utf8');
  const json = toModelspecJson(parseHcl(hcl), chinookModule);
  const problems = validateModel(json);
  if (problems.length > 0) throw new Error(`model/chinook.modelspec.hcl is not valid ModelSpec:\n${problems.join('\n')}`);
  return serializeModel(json);
}

// The files published under /model/: git-tracked, no dotfiles. The page
// src/pages/model/[...file].ts publishes exactly this list.
export const listModelFiles = () => listTrackedFiles(root, 'model');

export const buildModelChecksums = () => buildChecksums(modelDir, { repository: 'https://github.com/datatug/chinookdb', directory: 'model' }, {
  exclude: modelChecksumsPath,
  files: listModelFiles(),
  note: 'Paths are relative to /model/. This file lists every other published model file with its SHA-256 and size in bytes.',
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(join(modelDir, 'chinook.modelspec.json'), await buildModelJson());
  // Written last, from the bytes now on disk.
  await writeFile(join(modelDir, modelChecksumsPath), serializeChecksums(await buildModelChecksums()));
  console.log('Generated model/chinook.modelspec.json and model/checksums.json');
}
