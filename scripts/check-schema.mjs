// Checks that the meaning-file schema the pinned meaninggraph embeds is the schema of the core checkout the meaning
// file pins:
//   meaninggraph schema          the embedded schema, byte for byte, compared with <core>/meaning.schema.json
//   meaninggraph schema --source the core commit the embedded schema was taken from, compared with the pin
// The bytes are what matters, since they are what `meaninggraph check` validates against: a pin that moves to a core
// commit with another schema fails here until the tool pin moves too. The commits may differ (a core commit that does
// not change the schema differs in --source and not in the schema), and then the line says so and the check passes;
// a different schema fails whatever --source says. Exit 0 the same, 1 different, 2 usage or unreadable.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkoutSchema } from './check-meaning.mjs';
import { createResolver } from './lib/meaning.mjs';
import { ToolsError, captureTool, commandLine, root } from './lib/tools.mjs';

const text = (buffer) => buffer.toString('utf8').trim();

/** Compares the tool's schema with the checkout's. Returns { ok, message }. */
export function compareSchema({ tool, source, schemaFile, pin }) {
  let expected;
  try {
    expected = readFileSync(schemaFile);
  } catch (error) {
    throw new ToolsError(`cannot read ${schemaFile}: ${String(error.message).split('\n')[0]}`, 2);
  }
  const from = text(source);
  if (!/^[0-9a-f]{40}$/.test(from)) throw new ToolsError(`meaninggraph schema --source printed "${from}", not a 40-digit commit id`, 2);
  if (!tool.equals(expected)) {
    return { ok: false, message: `the schema embedded in meaninggraph (core commit ${from}, ${tool.length} bytes) is not ${schemaFile} (core commit ${pin}, ${expected.length} bytes); move the tool pin in scripts/tools.json to a release built from a core commit with that schema, or the pin back` };
  }
  return { ok: true, message: `ok: the schema embedded in meaninggraph is the schema of core at ${pin}${from === pin ? '' : ` (the tool took it from core ${from}, another commit with the same schema)`}` };
}

export function main(options = {}) {
  const resolve = options.resolve ?? createResolver({ root });
  const run = options.run ? { run: options.run } : {};
  try {
    // Locating the binary comes first: a missing tool needs no network.
    const tool = captureTool('meaninggraph', ['schema'], run);
    if (tool.status !== 0) throw new ToolsError(`meaninggraph schema exited ${tool.status}: ${tool.stderr.trim().split('\n')[0]}`, 2);
    const source = captureTool('meaninggraph', ['schema', '--source'], run);
    if (source.status !== 0) throw new ToolsError(`meaninggraph schema --source exited ${source.status}: ${source.stderr.trim().split('\n')[0]}`, 2);
    const core = checkoutSchema({ resolve });
    const result = compareSchema({ tool: tool.stdout, source: source.stdout, schemaFile: core.schemaFile, pin: core.pin });
    (result.ok ? console.log : console.error)(result.message);
    return result.ok ? 0 : 1;
  } finally {
    resolve.dispose?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await commandLine(main);
