type JsonObject = Record<string, unknown>;
interface Query { collection: string; parent?: string; where?: Filter[]; orderBy?: OrderBy[]; limit?: number; keysOnly?: boolean }
interface Filter { field: string; op: '==' | '<' | '<=' | '>' | '>=' | 'in' | 'array-contains' | 'array-contains-any'; value: unknown }
interface OrderBy { field: string; desc?: boolean }
interface EdgeCache { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void> }

const contentTypes: Record<string, string> = { '.sqlite': 'application/vnd.sqlite3', '.sql': 'application/sql', '.yaml': 'application/yaml; charset=utf-8', '.yml': 'application/yaml; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8' };
// Static assets are canonical. Composite primary keys use comma-separated IDs:
// PlaylistTrack/1,3402.
const tableKeys: Record<string, readonly string[]> = {
  Album: ['AlbumId'], Artist: ['ArtistId'], Customer: ['CustomerId'], Employee: ['EmployeeId'], Genre: ['GenreId'], Invoice: ['InvoiceId'], InvoiceLine: ['InvoiceLineId'], MediaType: ['MediaTypeId'], Playlist: ['PlaylistId'], PlaylistTrack: ['PlaylistId', 'TrackId'], Track: ['TrackId'],
};
const tableFields: Record<string, ReadonlySet<string>> = {
  Album: new Set(['AlbumId', 'Title', 'ArtistId']), Artist: new Set(['ArtistId', 'Name']), Customer: new Set(['CustomerId', 'FirstName', 'LastName', 'Company', 'Address', 'City', 'State', 'Country', 'PostalCode', 'Phone', 'Fax', 'Email', 'SupportRepId']), Employee: new Set(['EmployeeId', 'LastName', 'FirstName', 'Title', 'ReportsTo', 'BirthDate', 'HireDate', 'Address', 'City', 'State', 'Country', 'PostalCode', 'Phone', 'Fax', 'Email']), Genre: new Set(['GenreId', 'Name']), MediaType: new Set(['MediaTypeId', 'Name']), Playlist: new Set(['PlaylistId', 'Name']), PlaylistTrack: new Set(['PlaylistId', 'TrackId']), Invoice: new Set(['InvoiceId', 'CustomerId', 'InvoiceDate', 'BillingAddress', 'BillingCity', 'BillingState', 'BillingCountry', 'BillingPostalCode', 'Total']), InvoiceLine: new Set(['InvoiceLineId', 'InvoiceId', 'TrackId', 'UnitPrice', 'Quantity']), Track: new Set(['TrackId', 'Name', 'AlbumId', 'MediaTypeId', 'GenreId', 'Composer', 'Milliseconds', 'Bytes', 'UnitPrice']),
};
const maxQueryBytes = 64 * 1024, maxResults = 10_000;
const databaseMetadata = { id: 'chinook', engine: 'static-json', schemaMode: 'strict', collections: Object.keys(tableKeys), readOnly: true };
const canonicalDatabaseUrl = 'https://chinookdb.com/ovdb/dbs/chinook';
const discoveryUrl = 'https://chinookdb.com/.well-known/openvaultdb';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    return url.pathname === '/.well-known/openvaultdb' || url.pathname === '/ovdb' || url.pathname.startsWith('/ovdb/') ? handleOvdb(request, env, ctx, url) : handleData(request, env, url);
  },
} satisfies ExportedHandler<Env>;

async function handleData(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname !== '/data' && !url.pathname.startsWith('/data/')) return env.ASSETS.fetch(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  const headers = new Headers(asset.headers); setCorsHeaders(headers); headers.set('Cache-Control', 'public, max-age=300, must-revalidate'); headers.set('X-Content-Type-Options', 'nosniff');
  const extension = url.pathname.slice(url.pathname.lastIndexOf('.')).toLowerCase(); if (contentTypes[extension]) headers.set('Content-Type', contentTypes[extension]);
  return new Response(asset.body, { status: asset.status, headers });
}

