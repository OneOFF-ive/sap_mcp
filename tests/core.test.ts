import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConfigStore, connectionSchema, normalizeUrl, type Credentials } from '../src/config.js';
import { AuditLog } from '../src/audit.js';
import { adtUri, sameSavedSource, sourceResult, type Backend, type Version } from '../src/adt.js';
import { Operations } from '../src/operations.js';
import { AppError } from '../src/errors.js';
import { startHttp } from '../src/server.js';

const object = '/sap/bc/adt/programs/programs/ztest';
const source = `${object}/source/main`;
const credentials: Credentials = { get: async () => 'fake', set: async () => {}, remove: async () => {} };
test('save comparison ignores only final line breaks, not content or whitespace', () => {
  assert.equal(sameSavedSource('REPORT ztest.\r\n', 'REPORT ztest.'), true);
  assert.equal(sameSavedSource('REPORT ztest.\n\n', 'REPORT ztest.\r\n'), true);
  assert.equal(sameSavedSource('REPORT ztest. ', 'REPORT ztest.'), false);
  assert.equal(sameSavedSource('REPORT ztest.\n* comment', 'REPORT ztest.* comment'), false);
  assert.equal(sameSavedSource('WRITE 1.', 'WRITE 2.'), false);
});
class FakeBackend implements Backend {
  active = 'REPORT ztest.'; inactive: string | undefined;
  saves = 0; locks = 0; unlocks = 0; failUnlock = false; uncertain = false; activationPass = true;
  constructor(private connection: string) {}
  async capabilities() { return { available: true }; }
  async search() { return { objects: [{ object_uri: object }] }; }
  async listPackage() { return { objects: [] }; }
  async read(uri: string, version: Version) {
    const code = version === 'active' ? this.active : this.inactive;
    if (code === undefined) throw new AppError('VERSION_UNAVAILABLE', 'No inactive source');
    return sourceResult(this.connection, uri, `${uri}/source/main`, code, version);
  }
  async packageOf() { return '$TMP'; }
  async lock() { this.locks++; return 'private-lock-handle'; }
  async unlock() { this.unlocks++; if (this.failUnlock) throw new Error('Unlock failed'); }
  async save(_uri: string, code: string) { this.saves++; this.inactive = code;
    if (this.uncertain) throw new AppError('OUTCOME_UNKNOWN', 'Connection was interrupted'); }
  async create() { this.inactive = this.active; return object; }
  async check() { return { passed: true }; }
  async activate() { if (this.activationPass) { this.active = this.inactive!; this.inactive = undefined; }
    return { success: this.activationPass, messages: [] }; }
  async transports() { return []; }
  async close() {}
}
async function fixture() {
  const root = join(process.cwd(), '.sap-mcp', 'tests');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'test-'));
  const store = new ConfigStore(directory);
  const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'dev', base_url: 'http://sap.test:8000',
    client: '001', username: 'TEST', language: 'EN', write_enabled: true });
  await store.save({ schema_version: 1, connections: [connection], tokens: [] });
  const backend = new FakeBackend(connection.connection_id);
  const logDirectory = join(directory, 'logs');
  const operations = new Operations(store, credentials, new AuditLog(logDirectory), () => backend);
  return { directory, store, connection, backend, operations, logDirectory,
    cleanup: async () => { await operations.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('SAP stripping the final newline succeeds and returns the actual saved revision', async () => {
  const f = await fixture(); try {
    f.backend.save = async (_uri, code) => { f.backend.saves++; f.backend.inactive = code.replace(/[\r\n]+$/, ''); };
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest.\r\n* test\r\n',
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'normalized-save' });
    assert.equal(result.status, 'success'); assert.equal(result.outcome, 'confirmed');
    assert.deepEqual(result.data, { ...await f.backend.read(object, 'inactive'), activated: false });
  } finally { await f.cleanup(); }
});

test('save verification still fails for changed program content', async () => {
  const f = await fixture(); try {
    f.backend.save = async () => { f.backend.saves++; f.backend.inactive = 'REPORT ztest. WRITE 99.'; };
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest. WRITE 1.\r\n',
      expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'changed-content' });
    assert.equal(result.error?.code, 'VERIFY_FAILED'); assert.equal(result.outcome, 'partial');
  } finally { await f.cleanup(); }
});

