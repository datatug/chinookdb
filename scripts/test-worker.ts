import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const wrangler = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8')) as { assets: { run_worker_first: string[] } };
assert.ok(wrangler.assets.run_worker_first.includes('/data/*'), 'wrangler must route /data/* through the Worker first');

const assets = {
  async fetch(request: Request) {
    const url = new URL(request.url);
    const filePath = join(root, 'dist', url.pathname);
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

async function request(path: string, method: string) {
  return worker.fetch(new Request(`https://chinookdb.com${path}`, { method }), { ASSETS: assets });
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

console.log('Worker HTTP contract passed: route guard, GET, HEAD, OPTIONS, missing, and method handling');