async function handleOvdb(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return error(403, 'read_only', 'chinook is read-only');
  if (!['GET', 'HEAD'].includes(request.method)) return error(405, 'bad_request', `method not allowed: ${request.method}`);
  if (request.method === 'GET') {
    // The legacy root may serve JSON or HTML according to Accept; do not key its edge cache on URL alone.
    const negotiatedRoot = url.pathname === '/ovdb' || url.pathname === '/ovdb/';
    const ttl = cacheTtl(env), cache = ttl > 0 && !negotiatedRoot ? edgeCache() : undefined, cached = cache ? await cache.match(request) : undefined;
    if (cached) return cached;
    const response = await ovdbGet(request, env, url);
    if (response.ok && cache) ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  }
  const response = await ovdbGet(request, env, url); return new Response(null, { status: response.status, headers: response.headers });
}

async function ovdbGet(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === '/.well-known/openvaultdb') return json({
    name: 'ChinookDB OpenVaultDB', protocol: 'openvaultdb/0.1', version: '1.0.0', authEnabled: false,
    databases: [{ id: 'chinook', url: canonicalDatabaseUrl, apiUrl: 'https://chinookdb.com/ovdb/v1/databases/chinook', capabilities: { read: true, query: true, write: false } }],
  }, env);
  if ((path === '/ovdb' || path === '/ovdb/') && requestsJson(request)) {
    const response = json({ databases: [databaseMetadata] }, env);
    response.headers.set('Vary', 'Accept');
    return response;
  }
  if (path === '/ovdb' || path === '/ovdb/' || path === '/ovdb/dbs' || path === '/ovdb/dbs/' || path === '/ovdb/dbs/chinook' || path === '/ovdb/dbs/chinook/') return humanPage(request, env, path);
  if (path.startsWith('/ovdb/dbs/')) return unknownDatabase();
  if (path === '/ovdb/v1' || path === '/ovdb/v1/databases') return json({ databases: [databaseMetadata] }, env);
  if (path === '/ovdb/v1/databases/chinook') return json(databaseMetadata, env);
  if (path === '/ovdb/v1/databases/chinook/read') return readRecord(request, env, url);
  if (path === '/ovdb/v1/databases/chinook/query') return queryRecords(request, env, url);
  return error(404, 'not_found', 'OVDB endpoint not found');
}

