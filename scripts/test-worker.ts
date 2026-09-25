import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const wrangler = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8')) as { assets: { run_worker_first: string[] } };
assert.ok(wrangler.assets.run_worker_first.includes('/data/*'), 'wrangler must route /data/* through the Worker first');
assert.ok(wrangler.assets.run_worker_first.includes('/ovdb'), 'wrangler must route /ovdb through the Worker first');
assert.ok(wrangler.assets.run_worker_first.includes('/ovdb/*'), 'wrangler must route /ovdb/* through the Worker first');
assert.ok(wrangler.assets.run_worker_first.includes('/.well-known/openvaultdb'), 'wrangler must route discovery through the Worker first');

const assets = {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const filePath = join(root, 'dist', url.pathname, url.pathname.endsWith('/') ? 'index.html' : '');
    try {
      const body = await readFile(filePath);
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: { 'Content-Type': url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream' },
      });
    } catch {
      return new Response('<!doctype html><title>Not found</title>', { status: 404, headers: { 'Content-Type': 'text/html' } });
    }
  },
};

const cacheEntries = new Map<string, Response>();
const cache = {
  async match(request: Request) { return cacheEntries.get(request.url)?.clone(); },
  async put(request: Request, response: Response) { cacheEntries.set(request.url, response.clone()); },
};
(globalThis as typeof globalThis & { caches?: { default?: typeof cache } }).caches = { default: cache };
const ctx = { waitUntil(promise: Promise<unknown>) { void promise; } } as ExecutionContext;

async function request(path: string, method: string, env: Record<string, unknown> = {}) {
  return worker.fetch(new Request(`https://chinookdb.com${path}`, { method }), { ASSETS: assets, ...env }, ctx);
}

const json = await request('/data/json/chinook.Artist.json', 'GET');
assert.equal(json.status, 200);
assert.equal(json.headers.get('Access-Control-Allow-Origin'), '*');
assert.match(json.headers.get('Cache-Control') ?? '', /^public,/);
assert.equal(json.headers.get('Content-Type'), 'application/json; charset=utf-8');
assert.equal((await json.json()).length, 275);

const sqlite = await request('/data/chinook.sqlite', 'GET');
assert.equal(sqlite.status, 200);
assert.equal(sqlite.headers.get('Content-Type'), 'application/vnd.sqlite3');

const head = await request('/data/json/chinook.Artist.json', 'HEAD');
assert.equal(head.status, 200);
assert.equal(await head.text(), '');
assert.equal(head.headers.get('Access-Control-Allow-Origin'), '*');

const options = await request('/data/json/chinook.Artist.json', 'OPTIONS');
assert.equal(options.status, 204);
assert.equal(options.headers.get('Access-Control-Allow-Origin'), '*');
assert.equal(options.headers.get('Access-Control-Max-Age'), '86400');

const missing = await request('/data/json/not-a-real-file.json', 'GET');
assert.equal(missing.status, 404);
assert.equal(missing.headers.get('Access-Control-Allow-Origin'), '*');
assert.equal(missing.headers.get('Cache-Control'), 'no-store');
assert.equal(missing.headers.get('Content-Type'), 'application/json; charset=utf-8');
assert.deepEqual(await missing.json(), { error: 'Not found' });

const missingHead = await request('/data/json/not-a-real-file.json', 'HEAD');
assert.equal(missingHead.status, 404);
assert.equal(await missingHead.text(), '');

const method = await request('/data/json/chinook.Artist.json', 'POST');
assert.equal(method.status, 405);
assert.equal(method.headers.get('Access-Control-Allow-Origin'), '*');

const discovery = await request('/ovdb/v1/databases', 'GET');
assert.equal(discovery.status, 200);
assert.deepEqual(await discovery.json(), { databases: [{ id: 'chinook', engine: 'static-json', schemaMode: 'strict', collections: ['Album', 'Artist', 'Customer', 'Employee', 'Genre', 'Invoice', 'InvoiceLine', 'MediaType', 'Playlist', 'PlaylistTrack', 'Track'], readOnly: true }] });
assert.match(discovery.headers.get('Cache-Control') ?? '', /max-age=86400/);

const wellKnown = await request('/.well-known/openvaultdb', 'GET');
assert.equal(wellKnown.status, 200);
assert.equal(wellKnown.headers.get('Access-Control-Allow-Origin'), '*');
assert.deepEqual(await wellKnown.json(), {
  name: 'ChinookDB OpenVaultDB', protocol: 'openvaultdb/0.1', version: '1.0.0', authEnabled: false,
  databases: [{ id: 'chinook', url: 'https://chinookdb.com/ovdb/dbs/chinook', apiUrl: 'https://chinookdb.com/ovdb/v1/databases/chinook', capabilities: { read: true, query: true, write: false } }],
});

