// Checks the OpenVaultDB publisher manifest of a git repository, as the Directory will read it (HEAD, tracked
// files only). Offline. Usage: node scripts/check-ovdb-manifest.mjs [--repository <https url>] [<directory>]
//   --repository  the repository the manifest must say it is in (publisher.repository); optional
//   <directory>   the repository root; default: this repository
// A shared-model manifest (a hoster's) is checked for shape only: the notes below the result say what the
// OVDB Directory checks that this cannot. Exit 0 when the manifest is good, 1 when it is not.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepoFiles, reportOvdbManifest } from './lib/ovdb-manifest.mjs';

const args = process.argv.slice(2);
let repository;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repository') repository = args[++i];
  else positional.push(args[i]);
}
if (positional.length > 1 || (repository === undefined && args.includes('--repository')) || args.some((arg) => arg.startsWith('--') && arg !== '--repository')) {
  console.error('usage: node scripts/check-ovdb-manifest.mjs [--repository <https url>] [<directory>]');
  process.exit(2);
}
const root = resolve(positional[0] ?? dirname(dirname(fileURLToPath(import.meta.url))));
const { problems, notes } = reportOvdbManifest(gitRepoFiles(root), { repository });
if (problems.length > 0) {
  for (const problem of problems) console.error(`ovdb manifest: ${problem}`);
  process.exit(1);
}
console.log(`OVDB manifest check passed for ${root} (HEAD).`);
for (const note of notes) console.log(`note: ${note}`);