async function humanPage(request: Request, env: Env, path: string): Promise<Response> {
  const pagePath = path === '/ovdb' || path === '/ovdb/' ? '/ovdb/' : path === '/ovdb/dbs' || path === '/ovdb/dbs/' ? '/ovdb/dbs/' : '/ovdb/dbs/chinook/';
  const asset = await env.ASSETS.fetch(new Request(new URL(`${pagePath}index.html`, request.url), { method: 'GET' }));
  if (!asset.ok) return error(500, 'internal', 'OVDB page is unavailable');
  const headers = new Headers(asset.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=300, must-revalidate');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (pagePath === '/ovdb/') headers.set('Vary', 'Accept');
  headers.set('Link', `<${discoveryUrl}>; rel="describedby"; type="application/json", <https://chinookdb.com${pagePath === '/ovdb/dbs/chinook/' ? '/ovdb/dbs/chinook' : pagePath}>; rel="canonical"`);
  return new Response(request.method === 'HEAD' ? null : asset.body, { status: 200, headers });
}

function requestsJson(request: Request): boolean {
  return (request.headers.get('Accept') ?? '').split(',').some((part) => {
    const [mediaType, ...parameters] = part.trim().toLowerCase().split(';');
    return mediaType.trim() === 'application/json' && !parameters.some((parameter) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(parameter));
  });
}

function unknownDatabase(): Response {
  return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Database not found | ChinookDB</title></head><body><main><h1>Database not found</h1><p>This OpenVaultDB server has no database at this URL.</p><p><a href="/ovdb/dbs/">Browse available databases</a></p></main></body></html>', {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

async function readRecord(request: Request, env: Env, url: URL): Promise<Response> {
  const rawKey = url.searchParams.get('key'), parsed = rawKey && parseKey(rawKey);
  if (!parsed) return error(400, 'invalid_key', 'key must be a Chinook table followed by its primary key');
  const rows = await loadTable(request, env, parsed.table); if (!rows) return error(500, 'internal', 'canonical table asset is unavailable');
  const row = rows.find((candidate) => recordId(parsed.table, candidate) === parsed.id);
  return row ? json({ key: `${parsed.table}/${parsed.id}`, data: row }, env) : error(404, 'not_found', 'record not found');
}

async function queryRecords(request: Request, env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get('q');
  if (!raw) return error(400, 'bad_request', 'q query parameter is required');
  if (new TextEncoder().encode(raw).byteLength > maxQueryBytes) return error(400, 'bad_request', `q must not exceed ${maxQueryBytes} bytes`);
  let query: Query; try { query = JSON.parse(raw) as Query } catch { return error(400, 'bad_request', 'q must be JSON') }
  const valid = validateQuery(query); if (!valid.ok) return error(400, 'bad_request', valid.message);
  const rows = await loadTable(request, env, valid.query.collection); if (!rows) return error(500, 'internal', 'canonical table asset is unavailable');
  let results = rows.filter((row) => matches(row, valid.query.where ?? []));
  if (valid.query.orderBy?.length) results = [...results].sort((a, b) => compareRows(a, b, valid.query.orderBy!));
  else if (valid.query.keysOnly) results = [...results].sort((a, b) => recordId(valid.query.collection, a).localeCompare(recordId(valid.query.collection, b)));
  if (valid.query.limit && valid.query.limit > 0) results = results.slice(0, valid.query.limit);
  if (results.length > maxResults) return error(400, 'bad_request', `query result exceeds ${maxResults} records; add a limit or a more selective filter`);
  return json({ records: results.map((row) => valid.query.keysOnly ? { key: `${valid.query.collection}/${recordId(valid.query.collection, row)}` } : { key: `${valid.query.collection}/${recordId(valid.query.collection, row)}`, data: row }) }, env);
}

function validateQuery(query: Query): { ok: true; query: Query & { collection: string } } | { ok: false; message: string } {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return { ok: false, message: 'q must be a query object' };
  if (!Object.keys(query).every((key) => ['collection', 'parent', 'where', 'orderBy', 'limit', 'keysOnly'].includes(key))) return { ok: false, message: 'q contains an unsupported property' };
  const collection = typeof query.collection === 'string' ? canonicalTable(query.collection) : undefined;
  if (!collection) return { ok: false, message: 'collection must name a Chinook table' };
  if (query.parent !== undefined) return { ok: false, message: 'parent is not supported for flat Chinook tables' };
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0 || query.limit > maxResults)) return { ok: false, message: `limit must be an integer from 0 to ${maxResults}` };
  if (query.keysOnly !== undefined && typeof query.keysOnly !== 'boolean') return { ok: false, message: 'keysOnly must be a boolean' };
  if (!validateFilters(query.where, tableFields[collection])) return { ok: false, message: 'where contains an invalid field, operator, or value' };
  if (!validateOrderBy(query.orderBy, tableFields[collection])) return { ok: false, message: 'orderBy contains an invalid field or direction' };
  return { ok: true, query: { ...query, collection } };
}

