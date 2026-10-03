// After a deploy: confirms the live site serves the build just made. The live /build-info.json must record
// this build's commit (retried for about a minute while the new version spreads), and the home page and
// /downloads/ must answer 200.
//
//   node scripts/smoke-live.mjs
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER_PATH, verifyLive } from './lib/freshness.mjs';

export const SITE_URL = 'https://chinookdb.com';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const built = JSON.parse(await readFile(join(root, 'dist', MARKER_PATH), 'utf8'));
    const { ok, reasons } = await verifyLive({ markerUrl: `${SITE_URL}${MARKER_PATH}`, built });
    if (!ok) throw new Error(`${SITE_URL} does not serve this build: ${reasons.join('; ')}`);
    for (const path of ['/', '/downloads/']) {
      const response = await fetch(`${SITE_URL}${path}`, { signal: AbortSignal.timeout(20_000) });
      if (response.status !== 200) throw new Error(`${SITE_URL}${path} answered HTTP ${response.status}`);
    }
    const line = `Deployed and confirmed: ${SITE_URL} serves commit ${built.commit.slice(0, 12)}.`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
