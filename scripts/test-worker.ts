import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.ts';
import { catalogues } from '../src/data/catalogues.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dist = join(root, 'dist');

// Only the legacy /ovdb redirects run code; everything else is a static asset with no Worker invocation.
const wrangler = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8')) as { assets: { run_worker_first: string[]; not_found_handling: string }; routes: { pattern: string; custom_domain?: boolean }[] };
assert.deepEqual(wrangler.assets.run_worker_first, ['/ovdb', '/ovdb/*'], 'only the legacy /ovdb paths run the Worker');
assert.equal(wrangler.assets.not_found_handling, '404-page');
assert.ok(wrangler.routes.some((route) => route.pattern === 'chinookdb.com' && route.custom_domain === true), 'the Worker claims chinookdb.com as a custom domain');
// With dist/404.html a miss is answered by the assets too; without it every miss would run the Worker.
assert.match(await readFile(join(dist, '404.html'), 'utf8'), /Page not found/);

// public/_headers, matched as Workers Static Assets match it: one splat, anchored, values of repeated names joined.
const rules: { pattern: RegExp; headers: [string, string][] }[] = [];
for (const line of (await readFile(join(dist, '_headers'), 'utf8')).split('\n')) {
  if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
  if (!/^\s/.test(line)) { rules.push({ pattern: new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`), headers: [] }); continue; }
  const colon = line.indexOf(':');
  rules.at(-1)!.headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
}
assert.ok(rules.length <= 100, 'Workers Static Assets allow at most 100 header rules');
function headersFor(path: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  for (const rule of rules) if (rule.pattern.test(path)) for (const [name, value] of rule.headers) headers.set(name, [...(headers.get(name) ?? []), value]);
  return headers;
}
async function files(directory: string): Promise<string[]> {
  return (await readdir(join(dist, directory), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => `/${relative(dist, join(entry.parentPath, entry.name)).split(sep).join('/')}`);
}
// HCL has no registered media type; text/plain lets browsers show it.
const contentTypes: Record<string, string> = { '.sqlite': 'application/vnd.sqlite3', '.sql': 'application/sql', '.yaml': 'application/yaml; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8', '.hcl': 'text/plain; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const published = [...await files('data'), ...(await files('model')).filter((path) => path !== '/model/index.html'), '/embed/datatug.js'];
assert.ok(published.length > 40, 'the downloads and model files are in dist');
for (const path of published) {
  const headers = headersFor(path);
  const type = contentTypes[path.slice(path.lastIndexOf('.'))];
  assert.ok(type, `${path} has a known content type`);
  assert.deepEqual(headers.get('content-type'), [type], `${path} gets exactly one Content-Type`);
  assert.deepEqual(headers.get('access-control-allow-origin'), ['*'], `${path} is readable cross-origin`);
  assert.deepEqual(headers.get('cache-control'), ['public, max-age=300, must-revalidate'], path);
  assert.deepEqual(headers.get('x-content-type-options'), ['nosniff'], path);
}
for (const page of ['/', '/model/', '/downloads/', '/tables/']) assert.equal(headersFor(page).size, 0, `${page} is a page, not a data file`);
assert.deepEqual(headersFor('/.well-known/openvaultdb').get('content-type'), ['application/json; charset=utf-8']);
assert.deepEqual(headersFor('/.well-known/openvaultdb').get('access-control-allow-origin'), ['*']);

for (const path of ['/model/chinook.modelspec.hcl', '/model/chinook.modelspec.json', '/model/chinook.meaning.yaml', '/model/checksums.json']) {
  assert.ok(published.includes(path), `${path} is published`);
  assert.deepEqual(new Uint8Array(await readFile(join(dist, path))), new Uint8Array(await readFile(join(root, path.slice(1)))), `${path} is published byte for byte from model/`);
}
const artists = JSON.parse(await readFile(join(dist, 'data/json/chinook.Artist.json'), 'utf8')) as unknown[];
assert.equal(artists.length, 275);
assert.match(await readFile(join(dist, 'embed/datatug.js'), 'utf8'), /datatug-grid/);
for (const gone of ['/model/vendor/README.md', '/model/vendor/meaninggraph-core/meaning.schema.json', '/model/vendor/meaninggraph-core/geo.meaning.yaml']) assert.ok(!published.includes(gone), `${gone} is no longer published: the universal concepts and schema live in github.com/meaninggraph/core`);
const checksums = JSON.parse(await readFile(join(root, 'model/checksums.json'), 'utf8')) as { files: Record<string, unknown> };
assert.deepEqual(Object.keys(checksums.files), ['chinook.meaning.yaml', 'chinook.modelspec.hcl', 'chinook.modelspec.json'], 'the checksums list exactly the files this repository publishes under /model/');
const modelPageText = await readFile(join(dist, 'model/index.html'), 'utf8');
assert.match(modelPageText, /chinook\.meaning\.yaml/);
assert.doesNotMatch(modelPageText, /vendor/, 'the model page no longer points at a vendored copy');
assert.match(modelPageText, /https:\/\/github\.com\/meaninggraph\/core\/tree\/[0-9a-f]{40}/, 'the model page links the pinned commit of meaninggraph/core');

// Where Chinook is listed: the three catalogues are linked from the home page and the model page.
assert.deepEqual(catalogues.map((catalogue) => catalogue.url), [
  'https://directory.openvaultdb.com/databases/chinook/',
  'https://modelspec.org/registry/models/chinook/',
  'https://meaninggraph.io/graphs/chinook/',
]);
for (const path of ['index.html', 'model/index.html']) {
  const html = await readFile(join(dist, path), 'utf8');
  assert.match(html, /Where Chinook is listed/, `${path} has the block`);
  for (const { name, url } of catalogues) {
    assert.equal(html.split(`href="${url}"`).length - 1, 1, `${path} links ${name} once, at ${url}`);
    assert.match(html, new RegExp(`<strong>${name}</strong>`), `${path} names ${name}`);
  }
}

// The legacy discovery document is a static file now.
const discovered = JSON.parse(await readFile(join(dist, '.well-known/openvaultdb'), 'utf8')) as { databases: { url: string; apiUrl: string }[] };
assert.equal(discovered.databases[0].url, 'https://chinookdb.com/ovdb/dbs/chinook');
assert.equal(discovered.databases[0].apiUrl, 'https://cloud.openvaultdb.com/v1/databases/chinook');

// The Worker: the legacy /ovdb redirects.
const assets = { async fetch(_request: Request) { return new Response('Not found', { status: 404 }); } };
const ctx = { waitUntil(_promise: Promise<unknown>) {} } as ExecutionContext;
async function request(path: string, method = 'GET', body?: string) {
  return worker.fetch(new Request(`https://chinookdb.com${path}`, { method, ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }) }), { ASSETS: assets } as unknown as Env, ctx);
}
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
const posted = await request('/ovdb/v1/databases/chinook/tugql', 'POST', '{}');
assert.equal(posted.status, 307);
assert.equal(posted.headers.get('Location'), 'https://cloud.openvaultdb.com/v1/databases/chinook/tugql');
assert.equal((await request('/ovdb/v1/databases/chinook/tugql', 'OPTIONS')).status, 204);
assert.equal((await request('/ovdb/v1/databases/chinook/query?q=legacy')).status, 410);

for (const path of ['/ovdb', '/ovdb/v1/databases/chinook/tugql']) assert.equal((await request(path)).headers.get('Access-Control-Allow-Origin'), '*', `${path} redirects with CORS, so a browser follows it`);
assert.equal((await request('/robots.txt')).status, 404, 'any other path is left to the static assets');

console.log('ChinookDB static headers, model files and the legacy OVDB redirects pass.');
