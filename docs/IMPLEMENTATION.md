# Implementation notes

## Shape

Astro statically generates the home, table index, eleven table detail pages,
downloads, and attribution pages. Table metadata is derived once from the
canonical SQLite fixture; `src/data/model.ts` is the shared model for routes,
navigation, relationships, previews, and downloads. No table page is
hand-maintained.

## Delivery

Cloudflare Workers Static Assets serves `dist/` behind a small Worker wrapper.
The wrapper adds CORS and cache headers for `/data/**`, enforces the generated
file MIME types, and prevents missing data URLs from becoming HTML fallbacks.
