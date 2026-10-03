// CI guard: fails when published data changes without a regenerated checksums
// file and a change under data-source/. Usage: node scripts/check-data-drift.mjs <base-revision>
import { execFileSync } from 'node:child_process';
import { evaluateDrift } from './lib/drift.mjs';
import { cleanGitEnv } from './lib/git-env.mjs';

const base = process.argv[2];
if (!base || /^0+$/.test(base)) {
  console.log('No base revision to compare with; data drift guard skipped.');
  process.exit(0);
}
const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8', env: cleanGitEnv() }).split('\n').filter(Boolean);
const problems = evaluateDrift(changed);
if (problems.length > 0) {
  for (const problem of problems) console.error(`data drift: ${problem}`);
  process.exit(1);
}
console.log(`Data drift guard passed against ${base} (${changed.length} changed files).`);