function validateFilters(filters: unknown, fields: ReadonlySet<string>): filters is Filter[] | false {
  if (filters === undefined) return true; if (!Array.isArray(filters) || filters.length > 20) return false;
  return filters.every((filter) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return false;
    const candidate = filter as Partial<Filter>, value = candidate.value;
    if (typeof candidate.field !== 'string' || !fields.has(candidate.field) || !candidate.op || !['==', '<', '<=', '>', '>=', 'in', 'array-contains', 'array-contains-any'].includes(candidate.op)) return false;
    return candidate.op !== 'in' && candidate.op !== 'array-contains-any' || Array.isArray(value) && value.length <= 100;
  });
}
function validateOrderBy(orderBy: unknown, fields: ReadonlySet<string>): orderBy is OrderBy[] | false { return orderBy === undefined || Array.isArray(orderBy) && orderBy.length <= 5 && orderBy.every((order) => order && typeof order === 'object' && !Array.isArray(order) && typeof (order as OrderBy).field === 'string' && fields.has((order as OrderBy).field) && ((order as OrderBy).desc === undefined || typeof (order as OrderBy).desc === 'boolean')); }
function matches(row: JsonObject, filters: Filter[]): boolean { return filters.every(({ field, op, value }) => { const actual = row[field]; if (op === '==') return JSON.stringify(actual) === JSON.stringify(value); if (op === 'in') return Array.isArray(value) && value.some((v) => JSON.stringify(actual) === JSON.stringify(v)); if (op === 'array-contains') return Array.isArray(actual) && actual.some((v) => JSON.stringify(v) === JSON.stringify(value)); if (op === 'array-contains-any') return Array.isArray(actual) && Array.isArray(value) && value.some((v) => actual.some((item) => JSON.stringify(item) === JSON.stringify(v))); if (typeof actual === 'number' && typeof value === 'number') return compare(actual, value, op); if (typeof actual === 'string' && typeof value === 'string') return compare(actual, value, op); return false; }); }
function compare(left: number | string, right: number | string, op: '<' | '<=' | '>' | '>='): boolean { return op === '<' ? left < right : op === '<=' ? left <= right : op === '>' ? left > right : left >= right; }
function compareRows(a: JsonObject, b: JsonObject, orderBy: OrderBy[]): number { for (const order of orderBy) { const left = a[order.field], right = b[order.field]; const result = left === right ? 0 : left === null || left === undefined ? -1 : right === null || right === undefined ? 1 : String(left).localeCompare(String(right), undefined, { numeric: true }); if (result) return order.desc ? -result : result; } return 0; }
async function loadTable(request: Request, env: Env, table: string): Promise<JsonObject[] | undefined> { const response = await env.ASSETS.fetch(new Request(new URL(`/data/json/chinook.${table}.json`, request.url), { method: 'GET' })); if (!response.ok) return undefined; const parsed: unknown = await response.json(); return Array.isArray(parsed) && parsed.every((row) => row && typeof row === 'object' && !Array.isArray(row)) ? parsed as JsonObject[] : undefined; }
function parseKey(key: string): { table: string; id: string } | undefined { if (key.length > 512 || /[\x00-\x1f]/.test(key)) return undefined; const slash = key.indexOf('/'); if (slash <= 0 || slash !== key.lastIndexOf('/') || !key.slice(slash + 1)) return undefined; const table = canonicalTable(key.slice(0, slash)); return table ? { table, id: key.slice(slash + 1) } : undefined; }
function canonicalTable(candidate: string): string | undefined { return Object.keys(tableKeys).find((table) => table.toLowerCase() === candidate.toLowerCase()); }
function recordId(table: string, row: JsonObject): string { return tableKeys[table].map((field) => String(row[field])).join(','); }
function json(body: unknown, env: Env): Response { const ttl = cacheTtl(env); return new Response(JSON.stringify(body), { headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': ttl === 0 ? 'no-store' : `public, max-age=${ttl}, must-revalidate`, 'X-Content-Type-Options': 'nosniff' } }); }
function error(status: number, code: string, message: string): Response { return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
function cacheTtl(env: Env): number { const value = Number(env.OVDB_CACHE_TTL_SECONDS); return Number.isInteger(value) && value >= 0 && value <= 31_536_000 ? value : 86_400; }
function edgeCache(): EdgeCache | undefined { return (globalThis as typeof globalThis & { caches?: { default?: EdgeCache } }).caches?.default; }
function corsHeaders(): Record<string, string> { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' }; }
function setCorsHeaders(headers: Headers): void { for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value); }
