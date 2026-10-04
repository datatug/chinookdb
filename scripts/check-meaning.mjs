// Checks the meaning graph with the pinned meaninggraph tool, in one run:
//   meaninggraph check model <core> --address <this repository>=model --graph github.com/meaninggraph/core=<core>
// <core> is a checkout of meaninggraph/core at the commit the meaning file pins. Naming it both as a path to check and
// as the directory --graph supplies makes it a graph checked in full, once, with every rule (as the repository's own
// checker did), and the model's graph is checked with it supplied. --address gives this repository's graph its address
// (read from ovdb.yaml, meaning.graph.address, where check:ovdb already holds it to the repository), so a meaning://
// reference from the file to its own repository resolves. The paths are the same spelling in all three places: the
// tool compares them as written, made absolute and cleaned.
// The commit is read from the meaning file's own ?ref= pins (one pin, a full commit id), never written a second time
// here; a meaning file with no reference to core is refused (Chinook depends on it). The checkout comes from the
// resolver in scripts/lib/meaning.mjs (a shallow fetch of that commit, kept in .cache/meaning-sources under its id
// and made that commit again before it is reused). meaninggraph reads the checkout's .git/HEAD and refuses a
// checkout at another commit than the pin, which is the proof the right graph was used. It validates against the
// schema embedded in its own binary: scripts/check-schema.mjs compares that with the checkout's meaning.schema.json.
// The exit code is the tool's: 0 clean, 1 findings, 2 usage or unreadable (also: no single pin, no checkout, a file
// that is not YAML).
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

/** The arguments of the one `meaninggraph check` run, with the core checkout at the meaning file's pin from `resolve`. */
export function checkArguments({ file = join(root, meaningFile), ovdb = join(root, ovdbFile), resolve }) {
  const core = coreCheckout({ file, resolve });
  const address = ownAddress(readText(ovdb));
  return ['check', meaningDir, core.dir, '--address', `${address}=${meaningDir}`, '--graph', `${coreRepo}=${core.dir}`];
}

/** The checkout of meaninggraph/core at the commit the meaning file at `file` pins, from `resolve`. */
export function coreCheckout({ file = join(root, meaningFile), resolve }) {
  const pin = corePin(readText(file));
  const core = resolve(coreRepo, pin);
  if (core.error) throw new ToolsError(core.error, 2);
  return { ...core, pin };
}

/** The pinned core checkout and the path of its meaning.schema.json. */
export function checkoutSchema({ file = join(root, meaningFile), resolve }) {
  const core = coreCheckout({ file, resolve });
  return { ...core, schemaFile: join(core.dir, 'meaning.schema.json') };
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
