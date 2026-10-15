import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ConfigStore } from './config.js';
import { Operations, type Input } from './operations.js';
import { safeError } from './errors.js';
import { functionModuleSyntaxHelp } from './function-help.js';
import { tableQuerySchema, sqlQuerySchema } from './data-query.js';

const id = z.string().uuid();
const connection = { connection_id: id };
const uri = z.string().min(1).max(2048);
const version = z.enum(['active', 'inactive']);
const limit = z.number().int().min(1).max(500).default(100);
const pkg = z.string().regex(/^[A-Za-z0-9_$/]+$/).max(128);
const transport = z.string().regex(/^[A-Za-z0-9]+$/).max(30).optional()
  .describe('Required on each create or update_source call when SAP requires change recording, not merely because a package is not $TMP. If omitted, the service queries SAP; confirmed local/no-recording packages need no task. Unknown requirements block writing. Tasks are not remembered or inherited. Use list_transport_requests or ask the user; never invent a task ID.');
const requestId = z.string().min(1).max(128);
const schemas = {
  list_connections: z.object({}).strict(),
  get_capabilities: z.object(connection).strict(),
  query_table: tableQuerySchema.extend(connection),
  query_sql: sqlQuerySchema.extend(connection),
  search_objects: z.object({ ...connection, query: z.string().min(1).max(128), type: z.string().max(30).optional(), limit }).strict(),
  list_package_objects: z.object({ ...connection, package_name: pkg, limit }).strict(),
  read_source: z.object({ ...connection, object_uri: uri, source_uri: uri.optional(), version: version.default('active') }).strict(),
  create_program: z.object({ ...connection, name: z.string().regex(/^[ZY][A-Z0-9_]{0,29}$/),
    program_kind: z.enum(['report', 'include', 'module_pool', 'subroutine_pool']).default('report'),
    description: z.string().min(1).max(60), package_name: pkg, transport_task: transport, request_id: requestId }).strict(),
  create_function_group: z.object({ ...connection, name: z.string().regex(/^[ZY][A-Z0-9_]{0,25}$/),
    description: z.string().min(1).max(60), package_name: pkg, transport_task: transport, request_id: requestId }).strict(),
  create_function_module: z.object({ ...connection, name: z.string().regex(/^[ZY][A-Z0-9_]{0,29}$/),
    description: z.string().min(1).max(60), function_group_uri: uri, transport_task: transport, request_id: requestId }).strict(),
  list_function_group_members: z.object({ ...connection, function_group_uri: uri, limit }).strict(),
  get_function_group: z.object({ ...connection, function_group_uri: uri }).strict(),
  update_source: z.object({ ...connection, object_uri: uri.optional(), source_uri: uri.optional(), source: z.string().max(1024 * 1024),
    expected_revision: z.string().regex(/^[a-f0-9]{64}$/), transport_task: transport, request_id: requestId }).strict()
    .refine(p => Boolean(p.object_uri || p.source_uri), { message: 'Provide object_uri or source_uri' }),
  syntax_check: z.object({ ...connection, object_uri: uri, version: version.default('inactive') }).strict(),
  activate_objects: z.object({ ...connection, objects: z.array(z.object({ object_uri: uri,
    expected_revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(20), request_id: requestId }).strict(),
  list_transport_requests: z.object(connection).strict(),
  create_transport_request: z.object({ ...connection, object_uri: uri.describe('Existing or intended Program, Include, function group or function module object URI, not source/main.'),
    package_name: pkg, description: z.string().trim().min(1).max(60), request_id: requestId }).strict()
};
const descriptions: Record<keyof typeof schemas, string> = {
  list_connections: 'List configured SAP connections with Client, language, username, backend URL and write policy. Confirm the intended system and Client before writing.',
  get_capabilities: 'Probe ADT discovery. A capability does not imply write authorization.',
  query_table: 'Read table or supported DDIC/CDS entity data via DDIC Data Preview. Use table_name, optional fields and AND-combined filters (eq/ne/gt/ge/lt/le/like). Values are strings; LIKE uses SQL % and _ wildcards. Default limit 100, maximum 500. Returns column metadata and raw string rows, preserving leading zeros and decimal precision. SAP controls entity support and permissions. Uses configured Client; no cross-client override. No stable ordering or pagination is promised. Basic queries use an empty preview body for older systems; projection/filter support depends on SAP. Does not require write_enabled.',
  query_sql: 'Run one read-only ABAP SQL SELECT through SAP freestyle Data Preview, subject to backend version and permissions. Supports joins, aggregations and subqueries as accepted by SAP. No comments, statement terminators, INTO, writes, client overrides or privileged access. Default limit 100, maximum 500; returns raw string values and column metadata. Limit bounds returned rows, not backend scan cost. Uses configured Client. No pagination. Does not require write_enabled. Query get_capabilities for discovery advertisement; unadvertised is not proof of unavailability.',
  search_objects: 'Search SAP repository objects and return relative ADT object URIs.',
  list_package_objects: 'List package contents with a limit. Pagination is not supported in this release.',
  read_source: 'Read the exact active or inactive main source. Keep the revision for a later update.',
  create_program: 'Create a Program or Include shell. program_kind: report (default), include, module_pool or subroutine_pool. Subject to SAP support and permissions. Does not activate. Follow returned next_action to read the source URI and revision discovered by SAP; do not construct source paths. Do not blindly retry unknown results.',
  create_function_group: 'Create a function group (FUGR/F) shell in a package. Does not activate. Follow next_action to obtain its snapshot; groups have no main source.',
  create_function_module: 'Create an empty function module (FUGR/FF) in an existing function group, under its group lock. Interface parameters are not configured. Does not activate. Follow next_action to read the source URI and revision discovered by SAP; do not construct source paths.',
  list_function_group_members: 'List function modules and Includes of a function group, excluding category nodes.',
  get_function_group: 'Snapshot function group members and source revisions for group activation. Pass the returned revision to activate_objects for the group. Rejects groups exceeding 500 members.',
  update_source: 'Save Program, Include, function module or group Include main source with expected revision. Does not activate. Inspect source_save even on errors: saved=true means SAP accepted the save, not that content verification passed; unknown requires reading backend state. Read inactive before retrying VERIFY_FAILED, and do not use its revision to blindly overwrite. Function modules use their own lock and ADT source-based declarations: TABLES T_RETURN TYPE BAPIRET2 OPTIONAL, not legacy STRUCTURE or Local Interface comments. EXCEPTIONS lists names only, e.g. INVALID_INPUT., never INVALID_INPUT = 1 (that is CALL FUNCTION syntax). End the definition with a period. Definition comments may be lost; implementation comments must not start with reserved prefixes *" or *"---. SAP may normalize the definition.',
  syntax_check: 'Check the requested version and return backend diagnostics.',
  activate_objects: 'Activate selected source objects with inactive revisions, or a function group with the revision from get_function_group. Group activation affects its members. May partially succeed.',
  list_transport_requests: 'List the configured SAP user transport requests and tasks. Use this to find an existing modifiable task when SAP requires change recording; package names alone do not establish that requirement. Confirm the intended task with the user if ambiguous. Does not create or release requests or select a default task.',
  create_transport_request: 'Create a new workbench development transport request for an existing or intended supported ABAP object and target package. Requires write_enabled and request_id. Query existing requests first and confirm that the user wants a NEW request. SAP CTS preflight must require recording. Returns the SAP number and verified parent request and current-user tasks separately; never assume the returned number is a task. Does not create a program, select a default task, release transports or support arbitrary Customizing requests. On unknown outcome or TRANSPORT_VERIFY_FAILED query list_transport_requests before any retry; do not blindly create duplicates.'
};
export function makeMcp(operations: Operations) {
  const server = new McpServer({ name: 'sap-mcp', version: '0.1.0' });
  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    const write = ['create_program', 'create_function_group', 'create_function_module', 'create_transport_request', 'update_source', 'activate_objects'].includes(name);
    const description = name === 'update_source'
      ? 'Provide object_uri or the source_uri returned by read_source (both must match if supplied). The main source URI is discovered under lock; expected_revision from read_source is still required. Supported function definitions permit token-equivalent formatting only; see source_save.normalization_applied, difference and warnings for definition comment changes. Unknown grammar falls back to strict verification; implementation comparison is unchanged. ' + descriptions[name]
      : descriptions[name];
    const guidance = name === 'create_function_module' || name === 'update_source' ? ' ' + functionModuleSyntaxHelp
      : name === 'read_source' ? ' If inactive returns VERSION_UNAVAILABLE, follow error.details.next_action to explicitly read active and obtain its revision. This is not proof of activation; no silent version fallback occurs.' : '';
    const transportGuidance = ['create_program', 'create_function_group', 'create_function_module', 'update_source'].includes(name)
      ? ' transport_task is required on each call when SAP requires change recording, including update_source of existing objects. A task supplied earlier is NOT remembered or inherited. If omitted outside $TMP, the service performs a read-only SAP CTS check before locking or writing: required returns TRANSPORT_REQUIRED; confirmed no-recording permits omission; failed or ambiguous checks return TRANSPORT_CHECK_UNAVAILABLE without writing. Package names alone do not determine transportability. Use list_transport_requests or ask the user for a modifiable task; never guess a task or confuse it with its parent request. SAP makes final task/ownership validation.' : '';
    server.registerTool(name, { description: description + guidance + transportGuidance, inputSchema: schemas[name],
      annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: true }
    }, async (args: Input) => {
      try {
        const result = await operations.run(name, args as Input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: result.status === 'error' };
      } catch (error) {
        const result = { status: 'error', error: safeError(error) };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
      }
    });
  }
  return server;
}
export async function startHttp(store: ConfigStore, operations: Operations, port = 8765) {
  const app = express();
  app.disable('x-powered-by');
  let inFlight = 0;
  let stopping = false;
  app.use(async (req, res, next) => {
    const host = req.headers.host;
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host)) { res.sendStatus(403); return; }
    if (req.headers.origin) { res.sendStatus(403); return; }
    if (stopping || inFlight >= 16) { res.sendStatus(503); return; }
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    res.once('finish', release); res.once('close', release);
    const auth = req.headers.authorization;
    try {
      if (!auth?.startsWith('Bearer ') || !(await store.authenticate(auth.slice(7)))) { res.sendStatus(401); return; }
    } catch { res.sendStatus(503); return; }
    if (stopping || released) { if (!released) res.sendStatus(503); return; }
    next();
  });
  app.use(express.json({ limit: '2mb', type: 'application/json' }));
  app.post('/mcp', async (req, res) => {
    const mcp = makeMcp(operations);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try { await mcp.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' }); }
    finally { await mcp.close(); }
  });
  app.all('/mcp', (_req, res) => res.sendStatus(405));
  app.use((_req, res) => res.sendStatus(404));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((error as { status?: number }).status === 413 ? 413 : 400).json({ error: 'Invalid request body' });
  });
  const listener = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server)); server.once('error', reject);
  });
  listener.requestTimeout = 30000;
  listener.headersTimeout = 10000;
  return { listener, close: async () => {
    stopping = true;
    const stopped = new Promise<void>(resolve => listener.close(() => resolve()));
    await operations.close();
    listener.closeIdleConnections();
    await stopped;
  } };
}
