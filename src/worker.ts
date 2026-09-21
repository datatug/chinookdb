interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const contentTypes: Record<string, string> = {
  '.sqlite': 'application/vnd.sqlite3',
  // Upstream SQL distributions preserve their native encoding (including the
  // SQL Server UTF-16 script), so do not assert a charset here.
  '.sql': 'application/sql',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isData = url.pathname === '/data' || url.pathname.startsWith('/data/');
    if (!isData) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });

    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    const headers = new Headers(asset.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Cache-Control', 'public, max-age=300, must-revalidate');
    headers.set('X-Content-Type-Options', 'nosniff');
    const extension = url.pathname.slice(url.pathname.lastIndexOf('.')).toLowerCase();
    if (contentTypes[extension]) headers.set('Content-Type', contentTypes[extension]);
    return new Response(asset.body, { status: asset.status, headers });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
