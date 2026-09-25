import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const wrangler = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8')) as { assets: { run_worker_first: string[] } };
for (const path of ['/data/*', '/embed/datatug.js', '/ovdb', '/ovdb/*', '/.well-known/openvaultdb']) {
  assert.ok(wrangler.assets.run_worker_first.includes(path), `Worker must receive ${path}`);
}
const assets = {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const filePath = join(root, 'dist', url.pathname, url.pathname.endsWith('/') ? 'index.html' : '');
    try {
      const body = await readFile(filePath);
      return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: { 'Content-Type': url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  },
};
const ctx = { waitUntil(_promise: Promise<unknown>) {} } as ExecutionContext;
async function request(path: string, method = 'GET', body?: string) {
  return worker.fetch(new Request(`https://chinookdb.com${path}`, { method, ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }) }), { ASSETS: assets }, ctx);
}

const download = await request('/data/json/chinook.Artist.json');
assert.equal(download.status, 200);
assert.equal(download.headers.get('Access-Control-Allow-Origin'), '*');
assert.equal(download.headers.get('Content-Type'), 'application/json; charset=utf-8');
assert.equal((await download.json()).length, 275);
const sqlite = await request('/data/chinook.sqlite');
assert.equal(sqlite.status, 200);
assert.equal(sqlite.headers.get('Content-Type'), 'application/vnd.sqlite3');
const embed = await request('/embed/datatug.js');
assert.equal(embed.status, 200);
assert.match(await embed.text(), /datatug-grid/);
const missing = await request('/data/json/missing.json');
assert.equal(missing.status, 404);
assert.deepEqual(await missing.json(), { error: 'Not found' });
assert.equal((await request('/data/json/chinook.Artist.json', 'POST')).status, 405);

const discovery = await request('/.well-known/openvaultdb');
assert.equal(discovery.status, 200);
const discovered = await discovery.json() as { databases: { url: string; apiUrl: string }[] };
assert.equal(discovered.databases[0].url, 'https://chinookdb.com/ovdb/dbs/chinook');
assert.equal(discovered.databases[0].apiUrl, 'https://cloud.openvaultdb.com/v1/databases/chinook');
for (const [path, destination] of [
  ['/ovdb/', 'https://cloud.openvaultdb.com/ovdb/'],
  ['/ovdb/dbs/', 'https://cloud.openvaultdb.com/ovdb/dbs/'],
  ['/ovdb/dbs/chinook', 'https://cloud.openvaultdb.com/ovdb/dbs/chinook'],
  ['/ovdb/v1/databases/chinook', 'https://cloud.openvaultdb.com/v1/databases/chinook'],
] as const) {
  const response = await request(path);
  assert.equal(response.status, 307, path);
  assert.equal(response.headers.get('Location'), destination);
}
const posted = await request('/ovdb/v1/databases/chinook/dtql', 'POST', '{}');
assert.equal(posted.status, 307);
assert.equal(posted.headers.get('Location'), 'https://cloud.openvaultdb.com/v1/databases/chinook/dtql');
assert.equal((await request('/ovdb/v1/databases/chinook/dtql', 'OPTIONS')).status, 204);
assert.equal((await request('/ovdb/v1/databases/chinook/query?q=legacy')).status, 410);

console.log('ChinookDB static data and OVDB compatibility routes pass.');
