// Checks the meaning graph with the pinned meaninggraph tool:
//   meaninggraph check model --graph github.com/meaninggraph/core=<checkout of core at the commit the meaning file pins>
// The commit is read from the meaning file's own ?ref= pins (one pin, a full commit id), never written a second time
// here. The checkout comes from the resolver in scripts/lib/meaning.mjs (a shallow fetch of that commit, kept in
// .cache/meaning-sources under its id and made that commit again before it is reused). meaninggraph reads the
// checkout's .git/HEAD and refuses a checkout at another commit than the pin, which is the proof the right graph was
// used. Exit codes are the tool's: 0 clean, 1 findings, 2 usage or unreadable (also: no single pin, no checkout).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { coreRepo, createResolver, pinsOf } from './lib/meaning.mjs';
import { ToolsError, commandLine, root, runTool } from './lib/tools.mjs';

export const meaningFile = 'model/chinook.meaning.yaml';
export const meaningDir = 'model';

/** The one commit of meaninggraph/core that the meaning file's references pin. */
export function corePin(text) {
  const pins = pinsOf(parseYaml(text), coreRepo);
  if (pins.length !== 1) throw new ToolsError(`${meaningFile} must pin ${coreRepo} to exactly one commit, found ${JSON.stringify(pins)}`, 2);
  if (!/^[0-9a-f]{40}$/.test(pins[0])) throw new ToolsError(`${meaningFile} pins ${coreRepo} to "${pins[0]}", which is not a full 40-digit commit id`, 2);
  return pins[0];
}

/** The arguments of `meaninggraph check` for the meaning file at `file`, with the core checkout at its pin from `resolve`. */
export function checkArguments({ file = join(root, meaningFile), resolve }) {
  const pin = corePin(readFileSync(file, 'utf8'));
  const core = resolve(coreRepo, pin);
  if (core.error) throw new ToolsError(core.error, 2);
  return ['check', meaningDir, '--graph', `${coreRepo}=${core.dir}`];
}

export function main(options = {}) {
  const resolve = options.resolve ?? createResolver({ root });
  try {
    // The arguments (and so the checkout) are prepared after the binary is found: a missing tool needs no network.
    return runTool('meaninggraph', () => checkArguments({ resolve }), options.run ? { run: options.run } : {});
  } finally {
    resolve.dispose?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await commandLine(main);
