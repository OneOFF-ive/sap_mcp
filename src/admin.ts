import express from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connectionSchema, type ConfigStore, type Credentials } from './config.js';
import { AdtBackend } from './adt.js';
import { Operations } from './operations.js';
import { startHttp } from './server.js';
import { acquireLease } from './lease.js';
import { safeError, AppError } from './errors.js';
import type { BackendFactory } from './operations.js';

const draft = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  base_url: z.string(),
  client: z.string(),
  username: z.string().min(1),
  language: z.string(),
  write_enabled: z.boolean(),
  password: z.string().max(512).optional()
}).strict();

export async function startAdmin(store: ConfigStore, credentials: Credentials, port = 8766, factory: BackendFactory = (c, p) => new AdtBackend(c, p)) {
  const key = randomBytes(32).toString('base64url');
  const app = express();
  app.disable('x-powered-by');
  let runtime: Awaited<ReturnType<typeof startHttp>> | undefined;
  let busy = false;
  let active = 0;
  let closing = false;
  let mcpPort = 8765;
  const exclusive = async <T>(action: () => Promise<T>) => {
    if (busy)
      throw new AppError('BUSY', '另一项管理操作正在执行');
    busy = true;
    try {
      return await action();
    }
    finally {
      busy = false;
    }
  };
  const changeConfig = async <T>(action: () => Promise<T>) => {
    const release = await acquireLease(store.directory, 'config.lock');
    try {
      return await action();
    }
    finally {
      await release();
    }
  };
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host) ||
      (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.sendStatus(403);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', ("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"));
    if (closing || active >= 8) {
      res.sendStatus(503);
      return;
    }
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    res.once('finish', release);
    res.once('close', release);
    // Express routes are case-insensitive by default; authentication must match that policy.
    if (/^\/api(?:\/|$)/i.test(req.path)) {
      const supplied = Buffer.from(req.headers['x-admin-token'] as string ?? '');
      const expected = Buffer.from(key);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.sendStatus(401);
        return;
      }
      if (req.method !== 'GET' && req.headers.origin !== `http://${host}`) {
        res.sendStatus(403);
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/state', async (_req, res) => {
    const config = await store.load();
    res.json({
      connections: config.connections,
      tokens: config.tokens.map(({ id, created_at }) => ({
        id,
        created_at
      })),
      running: Boolean(runtime),
      mcp_port: mcpPort,
      busy
    });
  });
  app.post('/api/connections/:id/test', async (req, res) => {
    const result = await exclusive(async () => {
      const c = (await store.load()).connections.find(c => c.connection_id === req.params.id);
      if (!c)
        throw new AppError('NOT_FOUND', '连接不存在');
      const backend = factory(c, await credentials.get(c.connection_id));
      try {
        const result = await backend.capabilities() as {
          discovery?: unknown[];
        };
        return {
          success: true,
          collections: result.discovery?.length ?? 0,
          tested_at: new Date().toISOString()
        };
      }
      finally {
        await backend.close().catch(() => { });
      }
    });
    res.json(result);
  });
  app.post('/api/connections', async (req, res) => {
    const result = await exclusive(async () => changeConfig(async () => {
      if (runtime)
        throw new AppError('MCP_RUNNING', '请先停止 MCP 服务再编辑连接');
      const p = draft.parse(req.body);
      if (!p.password)
        throw new AppError('PASSWORD_REQUIRED', '请输入 SAP 密码');
      const { password, ...fields } = p;
      const c = connectionSchema.parse({
        ...fields,
        connection_id: randomUUID()
      });
      const config = await store.load();
      if (config.connections.some(v => v.name === c.name))
        throw new AppError('DUPLICATE_NAME', '连接名称已存在');
      await credentials.set(c.connection_id, password);
      config.connections.push(c);
      try {
        await store.save(config);
      }
      catch (error) {
        await credentials.remove(c.connection_id);
        throw error;
      }
      return c;
    }));
    res.json(result);
  });
  app.put('/api/connections/:id', async (req, res) => {
    const result = await exclusive(async () => changeConfig(async () => {
      if (runtime)
        throw new AppError('MCP_RUNNING', '请先停止 MCP 服务再编辑连接');
      const config = await store.load();
      const index = config.connections.findIndex(c => c.connection_id === req.params.id);
      if (index < 0)
        throw new AppError('NOT_FOUND', '连接不存在');
      const p = draft.parse(req.body);
      const { password, ...fields } = p;
      const old = config.connections[index];
      const updated = connectionSchema.parse({
        ...fields,
        connection_id: old.connection_id
      });
      if (config.connections.some(c => c !== old && c.name === updated.name))
        throw new AppError('DUPLICATE_NAME', '连接名称已存在');
      if (!password && (old.base_url !== updated.base_url || old.username !== updated.username || old.client !== updated.client))
        throw new AppError('PASSWORD_REQUIRED', '地址或登录身份已变更，请重新输入密码');
      let previous: string | undefined;
      if (password) {
        previous = await credentials.get(old.connection_id).catch(() => undefined);
        await credentials.set(old.connection_id, password);
      }
      config.connections[index] = updated;
      try {
        await store.save(config);
      }
      catch (error) {
        if (password) {
          if (previous)
            await credentials.set(old.connection_id, previous);
          else
            await credentials.remove(old.connection_id);
        }
        throw error;
      }
      return updated;
    }));
    res.json(result);
  });
  app.delete('/api/connections/:id', async (req, res) => {
    await exclusive(async () => changeConfig(async () => {
      if (runtime)
        throw new AppError('MCP_RUNNING', '请先停止 MCP 服务再编辑连接');
      const config = await store.load();
      const c = config.connections.find(c => c.connection_id === req.params.id);
      if (!c)
        throw new AppError('NOT_FOUND', '连接不存在');
      const previous = await credentials.get(c.connection_id).catch(() => undefined);
      await credentials.remove(c.connection_id);
      config.connections = config.connections.filter(v => v !== c);
      try {
        await store.save(config);
      }
      catch (error) {
        if (previous)
          await credentials.set(c.connection_id, previous);
        throw error;
      }
    }));
    res.json({ success: true });
  });
  app.post('/api/tokens', async (_req, res) => { res.json(await exclusive(() => changeConfig(() => store.createToken()))); });
  app.delete('/api/tokens/:id', async (req, res) => {
    await exclusive(() => changeConfig(async () => {
      const config = await store.load();
      config.tokens = config.tokens.filter(t => t.id !== req.params.id);
      await store.save(config);
    }));
    res.json({ success: true });
  });
  app.post('/api/service/start', async (req, res) => {
    await exclusive(async () => {
      if (runtime)
        throw new AppError('MCP_RUNNING', 'MCP 服务已启动');
      const p = z.object({ port: z.number().int().min(1).max(65535) }).strict().parse(req.body);
      if (!(await store.load()).tokens.length)
        throw new AppError('TOKEN_REQUIRED', '请先创建访问令牌');
      runtime = await startHttp(store, new Operations(store, credentials, undefined, factory), p.port);
      mcpPort = p.port;
    });
    res.json({ success: true });
  });
  app.post('/api/service/stop', async (_req, res) => {
    await exclusive(async () => {
      if (runtime) {
        await runtime.close();
        runtime = undefined;
      }
    });
    res.json({ success: true });
  });
  const assets = fileURLToPath(new URL('../web/', import.meta.url));
  app.get('/icons.js', (_req, res) => res.sendFile(fileURLToPath(new URL('../node_modules/lucide/dist/umd/lucide.js', import.meta.url))));
  app.use(express.static(assets, { etag: false }));
  app.use((_req, res) => res.sendStatus(404));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const response = error instanceof AppError ? {
      code: error.code,
      message: error.message
    }
      : error instanceof z.ZodError ? {
        code: 'INVALID_INPUT',
        message: '请检查连接名称、HTTP/HTTPS 地址、Client 和语言格式'
      }
        : {
          code: safeError(error).code,
          message: '操作失败，请检查连接信息、凭据或端口占用情况'
        };
    res.status(400).json({ error: response });
  });
  const listener = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  listener.requestTimeout = 30000;
  listener.headersTimeout = 10000;
  const address = listener.address();
  const actualPort = address && typeof address !== 'string' ? address.port : port;
  return {
    listener,
    url: `http://127.0.0.1:${actualPort}/#${key}`,
    close: async () => {
      closing = true;
      const stopped = new Promise<void>(resolve => listener.close(() => resolve()));
      while (busy)
        await new Promise(resolve => setTimeout(resolve, 50));
      if (runtime)
        await runtime.close();
      listener.closeIdleConnections();
      await stopped;
    }
  };
}
