// Publishes every file under model/ at /model/<path>, byte for byte, so the
// published files are exactly the ones model/checksums.json lists. The Worker
// sets their content types (src/worker.ts).
import type { APIRoute, GetStaticPaths } from 'astro';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const modelDir = join(process.cwd(), 'model');

function listFiles(prefix = ''): string[] {
  return readdirSync(join(modelDir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

export const getStaticPaths = (() => listFiles().map((file) => ({ params: { file } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ params }) => new Response(readFileSync(join(modelDir, params.file!)));
