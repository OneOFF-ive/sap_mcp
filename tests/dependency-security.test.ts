import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatableTypes } from 'abap-adt-api';
import { objectPath } from 'abap-adt-api/build/api/objectcreator.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const adtRequire = createRequire(require.resolve('abap-adt-api'));
const { sprintf } = adtRequire('sprintf-js') as { sprintf: (format: string, ...args: unknown[]) => string };

test('ADT creation formats are fixed paths with only string placeholders', () => {
  for (const [type, descriptor] of CreatableTypes) {
    assert.match(descriptor.creationPath, /^[a-zA-Z0-9_/%]+$/);
    assert.equal(descriptor.creationPath.replace(/%s/g, '').includes('%'), false, type);
    assert.ok((descriptor.creationPath.match(/%s/g) ?? []).length <= 1, type);
    assert.equal(sprintf(descriptor.creationPath, 'parent'), descriptor.creationPath.replace('%s', 'parent'));
  }
});

test('ADT formatter rejects precision and padding directives without invoking numeric formatting', t => {
  const fixed = t.mock.method(Number.prototype, 'toFixed', () => { throw new Error('numeric formatting must never run'); });
  for (const format of ['%.999999999f', '%.101e', '%.0g', '%999999999s', '%(name)s', '%', '%d']) {
    assert.throws(() => sprintf(format, 1), { name: 'TypeError', message: 'Unsupported ADT path format' });
  }
  assert.equal(fixed.mock.callCount(), 0);
  assert.equal(sprintf('/objects/%s', '%.999999999f'), '/objects/%.999999999f');
  assert.equal(sprintf('%%/%s', 'parent'), '%/parent');
  assert.throws(() => sprintf('%s', 'x'.repeat(16385)), /Invalid ADT path argument/);
  assert.throws(() => sprintf('%s', { toString: () => { throw new Error('must not coerce objects'); } }), /Invalid ADT path argument/);
});

test('ADT object names are data, never sprintf format strings', () => {
  const untrusted = '%.999999999f';
  assert.equal(objectPath('FUGR/FF', untrusted, untrusted),
    `/sap/bc/adt/functions/groups/${encodeURIComponent(untrusted)}/fmodules/${encodeURIComponent(untrusted)}`);
});
