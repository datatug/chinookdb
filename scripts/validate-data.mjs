import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parse as parseYaml } from 'yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const model = JSON.parse(await readFile(join(root, 'src', 'data', 'schema.json'), 'utf8'));
const out = join(root, 'public', 'data');
const db = new DatabaseSync(join(out, 'chinook.sqlite'), { readOnly: true });
const expected = model.tables.map((table) => table.name);
const actual = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name).sort();
if (JSON.stringify([...expected].sort()) !== JSON.stringify(actual)) throw new Error(`SQLite tables mismatch: ${actual.join(', ')}`);
for (const table of model.tables) {
  const json = JSON.parse(await readFile(join(out, 'json', `chinook.${table.name}.json`), 'utf8'));
  const yaml = parseYaml(await readFile(join(out, 'yaml', `chinook.${table.name}.yaml`), 'utf8'));
  const sqliteCount = db.prepare(`SELECT count(*) AS count FROM [${table.name}]`).get().count;
  if (json.length !== table.rowCount || yaml.length !== table.rowCount || Number(sqliteCount) !== table.rowCount) throw new Error(`${table.name} row count mismatch`);
  const csv = await readFile(join(out, 'csv', `chinook.${table.name}.csv`), 'utf8');
  if (csv.split('\n')[0].split(',').length !== table.columns.length) throw new Error(`${table.name} CSV header mismatch`);
}
const artist = db.prepare('SELECT Name FROM Artist WHERE ArtistId = 1').get();
if (!artist || artist.Name !== 'AC/DC') throw new Error('SQLite query validation failed');
db.close();
const files = await readdir(join(out, 'json'));
if (files.length !== expected.length) throw new Error('Expected one JSON file per table');
console.log(`Validated ${expected.length} tables, cross-format row counts, and SQLite query`);
