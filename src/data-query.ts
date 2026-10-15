import { z } from 'zod';
import { AppError } from './errors.js';

export const entityName = z.string().regex(/^(?:\/[A-Za-z0-9_]+\/)?[A-Za-z_][A-Za-z0-9_]*$/).max(128);

export const fieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);

export const queryLimit = z.number().int().min(1).max(500).default(100).describe(("Maximum returned rows, default 100, maximum 500. Does not bound database scan cost; prefer a small value " +
  "and selective filters. No pagination cursor."));

export const tableQuerySchema = z.object({
  table_name: entityName.describe('DDIC table or backend-supported entity name, e.g. MARA. Not a SQL expression or URL.'),
  fields: z.array(fieldName).min(1).max(100).optional().describe('Columns to return, e.g. ["MATNR", "MTART"]. Omit for all columns; prefer only fields needed for the task.'),
  filters: z.array(z.object({
    field: fieldName,
    operator: z.enum(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like']),
    value: z.string().max(2048).describe('Raw value as a string; do not add SQL quotes. Preserve leading zeros. LIKE uses % and _ wildcards.')
  }).strict()).max(50).default([]).describe('AND-combined comparisons. Example: [{"field":"MTART","operator":"eq","value":"FERT"}]. No OR or SQL fragments.'),
  limit: queryLimit
}).strict();

export const sqlQuerySchema = z.object({
  sql: z.string().trim().min(1).max(16384).describe(("One read-only ABAP SQL SELECT with FROM, e.g. SELECT matnr FROM mara WHERE mtart = 'FERT'. No terminator, " +
    "comments, INTO or CLIENT/CLIENTS overrides. Use ~ for qualified fields; never insert untrusted values as " +
    "SQL syntax.")),
  limit: queryLimit
}).strict();

export type TableQuery = z.input<typeof tableQuerySchema>;

export type SqlQuery = z.input<typeof sqlQuerySchema>;

const sqlOperators = {
  eq: '=',
  ne: '<>',
  gt: '>',
  ge: '>=',
  lt: '<',
  le: '<=',
  like: 'LIKE'
};

export function tableQuery(input: TableQuery) {
  const query = tableQuerySchema.parse(input);
  const tableName = query.table_name.toUpperCase();
  const selectedFields = query.fields?.map(field => field.toUpperCase()).join(', ') ?? '*';
  const conditions = query.filters.map(filter => {
    const field = filter.field.toUpperCase();
    const operator = sqlOperators[filter.operator];
    const escapedValue = filter.value.replace(/'/g, "''");
    return `${field} ${operator} '${escapedValue}'`;
  });
  const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  // An empty body uses the basic DDIC preview, including on older systems.
  const needsCustomQuery = query.fields !== undefined || query.filters.length > 0;
  const sql = needsCustomQuery ? `SELECT ${selectedFields} FROM ${tableName}${whereClause}` : '';
  return {
    ...query,
    table_name: tableName,
    sql
  };
}

// Mask literals while preserving positions and line breaks outside them. Tokens inside
// user data must not be mistaken for SQL commands or client-handling clauses.
function maskSqlLiterals(sql: string) {
  let maskedSql = '';
  let insideLiteral = false;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index];
    if (character === "'") {
      if (insideLiteral && sql[index + 1] === "'") {
        maskedSql += '  ';
        index++;
        continue;
      }
      insideLiteral = !insideLiteral;
      maskedSql += ' ';
      continue;
    }
    maskedSql += insideLiteral ? ' ' : character;
  }
  return {
    maskedSql,
    hasUnclosedLiteral: insideLiteral
  };
}

const forbiddenSqlKeywords = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MODIFY', 'MERGE', 'UPSERT', 'DROP', 'ALTER', 'CREATE',
  'TRUNCATE', 'EXEC', 'EXECUTE', 'CALL', 'COMMIT', 'ROLLBACK', 'INTO', 'APPENDING',
  'EXPORT', 'IMPORT', 'OPEN', 'FETCH', 'CLOSE', 'GRANT', 'REVOKE',
  'CLIENT', 'CLIENTS', 'CONNECTION', 'PRIVILEGED'
]);

export function readOnlySql(input: SqlQuery) {
  const query = sqlQuerySchema.parse(input);
  const { maskedSql, hasUnclosedLiteral } = maskSqlLiterals(query.sql);
  const keywords: string[] = maskedSql.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? [];
  const isSelectWithFrom = /^\s*SELECT\b/i.test(maskedSql) && keywords.includes('FROM');
  const hasForbiddenKeyword = keywords.some(keyword => forbiddenSqlKeywords.has(keyword));
  const hasCommentOrDelimiter = /[;"`{}\x00-\x08\x0b\x0c\x0e-\x1f]|--|\/\*|\*\//.test(maskedSql)
    || /^\s*\*/m.test(maskedSql);
  // A decimal point is permitted; a statement-ending ABAP period is not.
  const hasStatementPeriod = /\.(?!\d)/.test(maskedSql);
  if (hasUnclosedLiteral || !isSelectWithFrom || hasForbiddenKeyword || hasCommentOrDelimiter || hasStatementPeriod) {
    throw new AppError('INVALID_QUERY', ("Use a single SELECT with FROM. Comments, statement terminators, write statements, INTO, client overrides " +
      "and privileged access are not supported."));
  }
  return query;
}

export function queryResult(result: {
  columns: unknown[];
  values: unknown[];
}, limit: number) {
  if (!result.columns.length)
    throw new AppError('QUERY_RESPONSE_INVALID', 'SAP did not return tabular query metadata');
  return {
    columns: result.columns,
    rows: result.values.slice(0, limit),
    row_count: Math.min(result.values.length, limit),
    limit,
    truncated: result.values.length > limit,
    pagination_supported: false
  };
}

type DiscoveryWorkspace = {
  collection: {
    href: string;
    templateLinks: {
      template: string;
    }[];
  }[];
};

function discoveryLinkMatchesPath(link: string, path: string): boolean {
  try {
    const withoutTemplateParameters = link.replace(/\{[^}]*\}/g, '');
    const url = new URL(withoutTemplateParameters, 'http://adt.local/sap/bc/adt/');
    return url.pathname === path;
  }
  catch {
    return false;
  }
}

export function queryCapabilities(discovery: DiscoveryWorkspace[]) {
  const links = discovery.flatMap(workspace => workspace.collection.flatMap(collection => [
    collection.href,
    ...collection.templateLinks.map(link => link.template)
  ]));
  const isAdvertised = (path: string) => links.some(link => discoveryLinkMatchesPath(link, path));
  return {
    table_query: { advertised: isAdvertised('/sap/bc/adt/datapreview/ddic') },
    sql_query: { advertised: isAdvertised('/sap/bc/adt/datapreview/freestyle') },
    availability_policy: 'Discovery advertisement is not authorization. Unadvertised endpoints may still work; actual queries establish availability.',
    max_rows: 500,
    values: 'raw_strings',
    client_policy: 'configured_client_only'
  };
}
