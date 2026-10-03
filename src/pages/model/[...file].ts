// Publishes the git-tracked files under model/ (no dotfiles) at /model/<path>,
// byte for byte, so the published files are exactly the ones
// model/checksums.json lists (scripts/generate-model.mjs uses the same
// listTrackedFiles). The Worker sets their content types (src/worker.ts).
import type { APIRoute, GetStaticPaths } from 'astro';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTrackedFiles } from '../../../scripts/lib/checksums.mjs';

const modelDir = join(process.cwd(), 'model');

export const getStaticPaths = (() => listTrackedFiles(process.cwd(), 'model').map((file: string) => ({ params: { file } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ params }) => new Response(readFileSync(join(modelDir, params.file!)));
