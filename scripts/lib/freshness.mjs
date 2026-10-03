// The build marker of chinookdb.com and the check that a deploy reached the live site.
//
// chinookdb.com is built from this repository alone, so its marker (dist/build-info.json, served at
// MARKER_PATH) records only the commit. After a deploy the live marker is compared with the one just
// built. Everything takes `fetch` as a parameter, so the tests never touch the network.

export const MARKER_PATH = '/build-info.json';
export const BUILD_INFO_FORMAT = 'chinookdb-build/1';

export class FreshnessError extends Error {}

/** The content of dist/build-info.json for a build of `commit` (a full 40-digit commit id). */
export function buildInfo(commit) {
  if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) throw new FreshnessError(`the build commit must be a full 40-digit commit id, got ${JSON.stringify(commit)}`);
  return {format: BUILD_INFO_FORMAT, commit: commit.toLowerCase()};
}

const short = value => (typeof value === 'string' && value.length > 12 ? value.slice(0, 12) : String(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// GET url and parse it as JSON, retrying network errors, timeouts and HTTP 5xx. Throws FreshnessError.
export async function fetchJson(fetchImpl, url, {attempts = 3, timeoutMs = 20_000, retryDelayMs = 2_000, sleep = wait} = {}) {
  let failure = 'no attempt was made';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(retryDelayMs);
    let response;
    try {
      response = await fetchImpl(url, {headers: {'cache-control': 'no-cache', 'user-agent': 'site-autodeploy'}, signal: AbortSignal.timeout(timeoutMs)});
    } catch (error) {
      failure = error?.message ?? String(error);
      continue;
    }
    if (response.status >= 500) {
      failure = `HTTP ${response.status}`;
      continue;
    }
    if (!response.ok) throw new FreshnessError(`cannot read ${url}: HTTP ${response.status}`);
    try {
      return JSON.parse(await response.text());
    } catch (error) {
      throw new FreshnessError(`${url} is not valid JSON: ${error.message}`);
    }
  }
  throw new FreshnessError(`cannot fetch ${url}: ${failure}`);
}

// What a live (or just built) build marker says it is made of.
export function markerFacts(marker) {
  const checksums = marker && typeof marker === 'object' && marker.checksums && typeof marker.checksums === 'object' ? marker.checksums : {};
  return {commit: typeof marker?.commit === 'string' ? marker.commit : '', checksums};
}

// Pure. `live` is the parsed live marker (null when unreadable); `commit` is what a build made now would
// record. Returns {changed, reasons}; no reasons means current. (`checksums`, {name: checksum}, is
// compared too when given: this site has none.)
export function compareBuild({live, commit, checksums = {}}) {
  if (!live || typeof live !== 'object') return {changed: true, reasons: ['the live build marker is missing or unreadable']};
  const facts = markerFacts(live);
  const reasons = [];
  if (!facts.commit) reasons.push('the live build marker records no site commit');
  else if (facts.commit !== commit) reasons.push(`site commit ${short(facts.commit)} is live, ${short(commit)} is current`);
  for (const [name, checksum] of Object.entries(checksums)) {
    const liveChecksum = facts.checksums[name];
    if (typeof liveChecksum !== 'string' || liveChecksum === '') reasons.push(`the live build marker records no checksum for the ${name} index`);
    else if (liveChecksum !== checksum) reasons.push(`the ${name} index changed (${short(liveChecksum)} is live, ${short(checksum)} is current)`);
  }
  return {changed: reasons.length > 0, reasons};
}

// After a deploy: does the live site serve the build whose marker is `built`? Retries, because the
// new version takes a moment to reach every edge. Returns {ok, reasons}.
export async function verifyLive({fetch: fetchImpl = globalThis.fetch, markerUrl, built, attempts = 6, delayMs = 10_000, sleep = wait, fetchOptions = {}}) {
  const facts = markerFacts(built);
  if (!facts.commit) return {ok: false, reasons: ['the build marker records no site commit, so there is nothing to confirm']};
  let reasons = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(delayMs);
    try {
      const live = await fetchJson(fetchImpl, markerUrl, {attempts: 1, sleep, ...fetchOptions});
      ({reasons} = compareBuild({live, commit: facts.commit, checksums: facts.checksums}));
      if (reasons.length === 0) return {ok: true, reasons: []};
    } catch (error) {
      reasons = [error.message];
    }
  }
  return {ok: false, reasons};
}
