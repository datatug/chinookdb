const cloudOrigin = 'https://cloud.openvaultdb.com';
const contentTypes: Record<string, string> = { '.sqlite': 'application/vnd.sqlite3', '.sql': 'application/sql', '.yaml': 'application/yaml; charset=utf-8', '.yml': 'application/yaml; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8' };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/.well-known/openvaultdb') return legacyDiscovery(request);
    if (url.pathname === '/ovdb' || url.pathname.startsWith('/ovdb/')) return legacyOvdbRedirect(request, url);
    return assetResponse(request, env, url);
  },
} satisfies ExportedHandler<Env>;

// Old connection URLs remain discoverable while the human pages and API are
// served by the OpenVaultDB-owned cloud service.
function legacyDiscovery(request: Request): Response {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
  const body = JSON.stringify({
    name: 'Chinook OVDB compatibility discovery',
    protocol: 'openvaultdb/0.1',
    authEnabled: false,
    databases: [{ id: 'chinook', url: 'https://chinookdb.com/ovdb/dbs/chinook', apiUrl: `${cloudOrigin}/v1/databases/chinook`, capabilities: { read: true, query: true, write: false } }],
  });
  return new Response(request.method === 'HEAD' ? null : body, { headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}

function legacyOvdbRedirect(request: Request, url: URL): Response {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (url.pathname === '/ovdb/v1/databases/chinook/query') return new Response('This legacy query endpoint has moved to the OpenVaultDB API.', { status: 410, headers: { Link: `<${cloudOrigin}/v1/databases/chinook>; rel="successor-version"` } });
  const path = url.pathname.startsWith('/ovdb/v1/') ? url.pathname.slice('/ovdb'.length) : url.pathname;
  const destination = `${cloudOrigin}${path}${url.search}`;
  // 307 preserves POST request bodies for existing DTQL clients.
  return new Response(null, { status: 307, headers: { ...corsHeaders(), Location: destination, 'Cache-Control': 'public, max-age=300' } });
}

async function assetResponse(request: Request, env: Env, url: URL): Promise<Response> {
  const embedScript = url.pathname === '/embed/datatug.js';
  if (!embedScript && url.pathname !== '/data' && !url.pathname.startsWith('/data/')) return env.ASSETS.fetch(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  const headers = new Headers(asset.headers);
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  headers.set('Cache-Control', 'public, max-age=300, must-revalidate');
  headers.set('X-Content-Type-Options', 'nosniff');
  const extension = url.pathname.slice(url.pathname.lastIndexOf('.')).toLowerCase();
  if (contentTypes[extension]) headers.set('Content-Type', contentTypes[extension]);
  if (embedScript) headers.set('Content-Type', 'text/javascript; charset=utf-8');
  return new Response(asset.body, { status: asset.status, headers });
}

function corsHeaders(): Record<string, string> {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
}
