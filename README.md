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

## Attribution and licence

Chinook Database is Copyright (c) 2008–2024 Luis Rocha and is distributed under
the MIT licence. The licence text is preserved in `data-source/UPSTREAM-LICENSE.md`.
ChinookDB.com is an independent hosted resource and is not the official
upstream project. See [/about/](/about/) and the
[upstream repository](https://github.com/lerocha/chinook-database).
