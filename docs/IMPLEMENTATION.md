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

`pnpm check:meaning` runs the released `meaninggraph` tool twice: on a checkout
of `github.com/meaninggraph/core` at the commit that the file's `?ref=` pins
(the universal concepts, checked as a graph in its own right), and on `model/`
with that checkout supplied by `--graph` and this repository's address passed as
`--address` (nothing is vendored; the tool refuses a checkout at any other
commit). The meaning-file schema is the copy embedded in the tool, not the
checkout's `meaning.schema.json`, and the tool cannot print it, so a pin that
moves to a changed schema needs the tool pin moved too. `pnpm test:model` reads
the known values of the universal concepts from the same checkout.
`scripts/lib/meaning.mjs` fetches it into `.cache/meaning-sources/` (retried on
network errors, reused once verified) and returns its directory. CI caches it
keyed by the meaning files.
