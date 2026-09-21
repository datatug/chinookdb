import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { stringify as yaml } from 'yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'data-source', 'Chinook_Sqlite.sqlite');
const out = join(root, 'public', 'data');
const schemaOut = join(root, 'src', 'data', 'schema.json');
const sourceRevision = '7f67772503d71ba90f19283c38e93923addb43fa';
const sourceRepository = 'https://github.com/lerocha/chinook-database';
const tableOrder = ['Artist', 'Album', 'Track', 'Genre', 'MediaType', 'Playlist', 'PlaylistTrack', 'Customer', 'Employee', 'Invoice', 'InvoiceLine'];
const descriptions = {
  Artist: 'Artists represented in the music catalogue.',
  Album: 'Albums released by an artist.',
  Track: 'Individual audio tracks available in the store.',
  Genre: 'Music genres assigned to tracks.',
  MediaType: 'File and encoding types used by tracks.',
  Playlist: 'Named collections of tracks.',
  PlaylistTrack: 'The many-to-many link between playlists and tracks.',
  Customer: 'Customers who purchase music from the store.',
  Employee: 'Store employees and their reporting relationships.',
  Invoice: 'Orders raised for a customer.',
  InvoiceLine: 'Individual tracks and quantities on an invoice.',
};

if (!existsSync(source)) throw new Error(`Canonical source missing: ${source}`);
await mkdir(out, { recursive: true });
for (const dir of ['json', 'yaml', 'csv', 'sql']) await mkdir(join(out, dir), { recursive: true });
await mkdir(dirname(schemaOut), { recursive: true });

const db = new DatabaseSync(source, { readOnly: true });
const quoteIdentifier = (value) => `[${String(value).replaceAll(']', ']]')}]`;
const sqlLiteral = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
};
const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const tables = tableOrder.map((name) => {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all().map((column) => ({
    name: column.name,
    type: column.type || 'TEXT',
    nullable: column.notnull !== 1,
    primaryKey: column.pk > 0,
    defaultValue: column.dflt_value,
  }));
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all().map((fk) => ({
    column: fk.from,
    table: fk.table,
    referencedColumn: fk.to,
  }));
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(name)}`).all();
  return { name, description: descriptions[name], columns, foreignKeys, rowCount: rows.length, rows };
});

const model = {
  name: 'Chinook',
  source: { repository: sourceRepository, revision: sourceRevision, sqlitePath: 'data-source/Chinook_Sqlite.sqlite' },
  tables,
};
await writeFile(schemaOut, `${JSON.stringify(model, null, 2)}\n`);

for (const table of tables) {
  const rows = table.rows;
  await writeFile(join(out, 'json', `chinook.${table.name}.json`), `${JSON.stringify(rows, null, 2)}\n`);
  await writeFile(join(out, 'yaml', `chinook.${table.name}.yaml`), yaml(rows, { lineWidth: 0 }));
  const header = table.columns.map((column) => csvCell(column.name)).join(',');
  const body = rows.map((row) => table.columns.map((column) => csvCell(row[column.name])).join(',')).join('\n');
  await writeFile(join(out, 'csv', `chinook.${table.name}.csv`), `${header}\n${body}\n`);
  const columnSql = table.columns.map((column) => `  ${quoteIdentifier(column.name)} ${column.type}${column.nullable ? '' : ' NOT NULL'}${column.primaryKey ? ' PRIMARY KEY' : ''}`).join(',\n');
  const inserts = rows.map((row) => `INSERT INTO ${quoteIdentifier(table.name)} (${table.columns.map((column) => quoteIdentifier(column.name)).join(', ')}) VALUES (${table.columns.map((column) => sqlLiteral(row[column.name])).join(', ')});`).join('\n');
  const sql = `-- Chinook ${table.name} table\n-- Generated from ${sourceRepository}@${sourceRevision}\n\nCREATE TABLE ${quoteIdentifier(table.name)} (\n${columnSql}\n);\n\n${inserts}\n`;
  await writeFile(join(out, 'sql', `chinook.${table.name}.sql`), sql);
}

const complete = Object.fromEntries(tables.map((table) => [table.name, table.rows]));
await writeFile(join(out, 'chinook.json'), `${JSON.stringify(complete, null, 2)}\n`);
await writeFile(join(out, 'chinook.yaml'), yaml(complete, { lineWidth: 0 }));
await copyFile(source, join(out, 'chinook.sqlite'));

const dialectFiles = [
  ['Chinook_PostgreSql.sql', 'chinook.postgresql.sql'],
  ['Chinook_MySql.sql', 'chinook.mysql.sql'],
  ['Chinook_SqlServer.sql', 'chinook.sqlserver.sql'],
];
for (const [input, output] of dialectFiles) await copyFile(join(root, 'data-source', 'sql', input), join(out, output));
await writeFile(join(out, 'metadata', 'source.json'), `${JSON.stringify({ repository: sourceRepository, revision: sourceRevision, sqlitePath: 'data-source/Chinook_Sqlite.sqlite' }, null, 2)}\n`);
db.close();
console.log(`Generated ${tables.length} tables from ${sourceRepository}@${sourceRevision}`);