test('activation verification accepts SAP removing final line breaks', async () => {
  const f = await fixture(); try {
    f.backend.inactive = 'REPORT ztest.\r\n* test\r\n';
    f.backend.activate = async () => {
      f.backend.active = f.backend.inactive!.replace(/[\r\n]+$/, '');
      f.backend.inactive = undefined; return { success: true, messages: [] };
    };
    const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id,
      objects: [{ object_uri: object, expected_revision: (await f.backend.read(object, 'inactive')).revision }], request_id: 'normalized-activation' });
    assert.equal(result.status, 'success'); assert.ok(result.completed_steps.includes('activation_verified'));
  } finally { await f.cleanup(); }
});

test('activation releases the editor lock before calling SAP activation', async () => {
  const f = await fixture(); try {
    f.backend.inactive = 'REPORT ztest.\n* activation test';
    const original = f.backend.activate.bind(f.backend);
    f.backend.activate = async () => {
      assert.equal(f.backend.locks, f.backend.unlocks, 'Editor lock must be released before activation');
      return original();
    };
    const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id,
      objects: [{ object_uri: object, expected_revision: (await f.backend.read(object, 'inactive')).revision }], request_id: 'unlock-first' });
    assert.equal(result.status, 'success');
    assert.ok(result.completed_steps.indexOf('unlocked') < result.completed_steps.indexOf('activated'));
  } finally { await f.cleanup(); }
});

test('activation stops when lock release fails or the source changes after unlocking', async () => {
  for (const failUnlock of [true, false]) {
    const f = await fixture(); try {
      f.backend.inactive = 'REPORT ztest.\n* original';
      const revision = (await f.backend.read(object, 'inactive')).revision;
      let activations = 0;
      f.backend.activate = async () => { activations++; return { success: true, messages: [] }; };
      f.backend.failUnlock = failUnlock;
      if (!failUnlock) f.backend.unlock = async () => { f.backend.unlocks++; f.backend.inactive += '\n* concurrent edit'; };
      const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id,
        objects: [{ object_uri: object, expected_revision: revision }], request_id: 'activation-blocked' });
      assert.equal(result.error?.code, failUnlock ? 'LOCK_CLEANUP_FAILED' : 'VERSION_CONFLICT');
      assert.equal(activations, 0);
    } finally { await f.cleanup(); }
  }
});

