import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AdtBackend } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { safeError } from '../src/errors.js';

test('real ADT adapter carries Client, language, cookies and CSRF through read/save/check/activate', async () => {
  const object = '/sap/bc/adt/programs/programs/ztest';
  const source = `${object}/source/main`;
  let active = 'REPORT ztest.';
  let inactive = active;
  const requests: { path: string; method: string; body: string; csrf?: string; cookie?: string }[] = [];
  const assertions: (() => void)[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://local');
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: url.pathname, method: req.method!, body, csrf: req.headers['x-csrf-token'] as string, cookie: req.headers.cookie });
    res.setHeader('Content-Type', 'application/xml');
    if (url.pathname.endsWith('/compatibility/graph')) {
      assertions.push(() => {
        assert.equal(url.searchParams.get('sap-client'), '001');
        assert.equal(url.searchParams.get('sap-language'), 'EN');
        assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('TEST:fake').toString('base64'));
      });
      res.setHeader('x-csrf-token', 'csrf-test'); res.setHeader('Set-Cookie', 'SAP_SESSIONID_TEST=test; Path=/');
      res.end('<compatibility:graph xmlns:compatibility="test"/>');
    } else if (url.pathname.endsWith('/discovery')) {
      res.end('<app:service xmlns:app="http://www.w3.org/2007/app" xmlns:atom="http://www.w3.org/2005/Atom"><app:workspace><atom:title>Programs</atom:title><app:collection href="/sap/bc/adt/programs/programs"><atom:title>Programs</atom:title></app:collection></app:workspace></app:service>');
    } else if (url.pathname === object && url.searchParams.get('_action') === 'LOCK') {
      res.end('<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>lock-test</LOCK_HANDLE></DATA></asx:values></asx:abap>');
    } else if (url.pathname === object && url.searchParams.get('_action') === 'UNLOCK') {
      res.end('');
    } else if (url.pathname === object) {
      const version = url.searchParams.get('version') ?? 'active';
      res.end(`<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:atom="http://www.w3.org/2005/Atom" adtcore:name="ZTEST" adtcore:type="PROG/P" adtcore:version="${version}" program:programType="executableProgram" abapsource:sourceUri="source/main"><atom:link href="source/main" type="text/plain"/></program:abapProgram>`);
    } else if (url.pathname === source && req.method === 'PUT') {
      assertions.push(() => assert.equal(url.searchParams.get('lockHandle'), 'lock-test'));
      inactive = body; res.statusCode = 204; res.end();
    } else if (url.pathname === source) {
      res.setHeader('Content-Type', 'text/plain'); res.end(url.searchParams.get('version') === 'inactive' ? inactive : active);
    } else if (url.pathname.endsWith('/checkruns')) {
      res.end('<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>');
    } else if (url.pathname.endsWith('/activation')) {
      active = inactive; res.statusCode = 204; res.end();
    } else if (url.pathname.endsWith('/logoff')) { res.end(''); }
    else { res.statusCode = 404; res.end('Missing'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connection = connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: `http://127.0.0.1:${address.port}`,
    client: '001', language: 'EN', username: 'TEST' });
  const backend = new AdtBackend(connection, 'fake');
  try {
    assert.ok(await backend.capabilities());
    assert.equal((await backend.read(object, 'active')).source, active);
    const handle = await backend.lock(object); assert.equal(handle, 'lock-test');
    await backend.save(source, 'REPORT ztest. WRITE 1.', handle);
    assert.equal((await backend.read(object, 'inactive')).source, inactive);
    assert.equal((await backend.check(object, 'inactive') as { passed: boolean }).passed, true);
    assert.equal((await backend.activate(object)).success, true);
    await backend.unlock(object, handle);
    assert.equal((await backend.read(object, 'active')).source, 'REPORT ztest. WRITE 1.');
    for (const request of requests.filter(r => r.path !== '/sap/bc/adt/compatibility/graph')) {
      assert.equal(request.csrf, 'csrf-test'); assert.ok(request.cookie?.includes('SAP_SESSIONID_TEST=test'));
    }
    for (const assertion of assertions) assertion();
  } finally { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('ADT adapter does not follow redirects or leak credentials to redirect targets', async () => {
  let targetHits = 0;
  const target = createServer((_req, res) => { targetHits++; res.end('unexpected'); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetAddress = target.address(); assert.ok(targetAddress && typeof targetAddress !== 'string');
  const redirect = createServer((_req, res) => { res.statusCode = 302; res.setHeader('Location', `http://127.0.0.1:${targetAddress.port}/target`); res.end(''); });
  await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve));
  const address = redirect.address(); assert.ok(address && typeof address !== 'string');
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: `http://127.0.0.1:${address.port}`,
    client: '001', language: 'EN', username: 'TEST' }), 'fake');
  try { await assert.rejects(backend.capabilities()); assert.equal(targetHits, 0); }
  finally { await backend.close().catch(() => {}); await new Promise<void>(resolve => redirect.close(() => resolve()));
    await new Promise<void>(resolve => target.close(() => resolve())); }
});

test('SAP authentication failures are classified without exposing response data', async () => {
  const server = createServer((_req, res) => { res.statusCode = 401; res.end('secret backend detail'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: `http://127.0.0.1:${address.port}`,
    client: '001', language: 'EN', username: 'TEST' }), 'fake');
  try { await assert.rejects(backend.capabilities(), error => {
    const result = safeError(error); assert.equal(result.code, 'AUTH_FAILED'); assert.equal(JSON.stringify(result).includes('secret'), false); return true;
  }); } finally { await backend.close().catch(() => {}); await new Promise<void>(resolve => server.close(() => resolve())); }
});
