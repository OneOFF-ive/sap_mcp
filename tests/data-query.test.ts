import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tableQuery, readOnlySql, queryCapabilities } from '../src/data-query.js';
import { AdtBackend } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { safeError } from '../src/errors.js';

test('table query validates identifiers and limits and escapes filter literals', () => {
  assert.equal(tableQuery({ table_name: 'mara' }).sql, '');
  assert.equal(tableQuery({ table_name: '/acme/material', fields: ['matnr'],
    filters: [{ field: 'matnr', operator: 'eq', value: "a' OR '1'='1" }] }).sql,
  "SELECT MATNR FROM /ACME/MATERIAL WHERE MATNR = 'a'' OR ''1''=''1'");
  for (const table_name of ['MARA; DELETE', 'MARA WHERE 1=1', '../MARA']) assert.throws(() => tableQuery({ table_name }));
  for (const limit of [0, 501, 1.1, NaN]) assert.throws(() => tableQuery({ table_name: 'MARA', limit }));
  assert.throws(() => tableQuery({ table_name: 'MARA', fields: ['* FROM USR02'] }));
});

test('SQL guard accepts SELECT joins, aggregates, nested SELECT and quoted data', () => {
  for (const sql of ["SELECT * FROM mara WHERE matnr = 'DELETE; -- ''text'''",
    'SELECT a~matnr, b~maktx FROM mara AS a INNER JOIN makt AS b ON a~matnr = b~matnr',
    'SELECT mtart, COUNT(*) AS n FROM mara GROUP BY mtart',
    'SELECT * FROM mara WHERE matnr IN ( SELECT matnr FROM makt )',
    "SELECT * FROM mara WHERE mtart = 'CLIENT'", 'SELECT * FROM mara WHERE brgew > 1.5']) {
    assert.equal(readOnlySql({ sql }).sql, sql);
  }
});

test('SQL guard rejects mutations, multiple statements, comments and client bypasses', () => {
  for (const sql of ['DELETE FROM mara', 'SELECT * FROM mara; DELETE FROM mara',
    'SELECT * FROM mara. DELETE FROM mara', 'SELECT * FROM mara INTO TABLE x',
    'SELECT * FROM mara -- comment', 'SELECT /* comment */ * FROM mara',
    'SELECT * FROM mara\n* comment', 'SELECT * FROM mara CLIENT SPECIFIED',
    "SELECT * FROM mara USING CLIENT '000'", 'SELECT * FROM x WITH PRIVILEGED ACCESS',
    "SELECT * FROM mara WHERE matnr = 'oops", 'SELECT 1', 'SELECT * FROM mara CONNECTION x',
    'SELECT * FROM mara\nUPDATE mara SET mtart = 1']) assert.throws(() => readOnlySql({ sql }), /single SELECT/);
});

test('discovery reports independent endpoint advertisement without assuming authorization', () => {
  const result = queryCapabilities([{ collection: [{ href: '/sap/bc/adt/datapreview/ddic', templateLinks: [] }] }]);
  assert.equal(result.table_query.advertised, true);
  assert.equal(result.sql_query.advertised, false);
  assert.equal(queryCapabilities([{ collection: [{ href: 'datapreview', templateLinks: [
    { template: '/sap/bc/adt/datapreview/freestyle{?rowNumber}' }
  ] }] }]).sql_query.advertised, true);
});

async function fixture(status = 200, body?: string) {
  const calls: { url: URL; method?: string; body: string; session?: string; cookie?: string }[] = [];
  const logins: URL[] = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const url = new URL(req.url!, 'http://local');
    res.setHeader('Content-Type', 'application/xml');
    if (url.pathname.endsWith('/compatibility/graph')) {
      logins.push(url); res.setHeader('x-csrf-token', 'test');
      res.setHeader('set-cookie', 'SAP_SESSIONID_MOCK_001=fake; Path=/'); res.end('<graph/>');
    }
    else if (url.pathname.includes('/datapreview/')) {
      calls.push({ url, method: req.method, body: text, session: req.headers['x-sap-adt-sessiontype'] as string, cookie: req.headers.cookie });
      res.statusCode = status;
      res.end(body ?? '<tableData><columns><metadata name="MATNR" type="N"/><dataSet><data>000001</data><data>000002</data></dataSet></columns><columns><metadata name="AMOUNT" type="P"/><dataSet><data>123456789012345678.90</data><data>0.00</data></dataSet></columns></tableData>');
    } else res.end('');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: `http://127.0.0.1:${address.port}`, client: '001', language: 'EN', username: 'TEST' }), 'fake');
  return { backend, calls, logins, close: async () => { await backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('DDIC and freestyle use independent stateless endpoints and preserve precision with bounded results', async () => {
  const f = await fixture();
  try {
    const result = await f.backend.queryTable({ table_name: 'mara', limit: 1 });
    assert.equal(result.row_count, 1); assert.equal(result.truncated, true);
    assert.deepEqual(result.rows, [{ MATNR: '000001', AMOUNT: '123456789012345678.90' }]);
    const first = f.calls[0]; assert.equal(first.url.pathname, '/sap/bc/adt/datapreview/ddic');
    assert.equal(first.body, ''); assert.equal(first.method, 'POST');
    assert.equal(first.url.searchParams.get('ddicEntityName'), 'MARA');
    assert.equal(first.url.searchParams.get('rowNumber'), '2');
    assert.equal(f.logins[0].searchParams.get('sap-client'), '001');
    assert.ok(first.cookie?.includes('SAP_SESSIONID_MOCK_001=fake'));
    assert.equal(first.session, 'stateless');
    await f.backend.queryTable({ table_name: 'mara', fields: ['matnr'], filters: [{ field: 'mtart', operator: 'eq', value: 'FERT' }] });
    assert.equal(f.calls[1].body, "SELECT MATNR FROM MARA WHERE MTART = 'FERT'");
    const sql = 'SELECT matnr FROM mara';
    await f.backend.querySql({ sql, limit: 500 });
    assert.equal(f.calls[2].url.pathname, '/sap/bc/adt/datapreview/freestyle');
    assert.equal(f.calls[2].body, sql); assert.equal(f.calls[2].url.searchParams.get('rowNumber'), '501');
    await assert.rejects(f.backend.querySql({ sql: 'DELETE FROM mara' }));
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});

for (const status of [404, 405, 501, 403, 401]) {
  test(`data query maps HTTP ${status} without confusing permissions and support`, async () => {
    const f = await fixture(status, '<error/>');
    try {
      await assert.rejects(f.backend.queryTable({ table_name: 'MARA' }), e => {
        assert.equal(safeError(e).code, [404, 405, 501].includes(status) ? 'CAPABILITY_UNSUPPORTED' : status === 401 ? 'AUTH_FAILED' : 'HTTP_FORBIDDEN'); return true;
      });
    } finally { await f.close(); }
  });
}

test('empty result retains columns and malformed response fails explicitly', async () => {
  const empty = await fixture(200, '<tableData><columns><metadata name="MATNR" type="C"/><dataSet/></columns></tableData>');
  try { const result = await empty.backend.queryTable({ table_name: 'MARA' }); assert.deepEqual(result.rows, []); assert.equal(result.truncated, false); }
  finally { await empty.close(); }
  const malformed = await fixture(200, '<html>login</html>');
  try { await assert.rejects(malformed.backend.querySql({ sql: 'SELECT * FROM mara' }), /tabular query metadata/); }
  finally { await malformed.close(); }
});