for (const [path, heading, link] of [
  ['/ovdb/', 'Chinook over OVDB', '/ovdb/dbs/'],
  ['/ovdb/dbs/', 'Databases', '/ovdb/dbs/chinook'],
  ['/ovdb/dbs/chinook', 'Chinook', '/tables/Album/'],
] as const) {
  const page = await request(path, 'GET');
  assert.equal(page.status, 200, path);
  assert.equal(page.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.match(page.headers.get('Link') ?? '', /rel="describedby"/);
  assert.match(page.headers.get('Link') ?? '', /rel="canonical"/);
  const html = await page.text();
  assert.match(html, new RegExp(`<h1[^>]*>${heading}</h1>`));
  assert.ok(html.includes(`href="${link}"`), `${path} must link to ${link}`);
  assert.ok(!html.includes('<script'), `${path} must work without JavaScript`);
  const headPage = await request(path, 'HEAD');
  assert.equal(headPage.status, 200);
  assert.equal(await headPage.text(), '');
}

const unknownDb = await request('/ovdb/dbs/not-real', 'GET');
assert.equal(unknownDb.status, 404);
assert.equal(unknownDb.headers.get('Content-Type'), 'text/html; charset=utf-8');
assert.match(await unknownDb.text(), /Browse available databases/);
const maliciousDb = await request('/ovdb/dbs/%3Cscript%3E', 'GET');
assert.equal(maliciousDb.status, 404);
assert.ok(!(await maliciousDb.text()).includes('<script>'));

const artist = await request('/ovdb/v1/databases/chinook/read?key=Artist%2F1', 'GET');
assert.equal(artist.status, 200);
assert.deepEqual(await artist.json(), { key: 'Artist/1', data: { ArtistId: 1, Name: 'AC/DC' } });
assert.equal(artist.headers.get('Access-Control-Allow-Origin'), '*');

const playlistTrack = await request('/ovdb/v1/databases/chinook/read?key=PlaylistTrack%2F1%2C3402', 'GET');
assert.equal(playlistTrack.status, 200);
assert.deepEqual(await playlistTrack.json(), { key: 'PlaylistTrack/1,3402', data: { PlaylistId: 1, TrackId: 3402 } });

const query = encodeURIComponent(JSON.stringify({ collection: 'Artist', where: [{ field: 'Name', op: '==', value: 'AC/DC' }], keysOnly: true }));
const queried = await request(`/ovdb/v1/databases/chinook/query?q=${query}`, 'GET');
assert.equal(queried.status, 200);
assert.deepEqual(await queried.json(), { records: [{ key: 'Artist/1' }] });

const unboundedQuery = encodeURIComponent(JSON.stringify({ collection: 'Track', keysOnly: true }));
const unbounded = await request(`/ovdb/v1/databases/chinook/query?q=${unboundedQuery}`, 'GET');
assert.equal(unbounded.status, 200);
assert.equal((await unbounded.json()).records.length, 3503);

const invalidQuery = await request('/ovdb/v1/databases/chinook/query?q=%7B%22collection%22%3A%22Nope%22%7D', 'GET');
assert.equal(invalidQuery.status, 400);
assert.equal((await invalidQuery.json()).error.code, 'bad_request');

const unsupportedQuery = await request('/ovdb/v1/databases/chinook/query?q=%7B%22collection%22%3A%22Artist%22%2C%22offset%22%3A1%7D', 'GET');
assert.equal(unsupportedQuery.status, 400);
assert.equal((await unsupportedQuery.json()).error.code, 'bad_request');

const notFound = await request('/ovdb/v1/databases/chinook/read?key=Artist%2F999999', 'GET');
assert.equal(notFound.status, 404);
assert.equal((await notFound.json()).error.code, 'not_found');
assert.equal(notFound.headers.get('Cache-Control'), 'no-store');

const readonly = await request('/ovdb/v1/databases/chinook/read?key=Artist%2F1', 'POST');
assert.equal(readonly.status, 403);
assert.equal((await readonly.json()).error.code, 'read_only');

const customTtl = await request('/ovdb/v1/databases/chinook?ttl-test=1', 'GET', { OVDB_CACHE_TTL_SECONDS: '60' });
assert.match(customTtl.headers.get('Cache-Control') ?? '', /max-age=60/);

const disabledPath = '/ovdb/v1/databases/chinook?ttl-test=0';
cacheEntries.set(`https://chinookdb.com${disabledPath}`, new Response(JSON.stringify({ stale: true }), { headers: { 'Cache-Control': 'public, max-age=86400' } }));
const disabledCache = await request(disabledPath, 'GET', { OVDB_CACHE_TTL_SECONDS: '0' });
assert.equal(disabledCache.headers.get('Cache-Control'), 'no-store');
assert.equal((await disabledCache.json()).id, 'chinook');

console.log('Worker HTTP contract passed: static assets, OVDB discovery/read/query, read-only policy, CORS, and cache headers');
