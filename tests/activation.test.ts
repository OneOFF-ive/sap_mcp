import test from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { groupActivationBody, activationResponse } from '../src/activation.js';
import { AdtBackend } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { randomUUID } from 'node:crypto';

const group = '/sap/bc/adt/functions/groups/zgroup';
const object = (uri = group, overrides = {}) => ({ deleted: false, user: 'TEST',
  'adtcore:uri': uri, 'adtcore:name': 'ZGROUP', 'adtcore:type': 'FUGR/F', 'adtcore:parentUri': '', ...overrides });
const preaudit = () => ({ success: false, messages: [], inactive: [
  { transport: object('/sap/bc/adt/cts/transportrequests/DEVK904718') },
  { object: object() }, { object: object(`${group}/source/main`, { user: '', 'adtcore:parentUri': group }) }
] });
test('group preaudit keeps exact object references and omits transport context and empty attributes', () => {
  const body = groupActivationBody(preaudit(), group, [], 'TEST');
  const refs = new XMLParser({ ignoreAttributes: false }).parse(body)['adtcore:objectReferences']['adtcore:objectReference'];
  assert.equal(refs.length, 2);
  assert.equal(refs[0]['@_adtcore:parentUri'], undefined);
  assert.equal(refs[1]['@_adtcore:parentUri'], group);
  assert.doesNotMatch(body, /DEVK|undefined/);
  for (const invalid of [object('/sap/bc/adt/functions/groups/other'), object(group, { user: 'OTHER' }),
    object(group, { deleted: true }), object(group, { 'adtcore:parentUri': '/other' }), object(group, { 'adtcore:type': 'PROG/P' })]) {
    assert.throws(() => groupActivationBody({ success: false, messages: [], inactive: [{ object: invalid }] }, group, [], 'TEST'));
  }
});
test('activation response does not ignore errors or remaining inactive entries', () => {
  assert.equal(activationResponse('').success, true);
  assert.equal(activationResponse('<chkl:messages xmlns:chkl="test"><msg type="E"><shortText><txt>Failure</txt></shortText></msg></chkl:messages>').success, false);
  assert.equal(activationResponse('<ioc:inactiveObjects xmlns:ioc="test"><ioc:entry/></ioc:inactiveObjects>').success, false);
  assert.throws(() => activationResponse('<html/>'));
});
test('group activation follows preaudit with one scoped second phase, never loops on remaining objects', async () => {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock',
    base_url: 'http://127.0.0.1:12345', client: '001', language: 'EN', username: 'TEST' }), 'fake');
  let body = ''; let posts = 0; let response = '';
  (backend as any).reader = { objectStructure: async () => ({ metaData: { 'adtcore:name': 'ZGROUP' } }) };
  (backend as any).client = { activate: async () => preaudit(), httpClient: { request: async (path: string, options: any) => {
    assert.equal(path, '/sap/bc/adt/activation');
    assert.deepEqual(options.qs, { method: 'activate', preauditRequested: false });
    posts++; body = options.body; return { body: response };
  } } };
  const snapshot = { object_uri: group, revision: 'test', name: 'ZGROUP', members: [] };
  assert.equal((await backend.activate(group, snapshot)).success, true);
  assert.match(body, /source\/main/); assert.equal(posts, 1);
  response = '<ioc:inactiveObjects xmlns:ioc="test"><ioc:entry/></ioc:inactiveObjects>';
  assert.equal((await backend.activate(group, snapshot)).success, false);
  assert.equal(posts, 2);
});
