# Implementation notes

## Shape

Astro statically generates the home, table index, eleven table detail pages,
downloads, and attribution pages. Table metadata is derived once from the
canonical SQLite fixture; `src/data/model.ts` is the shared model for routes,
navigation, relationships, previews, and downloads. No table page is
hand-maintained.

The data model and meaning page (`/model/`) reads `model/chinook.modelspec.json`
and `model/chinook.meaning.yaml`; `src/pages/model/[...file].ts` publishes
every git-tracked file under `model/` (no dotfiles) byte for byte at
`/model/<path>`.

## Delivery

Cloudflare Workers Static Assets serves `dist/` behind a small Worker wrapper.
The wrapper adds CORS and cache headers for `/data/**` and the files under
`/model/` (not the `/model/` page), enforces the generated file MIME types
(`.hcl` is served as `text/plain`), and prevents missing data URLs from
becoming HTML fallbacks.
