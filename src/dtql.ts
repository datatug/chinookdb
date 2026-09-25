import { parseDocument } from 'yaml';

export type StructuredQuery = {
  collection: string;
  where?: { field: string; op: '==' | '<' | '<=' | '>' | '>=' | 'in'; value: unknown }[];
  orderBy?: { field: string; desc?: boolean }[];
  limit?: number;
};

type ObjectValue = Record<string, unknown>;

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: ObjectValue, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${name}.${unexpected} is not supported by this read-only server`);
}

function field(value: unknown, name: string): string {
  if (!object(value)) throw new Error(`${name} must be a field expression`);
  keys(value, ['field'], name);
  if (typeof value.field !== 'string' || !value.field) throw new Error(`${name}.field is required`);
  return value.field;
}

function operand(value: unknown, parameters: ObjectValue): unknown {
  if (!object(value)) throw new Error('where.right must be a value or parameter expression');
  keys(value, ['value', 'values', 'param'], 'where.right');
  if (['value', 'values', 'param'].filter((key) => Object.hasOwn(value, key)).length !== 1) throw new Error('where.right must contain exactly one value, values, or param');
  if (Object.hasOwn(value, 'param')) {
    if (typeof value.param !== 'string' || !value.param) throw new Error('where.right.param must be a name');
    if (!Object.hasOwn(parameters, value.param)) throw new Error(`parameter ${value.param} is not bound`);
    return parameters[value.param];
  }
  if (Object.hasOwn(value, 'values')) {
    if (!Array.isArray(value.values)) throw new Error('where.right.values must be an array');
    return value.values;
  }
  return value.value;
}

function where(value: unknown, parameters: ObjectValue): StructuredQuery['where'] {
  if (!object(value)) throw new Error('where must be an expression');
  if (Object.hasOwn(value, 'and')) {
    keys(value, ['and'], 'where');
    if (!Array.isArray(value.and) || value.and.length === 0 || value.and.length > 20) throw new Error('where.and must contain 1 to 20 conditions');
    return value.and.flatMap((condition) => where(condition, parameters) ?? []);
  }
  keys(value, ['op', 'left', 'right'], 'where');
  const op = value.op;
  if (op !== '==' && op !== '<' && op !== '<=' && op !== '>' && op !== '>=' && op !== 'in' && op !== 'In') throw new Error('where.op is not supported');
  const normalized = op === 'In' ? 'in' : op;
  const bound = operand(value.right, parameters);
  if (normalized === 'in' && !Array.isArray(bound)) throw new Error('where In requires an array value');
  return [{ field: field(value.left, 'where.left'), op: normalized, value: bound }];
}

/** Compile the supported DTQL YAML subset to the existing OVDB structured query. */
export function compileDtql(query: string, parameters: unknown): StructuredQuery {
  if (typeof query !== 'string' || !query.trim()) throw new Error('query must contain DTQL YAML');
  if (new TextEncoder().encode(query).byteLength > 64 * 1024) throw new Error('query is too large');
  if (!object(parameters)) throw new Error('parameters must be an object');
  if (Object.values(parameters).some((value) => value !== null && typeof value === 'object' && !Array.isArray(value))) throw new Error('parameter values must be JSON scalars or arrays');
  const doc = parseDocument(query, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`invalid DTQL YAML: ${doc.errors[0].message}`);
  const parsed: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!object(parsed)) throw new Error('DTQL must be a mapping');
  keys(parsed, ['from', 'where', 'orderBy', 'limit'], 'query');
  if (!object(parsed.from)) throw new Error('from must be a collection mapping');
  keys(parsed.from, ['name'], 'from');
  if (typeof parsed.from.name !== 'string' || !parsed.from.name) throw new Error('from.name is required');
  const result: StructuredQuery = { collection: parsed.from.name };
  if (parsed.where !== undefined) result.where = where(parsed.where, parameters);
  if (parsed.orderBy !== undefined) {
    if (!Array.isArray(parsed.orderBy) || parsed.orderBy.length > 5) throw new Error('orderBy must contain at most five fields');
    result.orderBy = parsed.orderBy.map((entry: unknown) => {
      if (!object(entry)) throw new Error('orderBy entry must be a field expression');
      keys(entry, ['field', 'desc'], 'orderBy');
      if (typeof entry.field !== 'string' || !entry.field || entry.desc !== undefined && typeof entry.desc !== 'boolean') throw new Error('orderBy entry is invalid');
      return { field: entry.field, ...(entry.desc === undefined ? {} : { desc: entry.desc }) };
    });
  }
  if (parsed.limit !== undefined) {
    if (!Number.isInteger(parsed.limit) || (parsed.limit as number) < 0 || (parsed.limit as number) > 10_000) throw new Error('limit must be an integer from 0 to 10000');
    result.limit = parsed.limit as number;
  }
  return result;
}
