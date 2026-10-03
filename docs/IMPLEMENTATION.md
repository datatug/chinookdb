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

## Meaning checks

`pnpm test:model` checks `model/chinook.meaning.yaml` against the universal
concepts and the meaning-file schema in `github.com/meaninggraph/core`, read
from one checkout of the commit that the file's `?ref=` pins (nothing is
vendored). `scripts/lib/meaning.mjs` fetches it into `.cache/meaning-sources/`
(retried on network errors, reused once verified) and returns its directory;
the schema path and the self-check of the universal concepts use that
directory. CI caches it keyed by the meaning files.
