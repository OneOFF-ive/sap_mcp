import test from 'node:test';
import assert from 'node:assert/strict';
import { enhancementTypes, searchEnhancements, probeEnhancementActivation } from '../src/enhancements.js';
import { AdtBackend } from '../src/adt.js';
import { connectionSchema } from '../src/config.js';
import { randomUUID } from 'node:crypto';

test('unified enhancement search queries every family, filters unrelated rows and applies global limit', async () => {
  const calls: string[] = [];
  const result = await searchEnhancements(async (query, type, limit) => {
    assert.equal(query, 'Z*'); assert.equal(limit, 2); calls.push(type);
    return { objects: [{ name: `Z${type}`, type: `${type}/X`, object_uri: `/sap/bc/adt/${type}` },
      { name: 'UNRELATED', type: 'PROG/P', object_uri: '/sap/bc/adt/programs/z' }], truncated: false };
  }, 'Z*', 'all', 2);
  assert.deepEqual(calls, enhancementTypes);
  assert.equal(result.objects.length, 2); assert.equal(result.truncated, true);
  assert.equal(result.coverage.length, 8);
  assert.equal(result.completeness, 'not_guaranteed');
  assert.ok(result.objects.every(row => row.category && row.name !== 'UNRELATED'));
});

test('selected family preserves metadata and backend truncation; empty is not proof of support', async () => {
  const result = await searchEnhancements(async (_, type) => {
    assert.equal(type, 'SMOD');
    return { objects: [{ name: 'EXIT', type: 'SMOD', package_name: 'SAP', description: 'Exit', object_uri: '/sap/bc/adt/exit' }], truncated: true };
  }, '*', 'SMOD', 10);
  assert.equal(result.objects[0].category, 'customer_exit');
  assert.equal(result.objects[0].description, 'Exit'); assert.equal(result.truncated, true);
  const empty = await searchEnhancements(async () => ({ objects: [], truncated: false }), '*', 'CMOD');
  assert.equal(empty.coverage[0].support, 'not_verified');
});

test('invalid filters and backend failures do not return a successful empty inventory', async () => {
  await assert.rejects(searchEnhancements(async () => { throw new Error('unexpected'); }, '*', 'PROG'), /Unknown enhancement type/);
  await assert.rejects(searchEnhancements(async () => { throw new Error('denied'); }, '*'), /denied/);
});

test('active version and simultaneous inactive draft are distinguished from runtime enablement', async () => {
  const both = await probeEnhancementActivation(async version => ({ name: 'ZIMPL', type: 'ENHO/XH', version }), 'ZIMPL', 'ENHO/XH');
  assert.equal(both.status, 'active_with_inactive_version');
  assert.equal(both.runtime_enabled, 'unknown');
  assert.deepEqual(both.probes.map(p => p.available), [true, true]);
  const active = await probeEnhancementActivation(async version => {
    if (version === 'inactive') throw { status: 404 };
    return { name: 'ZIMPL', type: 'ENHO/XH', version };
  }, 'ZIMPL', 'ENHO/XH');
  assert.equal(active.status, 'active');
  assert.equal(active.probes[1].available, 'unknown');
});

test('404, denied metadata, missing version and mismatched identity never imply inactive or active', async () => {
  for (const response of [
    async () => { throw { status: 404 }; },
    async () => { throw { status: 403 }; },
    async () => ({ name: 'ZIMPL', type: 'ENHO/XH', version: '' }),
    async () => ({ name: 'OTHER', type: 'ENHO/XH', version: 'active' }),
    async () => ({ name: 'ZIMPL', type: 'PROG/P', version: 'active' })
  ]) {
    const result = await probeEnhancementActivation(response, 'ZIMPL', 'ENHO/XH');
    assert.equal(result.status, 'unknown');
    assert.ok(result.probes.every(p => p.available === 'unknown'));
  }
});

test('draft alone does not prove deactivation; silent active fallback does not prove an inactive draft', async () => {
  const draft = await probeEnhancementActivation(async version => {
    if (version === 'active') throw { status: 404 };
    return { name: 'ZIMPL', type: 'ENHO/XH', version };
  }, 'ZIMPL', 'ENHO/XH');
  assert.equal(draft.status, 'unknown'); assert.equal(draft.probes[1].available, true);
  const fallback = await probeEnhancementActivation(async () => ({ name: 'ZIMPL', type: 'ENHO/XH', version: 'active' }), 'ZIMPL', 'ENHO/XH');
  assert.equal(fallback.status, 'active'); assert.equal(fallback.probes[1].available, 'unknown');
});

test('enriches returned implementations only; definitions are not applicable and failures preserve search rows', async () => {
  const rows = ['ENHO', 'ENHS', 'SXCI'].map((type, index) => ({ name: `Z${index}`, type, object_uri: `/sap/bc/adt/${type}` }));
  const calls: string[] = [];
  const result = await searchEnhancements(async (_, type) => ({ objects: rows.filter(r => r.type === type), truncated: false }), '*', 'all', 2, async row => {
    calls.push(row.type); throw { status: 403 };
  });
  assert.deepEqual(calls, ['ENHO']);
  assert.equal(result.objects[0].activation.status, 'unknown');
  assert.equal(result.objects[1].activation.status, 'not_applicable');
  assert.equal(result.truncated, true);
});

test('ADT activation adapter reads discovered URI and exact versions through the stateless reader', async () => {
  const backend = new AdtBackend(connectionSchema.parse({ connection_id: randomUUID(), name: 'mock', base_url: 'http://127.0.0.1:12345', client: '001', language: 'EN', username: 'TEST' }), 'fake');
  const calls: string[] = [];
  const object = '/sap/bc/adt/enhancements/enhoxhh/zimpl';
  // Stub the transport boundary: no network or SAP writes occur in this test.
  (backend as unknown as { reader: unknown }).reader = { objectStructure: async (uri: string, version: string) => {
    assert.equal(uri, object); calls.push(version);
    return { metaData: { 'adtcore:name': 'ZIMPL', 'adtcore:type': 'ENHO/XHH', 'adtcore:version': version } };
  } };
  const result = await backend.enhancementActivation(object, 'ZIMPL', 'ENHO/XHH');
  assert.equal(result.status, 'active_with_inactive_version');
  assert.deepEqual(calls, ['active', 'inactive']);
  await assert.rejects(backend.enhancementActivation('https://evil.example/x', 'ZIMPL', 'ENHO/XHH'));
  assert.equal(calls.length, 2);
});
