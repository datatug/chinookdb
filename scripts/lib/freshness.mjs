// The build marker of chinookdb.com and the check that a deploy reached the live site.
//
// chinookdb.com is built from this repository alone, so its marker (dist/build-info.json, served at
// MARKER_PATH) records only the commit. After a deploy the live marker is compared with the one just
// built. Everything takes `fetch` (and the sleep) as a parameter, so the tests never touch the network.
//
// Everything fetched from a public URL is untrusted: it is shape-checked before it is printed (a commit
// is 40 hex digits, anything else prints as "invalid"), and any other text is cleaned by `printable` (no
// control characters, no run of colons that could make `::` start a log command).

export const MARKER_PATH = '/build-info.json';
export const BUILD_INFO_FORMAT = 'chinookdb-build/1';

export class FreshnessError extends Error {}

const COMMIT = /^[0-9a-f]{40}$/;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The content of dist/build-info.json for a build of `commit` (a full 40-digit commit id). */
export function buildInfo(commit) {
  if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) throw new FreshnessError(`the build commit must be a full 40-digit commit id, got ${JSON.stringify(printable(commit, 60))}`);
  return {format: BUILD_INFO_FORMAT, commit: commit.toLowerCase()};
}

/** Text that is safe to put in a log line, a notice or the job summary. */
export const printable = (value, max = 300) => String(value ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/:{2,}/g, ' ').slice(0, max);
export const shortChecksum = value => (typeof value === 'string' && CHECKSUM.test(value) ? value.slice(0, 19) : 'invalid');
export const shortCommit = value => (typeof value === 'string' && COMMIT.test(value) ? value.slice(0, 12) : 'invalid');

// GET url and parse it as JSON, retrying network errors, timeouts and HTTP 5xx. Throws FreshnessError.
export async function fetchJson(fetchImpl, url, {attempts = 3, timeoutMs = 20_000, retryDelayMs = 2_000, sleep = wait} = {}) {
  let failure = 'no attempt was made';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(retryDelayMs);
    let response;
    try {
      response = await fetchImpl(url, {headers: {'cache-control': 'no-cache', 'user-agent': 'site-autodeploy'}, signal: AbortSignal.timeout(timeoutMs)});
    } catch (error) {
      failure = printable(error?.message ?? error, 120);
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
      throw new FreshnessError(`${url} is not valid JSON: ${printable(error.message, 80)}`);
    }
  }
  throw new FreshnessError(`cannot fetch ${url}: ${failure}`);
}

// What a live (or just built) build marker says it is made of.
export function markerFacts(marker) {
  const checksums = marker && typeof marker === 'object' && marker.checksums && typeof marker.checksums === 'object' ? marker.checksums : {};
  return {commit: typeof marker?.commit === 'string' ? marker.commit : '', checksums};
}

// Pure. `live` is the parsed live marker (null when unreadable); `commit` and `checksums` are what a build
// made now would record ({name: checksum}; this site has none). Returns {changed, reasons}; no reasons means current.
export function compareBuild({live, commit, checksums = {}}) {
  if (!live || typeof live !== 'object') return {changed: true, reasons: ['the live build marker is missing or unreadable']};
  const facts = markerFacts(live);
  const reasons = [];
  if (!facts.commit) reasons.push('the live build marker records no site commit');
  else if (facts.commit !== commit) reasons.push(`site commit ${shortCommit(facts.commit)} is live, ${shortCommit(commit)} is current`);
  for (const [name, checksum] of Object.entries(checksums)) {
    const liveChecksum = facts.checksums[name];
    if (typeof liveChecksum !== 'string' || liveChecksum === '') reasons.push(`the live build marker records no checksum for the ${name} index`);
    else if (liveChecksum !== checksum) reasons.push(`the ${name} index changed (${shortChecksum(liveChecksum)} is live, ${shortChecksum(checksum)} is current)`);
  }
  return {changed: reasons.length > 0, reasons};
}

export const SMOKE_DELAYS_MS = [5_000, 10_000, 15_000, 20_000, 30_000, 30_000, 30_000];

// After a deploy: does the live site serve the build whose marker is `built`? Retries with growing waits
// (about two and a half minutes in all), because the new version takes a moment to reach every edge.
// Returns {ok, reasons}.
export async function verifyLive({fetch: fetchImpl = globalThis.fetch, markerUrl, built, delaysMs = SMOKE_DELAYS_MS, sleep = wait, fetchOptions = {}}) {
  const facts = markerFacts(built);
  if (!COMMIT.test(facts.commit)) return {ok: false, reasons: ['the build marker records no valid site commit, so there is nothing to confirm']};
  let reasons = [];
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) await sleep(delaysMs[attempt - 1]);
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

// After a deploy: does `url` answer 200? Same retries as verifyLive.
export async function expectOk({fetch: fetchImpl = globalThis.fetch, url, delaysMs = SMOKE_DELAYS_MS, sleep = wait}) {
  let reason = '';
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) await sleep(delaysMs[attempt - 1]);
    try {
      const response = await fetchImpl(url, {headers: {'user-agent': 'site-autodeploy'}, signal: AbortSignal.timeout(20_000)});
      if (response.status === 200) return {ok: true, reason: ''};
      reason = `${url} answered HTTP ${response.status}`;
    } catch (error) {
      reason = `${url}: ${printable(error?.message ?? error, 120)}`;
    }
  }
  return {ok: false, reason};
}
