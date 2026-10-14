import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { ConfigStore, type Credentials } from '../src/config.js';
import { startAdmin } from '../src/admin.js';
import type { Backend } from '../src/adt.js';

test('local web management protects APIs and manages connections, credentials, tokens and service lifecycle', async () => {
  const root = join(process.cwd(), '.sap-mcp', 'tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'admin-'));
  const store = new ConfigStore(directory); const passwords = new Map<string, string>();
  const credentials: Credentials = { get: async id => { const value = passwords.get(id); if (!value) throw new Error('Missing'); return value; },
    set: async (id, value) => { passwords.set(id, value); }, remove: async id => { passwords.delete(id); } };
  let probes = 0;
  const runtime = await startAdmin(store, credentials, 0, () => ({ capabilities: async () => { probes++; return { discovery: [{}] }; }, close: async () => {} } as Backend));
  const address = new URL(runtime.url); const origin = address.origin;
  const key = address.hash.slice(1);
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${origin}/api/${path}`, { method,
      headers: { 'X-Admin-Token': key, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const home = await fetch(origin); assert.equal(home.status, 200); assert.ok((await home.text()).includes('系统连接'));
    assert.ok(home.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    assert.equal((await fetch(`${origin}/icons.js`)).status, 200);
    assert.equal((await fetch(`${origin}/api/state`)).status, 401);
    assert.equal((await fetch(`${origin}/api/state`, { headers: { 'X-Admin-Token': key, Origin: 'http://evil.test' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/tokens`, { method: 'POST', headers: { 'X-Admin-Token': key } })).status, 403);
    const draft = { name: 'test_system', base_url: 'http://sap.test:8000', client: '001', username: 'TEST', language: 'EN', write_enabled: false, password: 'synthetic-secret' };
    const created = await api('connections', 'POST', draft); assert.equal(created.status, 200);
    const id = created.body.connection_id; assert.ok(id); assert.equal(created.body.password, undefined);
    assert.equal(passwords.get(id), draft.password);
    assert.equal((await api('connections', 'POST', draft)).status, 400);
    assert.equal((await api(`connections/${id}/test`, 'POST')).body.success, true); assert.equal(probes, 1);
    const changedTarget = await api(`connections/${id}`, 'PUT', { ...draft, base_url: 'http://other.test', password: undefined });
    assert.equal(changedTarget.body.error.code, 'PASSWORD_REQUIRED');
    const update = await api(`connections/${id}`, 'PUT', { ...draft, password: undefined, write_enabled: true });
    assert.equal(update.status, 200); assert.equal(update.body.connection_id, id);
    const token = await api('tokens', 'POST'); assert.equal(token.status, 200);
    assert.equal(await store.authenticate(token.body.token), true);
    const state = await api('state');
    assert.equal(JSON.stringify(state.body).includes(token.body.token), false);
    assert.equal(JSON.stringify(state.body).includes('synthetic-secret'), false);
    assert.equal((await readFile(join(directory, 'config.json'), 'utf8')).includes('synthetic-secret'), false);
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
    assert.equal((await api('service/start', 'POST', { port })).status, 200);
    assert.equal((await api('state')).body.running, true);
    assert.equal((await api(`connections/${id}`, 'DELETE')).body.error.code, 'MCP_RUNNING');
    assert.equal((await api(`connections/${id}`, 'PUT', { ...draft, password: undefined })).body.error.code, 'MCP_RUNNING');
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' })).status, 401);
    assert.equal((await api('service/stop', 'POST')).status, 200);
    assert.equal((await api('state')).body.running, false);
    await api(`tokens/${token.body.id}`, 'DELETE'); assert.equal(await store.authenticate(token.body.token), false);
    assert.equal((await api('service/start', 'POST', { port })).body.error.code, 'TOKEN_REQUIRED');
    assert.equal((await api(`connections/${id}`, 'DELETE')).status, 200); assert.equal(passwords.size, 0);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
