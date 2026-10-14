import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ConfigStore } from './config.js';
import { Operations, type Input } from './operations.js';
import { safeError } from './errors.js';

const id = z.string().uuid();
const connection = { connection_id: id };
const uri = z.string().min(1).max(2048);
const version = z.enum(['active', 'inactive']);
const limit = z.number().int().min(1).max(500).default(100);
const pkg = z.string().regex(/^[A-Za-z0-9_$/]+$/).max(128);
const transport = z.string().regex(/^[A-Za-z0-9]+$/).max(30).optional();
const requestId = z.string().min(1).max(128);
const schemas = {
  list_connections: z.object({}).strict(),
  get_capabilities: z.object(connection).strict(),
  search_objects: z.object({ ...connection, query: z.string().min(1).max(128), type: z.string().max(30).optional(), limit }).strict(),
  list_package_objects: z.object({ ...connection, package_name: pkg, limit }).strict(),
  read_source: z.object({ ...connection, object_uri: uri, source_uri: uri.optional(), version: version.default('active') }).strict(),
  create_program: z.object({ ...connection, name: z.string().regex(/^[ZY][A-Z0-9_]{0,29}$/),
    description: z.string().min(1).max(60), package_name: pkg, transport_task: transport, request_id: requestId }).strict(),
  update_source: z.object({ ...connection, source_uri: uri, source: z.string().max(1024 * 1024),
    expected_revision: z.string().regex(/^[a-f0-9]{64}$/), transport_task: transport, request_id: requestId }).strict(),
  syntax_check: z.object({ ...connection, object_uri: uri, version: version.default('inactive') }).strict(),
  activate_objects: z.object({ ...connection, objects: z.array(z.object({ object_uri: uri,
    expected_revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(20), request_id: requestId }).strict(),
  list_transport_requests: z.object(connection).strict()
};
const descriptions: Record<keyof typeof schemas, string> = {
  list_connections: 'List locally configured SAP connections and write policies.',
  get_capabilities: 'Probe ADT discovery. A capability does not imply write authorization.',
  search_objects: 'Search SAP repository objects and return relative ADT object URIs.',
  list_package_objects: 'List package contents with a limit. Pagination is not supported in this release.',
  read_source: 'Read the exact active or inactive main source. Keep the revision for a later update.',
  create_program: 'Create a REPORT shell in the specified package, subject to SAP permissions. Does not activate it. Do not blindly retry unknown results.',
  update_source: 'Save program main source as inactive under lock with expected revision. Does not activate.',
  syntax_check: 'Check the requested version and return backend diagnostics.',
  activate_objects: 'Activate explicitly selected programs after checking inactive revisions. May partially succeed.',
  list_transport_requests: 'List the configured SAP user transport requests and tasks.'
};
export function makeMcp(operations: Operations) {
  const server = new McpServer({ name: 'sap-mcp', version: '0.1.0' });
  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    const write = ['create_program', 'update_source', 'activate_objects'].includes(name);
    server.registerTool(name, { description: descriptions[name], inputSchema: schemas[name],
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
