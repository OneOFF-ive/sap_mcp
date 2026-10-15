import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransportList, parseTransportDetails } from '../src/transports.js';
import { AdtBackend } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { randomUUID } from 'node:crypto';

for (const prefix of ['tm:', 'cts:', '']) {
  for (const grouped of [true, false]) {
    test(`transport list accepts prefix ${prefix || 'default'} and grouped=${grouped}`, () => {
      const xml = `<root xmlns="urn:test"><workbench>${grouped ? '<target name="DEV">' : ''}<modifiable><request number="DEVK904708" owner="ZJT_WUZH1" status="D"><task number="DEVK904709" owner="ZJT_WUZH1" status="D"/></request></modifiable>${grouped ? '</target>' : ''}</workbench><customizing/></root>`;
      const namespaced = prefix ? xml.replace(/<(\/?)(\w+)/g, `<$1${prefix}$2`).replace('xmlns="urn:test"', `xmlns:${prefix.slice(0, -1)}="urn:test"`) : xml;
      const result = parseTransportList(namespaced);
      assert.equal(result.workbench[0].modifiable[0]['tm:number'], 'DEVK904708');
      assert.equal(result.workbench[0].modifiable[0].tasks[0]['tm:number'], 'DEVK904709');
      assert.deepEqual(result.customizing, []);
    });
  }
}
test('unrecognized transport XML must not appear as an empty list', () => {
  for (const xml of ['', '<html/>', '<root><unexpected/></root>']) assert.throws(() => parseTransportList(xml));
  assert.deepEqual(parseTransportList('<root><workbench/><customizing/></root>'), { workbench: [], customizing: [] });
});
test('transport details preserve classification and task ownership', () => {
  const request = parseTransportDetails('<root><request number="DEVK904708" type="K" status="D" owner="TEST"><task number="DEVK904709" owner="OTHER"/></request></root>');
  assert.equal((request as any)['tm:type'], 'K');
  assert.equal(request?.tasks[0]['tm:owner'], 'OTHER');
});
test('unknown transport schema diagnostics expose element names only', () => {
  assert.throws(() => parseTransportList('<root token="secret"><tree><node owner="private">hidden</node></tree></root>'), (error: any) => {
    assert.deepEqual(error.details, { response_element_paths: ['tree', 'tree/node'] });
    assert.doesNotMatch(JSON.stringify(error.details), /secret|private|hidden|token|owner/);
    return true;
  });
});
test('empty legacy transport root uses a matching saved configuration read-only', async () => {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:12345', client: '001', language: 'EN', username: 'TEST' }), 'fake');
  const uri = '/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/test';
  const calls: any[] = [];
  let configs = [{ link: uri }];
  (backend as any).reader = {
    transportConfigurations: async () => configs,
    getTransportConfiguration: async (path: string) => {
      assert.equal(path, uri);
      return { User: 'TEST', WorkbenchRequests: true, Modifiable: true };
    },
    httpClient: { request: async (path: string, options: any) => {
      calls.push(options);
      assert.equal(path, '/sap/bc/adt/cts/transportrequests');
      assert.equal(options.method, undefined);
      assert.equal(options.headers.Accept, 'application/vnd.sap.adt.transportorganizertree.v1+xml');
      return { body: options.qs.configUri
        ? '<root><workbench><modifiable><request number="DEVK904708"><task number="DEVK904709"/></request></modifiable></workbench></root>'
        : '<root marker="empty"/>' };
    } }
  };
  const result = await backend.transports();
  assert.equal(result.workbench[0].modifiable[0]['tm:number'], 'DEVK904708');
  assert.equal(calls[1].qs.configUri, uri);
  configs = [];
  await assert.rejects(backend.transports(), (error: any) => error.code === 'TRANSPORT_QUERY_CONFIG_REQUIRED');
});
test('source save resolves an explicitly selected user task to its parent correction request', async () => {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:12345', client: '001', language: 'EN', username: 'TEST' }), 'fake');
  const source = '/sap/bc/adt/programs/programs/ztest/source/main';
  const calls: any[] = [];
  let owner = 'TEST'; let status = 'D';
  backend.transports = async () => ({ workbench: [{ 'tm:name': '', 'tm:desc': '', released: [], modifiable: [
    { 'tm:number': 'DEVK904714', tasks: [{ 'tm:number': 'DEVK904715', 'tm:owner': owner, 'tm:status': status }] } as any
  ] }], customizing: [] });
  (backend as any).client = { setObjectSource: async (...args: any[]) => { calls.push(args); } };
  await backend.save(source, 'REPORT ztest.', 'handle', 'DEVK904715');
  assert.deepEqual(calls[0], [source, 'REPORT ztest.', 'handle', 'DEVK904714']);
  for (const invalid of ['DEVK904714', 'DEVK999999']) {
    await assert.rejects(backend.save(source, 'REPORT ztest.', 'handle', invalid), (error: any) => error.code === 'TRANSPORT_TASK_INVALID');
  }
  owner = 'OTHER';
  await assert.rejects(backend.save(source, 'REPORT ztest.', 'handle', 'DEVK904715'));
  owner = 'TEST'; status = 'R';
  await assert.rejects(backend.save(source, 'REPORT ztest.', 'handle', 'DEVK904715'));
  assert.equal(calls.length, 1);
  await backend.save(source, 'REPORT ztest.', 'handle');
  assert.equal(calls[1][3], undefined);
});
