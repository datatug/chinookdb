// Installs the pinned release of modelspec and meaninggraph (scripts/tools.json) into a directory:
//   node scripts/install-tools.mjs --dir .tools/bin [modelspec] [meaninggraph]     (pnpm tools:install)
// Each archive is downloaded from its GitHub release and its SHA-256 is checked against the pin before it is
// unpacked. Exit 0 installed, 1 a wrong hash or a failed download (nothing installed), 2 a usage error or a
// platform with no pinned build.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolsError, commandLine, installTool, loadPins } from './lib/tools.mjs';

export function parseArguments(argv, tools) {
  let dir;
  const names = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') {
      dir = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith('--')) throw new ToolsError(`unknown option ${argv[i]}; usage: node scripts/install-tools.mjs --dir <directory> [${tools.join('] [')}]`, 2);
    else names.push(argv[i]);
  }
  if (!dir) throw new ToolsError(`--dir is required: the directory to put the binaries in; usage: node scripts/install-tools.mjs --dir <directory> [${tools.join('] [')}]`, 2);
  for (const name of names) if (!tools.includes(name)) throw new ToolsError(`unknown tool ${name}; pinned: ${tools.join(', ')}`, 2);
  return { dir: resolve(dir), names: names.length > 0 ? names : tools };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const pins = options.pins ?? loadPins();
  const { dir, names } = parseArguments(argv, Object.keys(pins.tools));
  for (const name of names) {
    const done = await installTool(name, { ...options, pins, dir });
    const log = options.log ?? console.log;
    log(`installed ${done.name} ${done.version} (${done.key}, sha256 ${done.sha256}) in ${dir}`);
    log(`wrote receipt ${done.receipt} (binary sha256 ${done.binarySha256})`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await commandLine(main);
