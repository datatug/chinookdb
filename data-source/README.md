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
