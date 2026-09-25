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
`chinookdb.com` custom domain. Cloudflare Workers Builds runs the production
build on pushes to `main`; the repository workflow provides credential-free CI
build and data validation on pushes and pull requests.

Data responses are served by the Worker with explicit content types, public
cache headers, and permissive read-only CORS. Missing `/data/` files return a
JSON 404 rather than the HTML site fallback.

## Read-only OVDB endpoint

`https://chinookdb.com/ovdb/` is a human-facing server page. The database
catalogue is `/ovdb/dbs/`, and the canonical Chinook connection URL is
`https://chinookdb.com/ovdb/dbs/chinook`. Each page works without JavaScript;
the database profile links to the table schema and data. Unknown database
profiles return an HTML 404.

For existing clients, `GET /ovdb/` with explicit `Accept: application/json`
still returns the original `{ "databases": [...] }` response. Browser/default
requests receive HTML. New machine clients should use the stable versioned
`GET /ovdb/v1/databases` endpoint. The negotiated root sends `Vary: Accept`.

Clients start at `GET /.well-known/openvaultdb` on the same origin. Its
`databases` list adds the canonical `url`, the versioned machine-metadata
`apiUrl`, and public capability flags for each database. The profile also
sends an HTTP `Link` header with `rel="describedby"` to that document and a
canonical link to itself. This is ChinookDB's discovery profile; it extends
the existing OpenVaultDB well-known document without claiming a new generic
OVDB discovery standard. The database URL is a stable identity and browser
destination; machine operations remain at `/ovdb/v1/`.

The machine API exposes the fixture through a public, server-wide read-only
OVDB-compatible endpoint. Every mutation attempt is rejected
with `403 {"error":{"code":"read_only"}}`; no credentials are accepted or
needed. Successful public GET responses have `Cache-Control: public` and are
stored in the Worker Cache API using the complete URL as the edge-cache key.
Set the non-secret Worker variable `OVDB_CACHE_TTL_SECONDS` to change the TTL;
it defaults to 86,400 seconds (one day).

Discovery reports `engine: "static-json"`: the Worker reads generated public
JSON assets, not a live SQLite engine. It reports `schemaMode: "strict"` and
lists every fixed Chinook table in `collections`.

## DataTug Embed and DTQL

Every `/tables/<Table>/` page loads the framework-neutral DataTug Embed bundle
from `/embed/datatug.js`. The Album page demonstrates an OVDB connection URL,
DTQL YAML and a bound parameter; the other table pages load their public JSON
files directly. The bundle is served with cross-origin access for third-party
module scripts. It is built from `datatug-apps/libs/datatug/embed` and
copied into `public/embed/` for deployment with this static site.

The Album example can also be placed on another ordinary HTML page:

```html
<script type="module" src="https://chinookdb.com/embed/datatug.js"></script>
<datatug-grid connection="https://chinookdb.com/ovdb/dbs/chinook">
  <dtql-query>
from: {name: Album}
where: {op: ">=", left: {field: ArtistId}, right: {param: MinArtistID}}
orderBy: [{field: AlbumId}]
limit: 50
  </dtql-query>
  <dtql-param name="MinArtistID" value="1" type="number"></dtql-param>
</datatug-grid>
```

For direct data, use `<datatug-grid
data-url="https://chinookdb.com/data/json/chinook.Album.json"></datatug-grid>`.
The Worker accepts `POST /ovdb/v1/databases/chinook/dtql` with JSON
`{"query":"<DTQL YAML>","parameters":{"MinArtistID":1}}`. Discovery at
`/.well-known/openvaultdb` identifies the canonical database URL and metadata
API; metadata advertises the DTQL endpoint and `dtql-yaml+json` format. This
server implements a bounded read-only DTQL subset: `from.name`, simple `where`
and `and` filters, `orderBy`, and `limit`. Unsupported clauses return an
explicit error. Parameter values travel separately as JSON bindings and are
never substituted into the query text.

```text
GET /.well-known/openvaultdb
GET /ovdb/v1/databases
GET /ovdb/v1/databases/chinook
GET /ovdb/v1/databases/chinook/read?key=Artist%2F1
GET /ovdb/v1/databases/chinook/read?key=PlaylistTrack%2F1%2C3402
GET /ovdb/v1/databases/chinook/query?q=%7B%22collection%22%3A%22Track%22%2C%22where%22%3A%5B%7B%22field%22%3A%22GenreId%22%2C%22op%22%3A%22%3D%3D%22%2C%22value%22%3A1%7D%5D%2C%22limit%22%3A3%7D
```

The read response is `{"key":"Artist/1","data":{...}}`. Query responses
are `{"records":[{"key":"Track/1","data":{...}}]}`; use
`"keysOnly":true` to omit `data`. Queries accept the OVDB core query fields
`collection`, `where`, `orderBy`, `limit`, and `keysOnly`. This is a bounded
Chinook query subset: unsupported fields (including pagination offsets) are
rejected rather than ignored, and `parent` is rejected because Chinook tables
are flat. Filters are AND-ed and support `==`, `<`, `<=`, `>`, `>=`, `in`,
`array-contains`, and `array-contains-any`. Inputs are bounded to 64 KiB and
`limit: 0` (or an omitted limit) preserves OVDB's unbounded-query meaning for
the fixed fixture. A result over 10,000 records is explicitly rejected instead
of being truncated. Set the TTL to `0` to disable cache storage and return
`Cache-Control: no-store`.

## Attribution and licence

Chinook Database is Copyright (c) 2008–2024 Luis Rocha and is distributed under
the MIT licence. The licence text is preserved in `data-source/UPSTREAM-LICENSE.md`.
ChinookDB.com is an independent hosted resource and is not the official
upstream project. See [/about/](/about/) and the
[upstream repository](https://github.com/lerocha/chinook-database).
