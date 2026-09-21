import schema from './schema.json';

export type Column = {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | number | null;
};

export type ForeignKey = { column: string; table: string; referencedColumn: string };
export type TableMeta = {
  name: string;
  description: string;
  columns: Column[];
  foreignKeys: ForeignKey[];
  rowCount: number;
  rows: Record<string, string | number | null>[];
};

export const tables = schema.tables as TableMeta[];
export const tableByName = new Map(tables.map((table) => [table.name, table]));
export const source = schema.source;

export function tablePath(name: string) {
  return `/tables/${encodeURIComponent(name)}/`;
}
