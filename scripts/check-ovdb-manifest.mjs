// Checks the OpenVaultDB publisher manifest of a git repository, offline, as git holds it at HEAD (tracked files
// only). Usage: node scripts/check-ovdb-manifest.mjs [--repository <https url>] [<directory>]
//   --repository  the repository the manifest must say it is in (publisher.repository); optional
//   <directory>   where OVDB.md is; default: the root of this repository. A subdirectory of a repository is checked
//                 as if it were the root (paths in OVDB.md and the manifest are read relative to it), and says so:
//                 the Directory reads OVDB.md at the root of the repository.
// This is a pre-check, not the OVDB Directory's verdict. The Directory is the authority; the notes it prints (for both
// forms of manifest) say what is not checked here. Exit 0 when nothing is wrong, 1 when something is, 2 on bad usage.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanGitEnv } from './lib/git-env.mjs';
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
let top;
try {
  top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { stdio: 'pipe', env: cleanGitEnv() }).toString().trim();
} catch { /* not a repository: the report says so */ }
if (top !== undefined && realpathSync(top) !== realpathSync(root)) {
  notes.push(`${root} is a subdirectory of the repository at ${top}: its OVDB.md and manifest were checked as if it were the repository root. The Directory reads OVDB.md at the root of the repository.`);
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`ovdb manifest: ${problem}`);
  for (const note of notes) console.error(`note: ${note}`);
  process.exit(1);
}
console.log(`OVDB manifest pre-check found nothing wrong in ${root} (HEAD). This is an offline pre-check; the OVDB Directory is the authority.`);
for (const note of notes) console.log(`note: ${note}`);
