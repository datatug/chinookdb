# Canonical Chinook input

The SQLite file in this directory is copied from the canonical upstream project
at [`lerocha/chinook-database`](https://github.com/lerocha/chinook-database),
revision `7f67772503d71ba90f19283c38e93923addb43fa`:

`ChinookDatabase/DataSources/Chinook_Sqlite.sqlite`

SHA-256: `7651ba378ac2fcd0dfc3c66fb101f7a7eed3ba39a612ec642b96e20702061f15`

`scripts/generate-data.mjs` is the only generator. It reads this immutable
input and writes all JSON, YAML, CSV, SQLite, and standalone table SQL files
under `public/data/`. The complete PostgreSQL, MySQL, and SQL Server scripts
are distributed unchanged from the same upstream revision.

## Revision history

Published data under `public/data/` may only change together with a change in
this directory and a regenerated `public/data/metadata/checksums.json` (CI
enforces both: `scripts/check-data-drift.mjs`). Replacing the input records the
new upstream revision and SHA-256 above. A generator-only change that alters
the published bytes adds a dated line here saying what changed and why.

- Initial: Chinook at upstream `7f67772503d71ba90f19283c38e93923addb43fa`.
