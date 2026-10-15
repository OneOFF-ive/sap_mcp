import { z } from 'zod';
import { AppError } from './errors.js';

export const entityName = z.string().regex(/^(?:\/[A-Za-z0-9_]+\/)?[A-Za-z_][A-Za-z0-9_]*$/).max(128);
export const fieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
export const queryLimit = z.number().int().min(1).max(500).default(100).describe('Maximum returned rows, default 100, maximum 500. Does not bound database scan cost; prefer a small value and selective filters. No pagination cursor.');
export const tableQuerySchema = z.object({
  table_name: entityName.describe('DDIC table or backend-supported entity name, e.g. MARA. Not a SQL expression or URL.'),
  fields: z.array(fieldName).min(1).max(100).optional().describe('Columns to return, e.g. ["MATNR", "MTART"]. Omit for all columns; prefer only fields needed for the task.'),
  filters: z.array(z.object({ field: fieldName,
    operator: z.enum(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like']),
    value: z.string().max(2048).describe('Raw value as a string; do not add SQL quotes. Preserve leading zeros. LIKE uses % and _ wildcards.')
  }).strict()).max(50).default([]).describe('AND-combined comparisons. Example: [{"field":"MTART","operator":"eq","value":"FERT"}]. No OR or SQL fragments.'),
  limit: queryLimit
}).strict();
export const sqlQuerySchema = z.object({ sql: z.string().trim().min(1).max(16384).describe('One read-only ABAP SQL SELECT with FROM, e.g. SELECT matnr FROM mara WHERE mtart = \'FERT\'. No terminator, comments, INTO or CLIENT/CLIENTS overrides. Use ~ for qualified fields; never insert untrusted values as SQL syntax.'), limit: queryLimit }).strict();
export type TableQuery = z.input<typeof tableQuerySchema>;
export type SqlQuery = z.input<typeof sqlQuerySchema>;

const operators = { eq: '=', ne: '<>', gt: '>', ge: '>=', lt: '<', le: '<=', like: 'LIKE' };
export function tableQuery(input: TableQuery) {
  const p = tableQuerySchema.parse(input);
  const fields = p.fields?.map(f => f.toUpperCase()).join(', ') ?? '*';
  const where = p.filters.map(f => `${f.field.toUpperCase()} ${operators[f.operator]} '${f.value.replace(/'/g, "''")}'`).join(' AND ');
  // An empty body uses the basic DDIC preview, including on older systems.
  const sql = p.fields || p.filters.length ? `SELECT ${fields} FROM ${p.table_name.toUpperCase()}${where ? ` WHERE ${where}` : ''}` : '';
  return { ...p, table_name: p.table_name.toUpperCase(), sql };
}

export function readOnlySql(input: SqlQuery) {
  const p = sqlQuerySchema.parse(input);
  // Mask quoted literals before checking syntax so data cannot become SQL tokens.
  let masked = ''; let quoted = false;
  for (let i = 0; i < p.sql.length; i++) {
    const c = p.sql[i];
    if (c === "'") {
      if (quoted && p.sql[i + 1] === "'") { masked += '  '; i++; continue; }
      quoted = !quoted; masked += ' '; continue;
    }
    masked += quoted ? ' ' : c;
  }
  const tokens: string[] = masked.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? [];
  const forbidden = new Set(['INSERT', 'UPDATE', 'DELETE', 'MODIFY', 'MERGE', 'UPSERT', 'DROP', 'ALTER', 'CREATE',
    'TRUNCATE', 'EXEC', 'EXECUTE', 'CALL', 'COMMIT', 'ROLLBACK', 'INTO', 'APPENDING', 'EXPORT', 'IMPORT',
    'OPEN', 'FETCH', 'CLOSE', 'GRANT', 'REVOKE', 'CLIENT', 'CLIENTS', 'CONNECTION', 'PRIVILEGED']);
  if (quoted || !/^\s*SELECT\b/i.test(masked) || !tokens.includes('FROM') ||
      tokens.some(t => forbidden.has(t)) || /[;"`{}\x00-\x08\x0b\x0c\x0e-\x1f]|--|\/\*|\*\//.test(masked) ||
      /^\s*\*/m.test(masked) || /\.(?!\d)/.test(masked)) {
    throw new AppError('INVALID_QUERY', 'Use a single SELECT with FROM. Comments, statement terminators, write statements, INTO, client overrides and privileged access are not supported.');
  }
  return p;
}

export function queryResult(result: { columns: unknown[]; values: unknown[] }, limit: number) {
  if (!result.columns.length) throw new AppError('QUERY_RESPONSE_INVALID', 'SAP did not return tabular query metadata');
  return { columns: result.columns, rows: result.values.slice(0, limit), row_count: Math.min(result.values.length, limit),
    limit, truncated: result.values.length > limit, pagination_supported: false };
}

export function queryCapabilities(discovery: { collection: { href: string; templateLinks: { template: string }[] }[] }[]) {
  const links = discovery.flatMap(w => w.collection.flatMap(c => [c.href, ...c.templateLinks.map(l => l.template)]));
  const advertised = (path: string) => links.some(link => {
    try { return new URL(link.replace(/\{[^}]*\}/g, ''), 'http://adt.local/sap/bc/adt/').pathname === path; } catch { return false; }
  });
  return { table_query: { advertised: advertised('/sap/bc/adt/datapreview/ddic') },
    sql_query: { advertised: advertised('/sap/bc/adt/datapreview/freestyle') },
    availability_policy: 'Discovery advertisement is not authorization. Unadvertised endpoints may still work; actual queries establish availability.',
    max_rows: 500, values: 'raw_strings', client_policy: 'configured_client_only' };
}
