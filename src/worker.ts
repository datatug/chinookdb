// The only code chinookdb.com runs: the legacy /ovdb redirects. wrangler.jsonc sends just /ovdb and /ovdb/* here
// (run_worker_first); every other path is a static asset, with its headers from public/_headers.
// They need code, not _redirects: a browser preflights the POST of a DTQL query (OPTIONS must answer 204 with
// CORS), a cross-origin redirect is followed only when it carries CORS headers, and the old query endpoint is a 410.
const cloudOrigin = 'https://cloud.openvaultdb.com';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ovdb' || url.pathname.startsWith('/ovdb/')) return legacyOvdbRedirect(request, url);
    // Not reached in practice: only /ovdb and /ovdb/* run this Worker, and with dist/404.html present the static
    // assets answer every other request themselves, a miss included. Kept so a stray request still gets their answer.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function legacyOvdbRedirect(request: Request, url: URL): Response {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (url.pathname === '/ovdb/v1/databases/chinook/query') return new Response('This legacy query endpoint has moved to the OpenVaultDB API.', { status: 410, headers: { Link: `<${cloudOrigin}/v1/databases/chinook>; rel="successor-version"` } });
  const path = url.pathname.startsWith('/ovdb/v1/') ? url.pathname.slice('/ovdb'.length) : url.pathname;
  const destination = `${cloudOrigin}${path}${url.search}`;
  // 307 preserves POST request bodies for existing DTQL clients.
  return new Response(null, { status: 307, headers: { ...corsHeaders(), Location: destination, 'Cache-Control': 'public, max-age=300' } });
}

function corsHeaders(): Record<string, string> {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
}
