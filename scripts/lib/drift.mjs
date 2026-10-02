import { checksumsPath } from './checksums.mjs';

const dataPrefix = 'public/data/';
const checksumsFile = `${dataPrefix}${checksumsPath}`;

// Decides whether a change to the published data is allowed. `changed` lists
// repository paths that differ from the base revision. Published data may only
// change together with a regenerated checksums file and a change under
// data-source/ (a new upstream input, or a note in data-source/README.md that
// says why the generator output changed).
export function evaluateDrift(changed) {
  const dataChanged = changed.filter((path) => path.startsWith(dataPrefix) && path !== checksumsFile);
  if (dataChanged.length === 0) return [];
  const problems = [];
  if (!changed.includes(checksumsFile)) problems.push(`published data changed but ${checksumsFile} did not (run pnpm generate and commit the result)`);
  if (!changed.some((path) => path.startsWith('data-source/'))) problems.push('published data changed but nothing under data-source/ did (change the input, or add a dated entry to the revision history in data-source/README.md)');
  if (problems.length > 0) problems.push(`changed data files: ${dataChanged.slice(0, 5).join(', ')}${dataChanged.length > 5 ? `, and ${dataChanged.length - 5} more` : ''}`);
  return problems;
}