test('normalization preserves client and rejects URL credentials/custom paths', () => {
  assert.equal(normalizeUrl('http://sap.test:8000/sap/bc/adt/'), 'http://sap.test:8000');
  for (const url of ['http://user:secret@sap.test', 'https://sap.test', 'http://sap.test/other', 'http://sap.test?q=1'])
    assert.throws(() => normalizeUrl(url));
});
test('ADT paths reject traversal, queries, remote URLs and double encoding', () => {
  assert.equal(adtUri(source), source);
  for (const uri of ['http://evil.test', '/sap/bc/adt/../x', '/sap/bc/adt/%2e%2e/x', '/sap/bc/adt/%252e%252e/x', '/sap/bc/adt/a?x', '/sap/bc/adt/a%5cb'])
    assert.throws(() => adtUri(uri));
});
test('tokens are stored hashed and revocation takes effect', async () => {
  const f = await fixture(); try {
    const { token } = await f.store.createToken();
    assert.equal(await f.store.authenticate(token), true);
    assert.equal(await f.store.authenticate('wrong'), false);
    assert.equal((await readFile(join(f.directory, 'config.json'), 'utf8')).includes(token), false);
    const config = await f.store.load(); config.tokens = []; await f.store.save(config);
    assert.equal(await f.store.authenticate(token), false);
  } finally { await f.cleanup(); }
});
test('legacy package restrictions are ignored and removed on save', async () => {
  const f = await fixture(); try {
    const config = await f.store.load();
    const legacy = { ...config, connections: [{ ...config.connections[0], allowed_packages: ['$TMP'] }] };
    await writeFile(join(f.directory, 'config.json'), JSON.stringify(legacy));
    const loaded = await f.store.load();
    assert.equal('allowed_packages' in loaded.connections[0], false);
    const result = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZTEST', package_name: 'ZNEW_PACKAGE', description: 'Test', transport_task: 'DEVK900001', request_id: 'legacy-package' });
    assert.equal(result.status, 'success');
    const listed = await f.operations.run('list_connections', {});
    assert.equal(JSON.stringify(listed.data).includes('allowed_packages'), false);
    await f.store.save(loaded);
    assert.equal((await readFile(join(f.directory, 'config.json'), 'utf8')).includes('allowed_packages'), false);
    assert.equal(loaded.connections[0].connection_id, f.connection.connection_id);
  } finally { await f.cleanup(); }
});
test('concurrent duplicate updates save once, unlock and log no source or handle', async () => {
  const f = await fixture(); try {
    const original = await f.backend.read(object, 'active');
    const args = { connection_id: f.connection.connection_id, source_uri: source, source: 'REPORT ztest.\nWRITE 1.',
      expected_revision: original.revision, request_id: 'one' };
    const [a, b] = await Promise.all([f.operations.run('update_source', args), f.operations.run('update_source', args)]);
    assert.deepEqual(a, b); assert.equal(a.status, 'success'); assert.equal(f.backend.saves, 1); assert.equal(f.backend.unlocks, 1);
    const text = await readFile(join(f.logDirectory, (await readdir(f.logDirectory))[0]), 'utf8');
    assert.ok(text.trim().split('\n').every(line => JSON.parse(line).operation_id));
    assert.equal(text.includes(args.source), false); assert.equal(text.includes('private-lock-handle'), false);
    await assert.rejects(f.operations.run('update_source', { ...args, source: 'different' }), /Request ID/);
  } finally { await f.cleanup(); }
});
test('stale revision and existing inactive draft do not overwrite code', async () => {
  const f = await fixture(); try {
    const revision = (await f.backend.read(object, 'active')).revision;
    f.backend.inactive = 'REPORT ztest. WRITE 99.';
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id, source_uri: source,
      expected_revision: revision, source: 'REPORT ztest. WRITE 1.', request_id: 'conflict' });
    assert.equal(result.error?.code, 'VERSION_CONFLICT'); assert.equal(f.backend.saves, 0); assert.equal(f.backend.unlocks, 1);
  } finally { await f.cleanup(); }
});
test('disabled writes fail before locks; nonlocal packages require transport tasks', async () => {
  const f = await fixture(); try {
    const config = await f.store.load(); config.connections[0].write_enabled = false; await f.store.save(config);
    let result = await f.operations.run('create_program', { connection_id: f.connection.connection_id, name: 'ZTEST',
      package_name: '$TMP', description: 'Test', request_id: 'disabled' });
    assert.equal(result.error?.code, 'WRITE_DISABLED');
    config.connections[0].write_enabled = true; await f.store.save(config);
    result = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZTEST', package_name: 'ZOTHER', description: 'Test', request_id: 'no-transport' });
    assert.equal(result.error?.code, 'TRANSPORT_REQUIRED'); assert.equal(f.backend.locks, 0);
    result = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZTEST', package_name: 'ZOTHER', description: 'Test', transport_task: 'DEVK900001', request_id: 'any-package' });
    assert.equal(result.status, 'success');
  } finally { await f.cleanup(); }
});
test('unlock failure preserves confirmed save and returns warning', async () => {
  const f = await fixture(); try {
    f.backend.failUnlock = true;
    const result = await f.operations.run('update_source', { connection_id: f.connection.connection_id, source_uri: source,
      source: 'REPORT ztest. WRITE 2.', expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'unlock' });
    assert.equal(result.status, 'success'); assert.equal(result.outcome, 'confirmed');
    assert.ok(result.warnings?.includes('LOCK_CLEANUP_FAILED'));
    const blocked = await f.operations.run('create_program', { connection_id: f.connection.connection_id,
      name: 'ZOTHER', description: 'Test', package_name: '$TMP', request_id: 'after-unlock-failure' });
    assert.equal(blocked.error?.code, 'SESSION_NEEDS_REVIEW');
  } finally { await f.cleanup(); }
});
test('unknown write results are not retried, and locks are released', async () => {
  const f = await fixture(); try {
    f.backend.uncertain = true;
    const args = { connection_id: f.connection.connection_id, source_uri: source,
      source: 'REPORT ztest. WRITE 3.', expected_revision: (await f.backend.read(object, 'active')).revision, request_id: 'timeout' };
    const a = await f.operations.run('update_source', args); const b = await f.operations.run('update_source', args);
    assert.equal(a.outcome, 'unknown'); assert.equal(a.error?.code, 'OUTCOME_UNKNOWN'); assert.deepEqual(a, b);
    assert.equal(f.backend.saves, 1); assert.equal(f.backend.unlocks, 1);
  } finally { await f.cleanup(); }
});
test('failed activation reports partial state and preserves inactive code', async () => {
  const f = await fixture(); try {
    f.backend.inactive = 'REPORT ztest. WRITE 4.'; f.backend.activationPass = false;
    const result = await f.operations.run('activate_objects', { connection_id: f.connection.connection_id, request_id: 'activate',
      objects: [{ object_uri: object, expected_revision: (await f.backend.read(object, 'inactive')).revision }] });
    assert.equal(result.error?.code, 'ACTIVATION_FAILED'); assert.equal(result.outcome, 'partial');
    assert.ok(f.backend.inactive); assert.equal(f.backend.unlocks, 1);
  } finally { await f.cleanup(); }
});
test('log unavailable prevents SAP mutation', async () => {
  const f = await fixture(); try {
    const ops = new Operations(f.store, credentials, { append: async () => { throw new Error('Disk failed'); } } as AuditLog, () => f.backend);
    const result = await ops.run('create_program', { connection_id: f.connection.connection_id, name: 'ZTEST', package_name: '$TMP',
      description: 'Test', request_id: 'no-log' });
    assert.equal(result.error?.code, 'LOG_UNAVAILABLE'); assert.equal(f.backend.inactive, undefined); await ops.close();
  } finally { await f.cleanup(); }
});
test('logging failure after SAP save preserves the known result', async () => {
  const f = await fixture(); try {
    let count = 0;
    const ops = new Operations(f.store, credentials, { append: async () => {
      count++; if (count >= 3) throw new Error('Disk failed after saving');
    } } as AuditLog, () => f.backend);
    const result = await ops.run('update_source', { connection_id: f.connection.connection_id,
      source_uri: source, source: 'REPORT ztest. WRITE 5.', expected_revision: (await f.backend.read(object, 'active')).revision,
      request_id: 'log-after-save' });
    assert.equal(result.status, 'success'); assert.equal(result.outcome, 'confirmed');
    assert.ok(result.warnings?.includes('LOG_WRITE_FAILED')); assert.equal(f.backend.saves, 1); await ops.close();
  } finally { await f.cleanup(); }
});
test('shutdown waits for queued operations and prevents new work', async () => {
  const f = await fixture(); try {
    const pending = f.operations.run('read_source', { connection_id: f.connection.connection_id, object_uri: object });
    const closing = f.operations.close();
    await assert.rejects(f.operations.run('list_connections', {}), /stopping/);
    assert.equal((await pending).status, 'success'); await closing;
  } finally { await f.cleanup(); }
});
test('real MCP SDK HTTP client initializes, lists tools and reads source; HTTP rejects bad auth/origin', async () => {
  const f = await fixture();
  const token = await f.store.createToken(); const runtime = await startHttp(f.store, f.operations, 0);
  const address = runtime.listener.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const client = new Client({ name: 'test-client', version: '1.0' });
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token.token}`, Origin: 'http://evil.test' } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }));
    assert.equal((await client.listTools()).tools.length, 10);
    const result = await client.callTool({ name: 'read_source', arguments: { connection_id: f.connection.connection_id, object_uri: object } });
    assert.equal(result.isError, false); assert.equal((result.structuredContent as { data: { source: string } }).data.source, 'REPORT ztest.');
    const invalid = await client.callTool({ name: 'read_source', arguments: { connection_id: f.connection.connection_id, object_uri: 'http://evil.test' } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await runtime.close(); await f.cleanup(); }
});
