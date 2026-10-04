// Checks the meaning graph with the pinned meaninggraph tool, in two runs (the tool accepts --address for one graph only):
//   meaninggraph check <core> --address github.com/meaninggraph/core
//   meaninggraph check model --address <this repository> --graph github.com/meaninggraph/core=<core>
// <core> is a checkout of meaninggraph/core at the commit the meaning file pins. The first run checks it as a graph in
// its own right (every rule, as the repository's own checker did); the second checks the model's meaning file with it
// supplied, and --address makes a meaning:// reference from the file to its own repository resolve. This repository's
// address is read from ovdb.yaml (meaning.graph.address), where check:ovdb already holds it to the repository.
// The commit is read from the meaning file's own ?ref= pins (one pin, a full commit id), never written a second time
// here; a meaning file with no reference to core is refused (Chinook depends on it). The checkout comes from the
// resolver in scripts/lib/meaning.mjs (a shallow fetch of that commit, kept in .cache/meaning-sources under its id
// and made that commit again before it is reused). meaninggraph reads the checkout's .git/HEAD and refuses a
// checkout at another commit than the pin, which is the proof the right graph was used. It validates against the
// schema embedded in its own binary, not the checkout's meaning.schema.json. Exit codes are the tool's, the highest
// of the two runs: 0 clean, 1 findings, 2 usage or unreadable (also: no single pin, no checkout, a file that is not YAML).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { coreRepo, createResolver, pinsOf } from './lib/meaning.mjs';
import { ToolsError, commandLine, root, runTool } from './lib/tools.mjs';

export const meaningFile = 'model/chinook.meaning.yaml';
export const meaningDir = 'model';
export const ovdbFile = 'ovdb.yaml';

const oneLine = (error) => String(error.message).split('\n')[0];
const readText = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new ToolsError(`cannot read ${file}: ${oneLine(error)}`, 2);
  }
};
const parseFile = (text, name) => {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new ToolsError(`${name} is not valid YAML: ${oneLine(error)}`, 2);
  }
};

/** This repository's own graph address, `github.com/<org>/<repo>`, from the meaning graph address in ovdb.yaml. */
export function ownAddress(text) {
  const address = parseFile(text, ovdbFile)?.meaning?.graph?.address;
  const match = /^meaning:\/\/([A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.exec(address ?? '');
  if (!match) throw new ToolsError(`${ovdbFile} meaning.graph.address must be meaning://<host>/<org>/<repo>, not ${JSON.stringify(address)}`, 2);
  return match[1];
}

/** The one commit of meaninggraph/core that the meaning file's references pin. */
export function corePin(text) {
  const pins = pinsOf(parseFile(text, meaningFile), coreRepo);
  if (pins.length !== 1) throw new ToolsError(`${meaningFile} must pin ${coreRepo} to exactly one commit, found ${JSON.stringify(pins)}`, 2);
  if (!/^[0-9a-f]{40}$/.test(pins[0])) throw new ToolsError(`${meaningFile} pins ${coreRepo} to "${pins[0]}", which is not a full 40-digit commit id`, 2);
  return pins[0];
}

/** The argument lists of the two `meaninggraph check` runs, with the core checkout at the meaning file's pin from `resolve`. */
export function checkInvocations({ file = join(root, meaningFile), ovdb = join(root, ovdbFile), resolve }) {
  const pin = corePin(readText(file));
  const address = ownAddress(readText(ovdb));
  const core = resolve(coreRepo, pin);
  if (core.error) throw new ToolsError(core.error, 2);
  return [
    ['check', core.dir, '--address', coreRepo],
    ['check', meaningDir, '--address', address, '--graph', `${coreRepo}=${core.dir}`],
  ];
}

export function main(options = {}) {
  const resolve = options.resolve ?? createResolver({ root });
  const run = options.run ? { run: options.run } : {};
  try {
    // The arguments (and so the checkout) are prepared after the binary is found: a missing tool needs no network.
    let invocations;
    const nth = (n) => () => (invocations ??= checkInvocations({ resolve }))[n];
    return Math.max(runTool('meaninggraph', nth(0), run), runTool('meaninggraph', nth(1), run));
  } finally {
    resolve.dispose?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await commandLine(main);
