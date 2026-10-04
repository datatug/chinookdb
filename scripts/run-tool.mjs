// Runs one of the pinned tools from the directory the installer filled (.tools/bin, or $TOOLS_BIN):
//   node scripts/run-tool.mjs <modelspec|meaninggraph> <arguments...>
// It exits with the tool's own code (0 clean, 1 findings, 2 usage), and with 2 and a pointer to
// `pnpm tools:install` when the binary is missing or is not the pinned release.
import { fileURLToPath } from 'node:url';
import { ToolsError, commandLine, loadPins, runTool } from './lib/tools.mjs';

export function main(argv = process.argv.slice(2), options = {}) {
  const pins = options.pins ?? loadPins();
  const [name, ...args] = argv;
  if (!name || !pins.tools[name]) throw new ToolsError(`usage: node scripts/run-tool.mjs <${Object.keys(pins.tools).join('|')}> <arguments...>`, 2);
  return runTool(name, args, { ...options, pins });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await commandLine(main);
