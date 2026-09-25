# ChinookDB.com

ChinookDB.com is an independent, static developer resource for the [Chinook
sample database](https://github.com/lerocha/chinook-database). Browse the
schema, preview each table, or download a complete database in SQLite, JSON,
YAML, PostgreSQL, MySQL, or SQL Server formats.

## Local development

Requires Node.js 22 and pnpm.

```sh
pnpm install
pnpm dev
```

`pnpm build` generates the data artifacts and the production Astro site in
`dist/`. `pnpm validate` parses JSON, YAML, CSV, and SQLite outputs, compares
row counts, checks all expected tables, and runs a real SQLite query.

## Data generation

The canonical input is the pinned upstream fixture at
`data-source/Chinook_Sqlite.sqlite`. Its provenance, upstream revision, and
SHA-256 are recorded in `data-source/README.md`. The single deterministic
generator is `scripts/generate-data.mjs`; it writes generated files to
`public/data/` and schema metadata to `src/data/schema.json`.

The complete PostgreSQL, MySQL, and SQL Server SQL files are distributed
unchanged from the same upstream revision. Per-table SQL is generated as
portable SQLite-compatible `CREATE TABLE` plus `INSERT` statements.

Public URLs follow this stable convention:

```text
/data/chinook.*                    complete database
/data/<format>/chinook.<Table>.*   individual table
```

## Deployment

The site is a Cloudflare Worker using current Workers Static Assets. The
`wrangler.jsonc` configuration targets the `chinookdb` Worker and the
`chinookdb.com` custom domain. The repository workflow validates pushes and
pull requests, but does not publish the Worker. After a validated change lands
on `main`, deploy it from the synced main checkout with `pnpm build` followed
by `pnpm exec wrangler deploy`, then verify the public site and the deployed
Worker version with `pnpm exec wrangler deployments list --name chinookdb --json`.

Data responses are served by the Worker with explicit content types, public
cache headers, and permissive read-only CORS. Missing `/data/` files return a
JSON 404 rather than the HTML site fallback.

## OpenVaultDB connection

The public Chinook database is served by the OpenVaultDB Cloud Go service at
`https://cloud.openvaultdb.com/ovdb/dbs/chinook`. Its `/ovdb/` pages, discovery,
metadata, and `/v1/databases/chinook` API come from the reusable OVDB server.
The service mounts a read-only SQLite copy of the pinned upstream fixture.
Cloud Run deployment and the ChinookDB site cutover are coordinated; this
checkout alone does not make the cloud endpoint live.

Old `chinookdb.com/ovdb/` page URLs redirect to the cloud pages. The old
`/.well-known/openvaultdb` document remains as a compatibility alias for
clients that saved the old connection URL. Legacy `/ovdb/v1/` paths redirect to
cloud `/v1/` paths, except the former static-JSON `GET /query?q=...` shape,
which returns 410 because its query syntax is different.

## DataTug Embed and DTQL

Every `/tables/<Table>/` page loads the framework-neutral DataTug Embed bundle
from `/embed/datatug.js`. The Album page demonstrates the hosted OVDB
connection URL, DTQL YAML, and a bound parameter; the other table pages load
their public JSON files directly. Downloads remain on chinookdb.com.

```html
<script type="module" src="https://chinookdb.com/embed/datatug.js"></script>
<datatug-grid connection="https://cloud.openvaultdb.com/ovdb/dbs/chinook">
  <dtql-query>
from: {name: Album}
where: {op: ">=", left: {field: ArtistId}, right: {param: MinArtistID}}
orderBy: [{field: AlbumId}]
limit: 50
  </dtql-query>
  <dtql-param name="MinArtistID" value="1" type="number"></dtql-param>
</datatug-grid>
```

The Go server advertises `dtql-yaml+json` in database metadata and accepts
`POST /v1/databases/chinook/dtql` with JSON containing the YAML `query` and
separate `parameters` object. Scalar and scalar-array bindings are parsed as
values before DTQL execution. The server remains read-only.

## Attribution and licence

Chinook Database is Copyright (c) 2008–2024 Luis Rocha and is distributed under
the MIT licence. The licence text is preserved in `data-source/UPSTREAM-LICENSE.md`.
ChinookDB.com is an independent hosted resource and is not the official
upstream project. See [/about/](/about/) and the
[upstream repository](https://github.com/lerocha/chinook-database).
