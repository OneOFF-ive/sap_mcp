import test from 'node:test';
import assert from 'node:assert/strict';
import { CreatableTypes } from 'abap-adt-api';
import { objectPath } from 'abap-adt-api/build/api/objectcreator.js';

test('ADT creation formats are fixed paths with only string placeholders', () => {
  for (const [type, descriptor] of CreatableTypes) {
    assert.match(descriptor.creationPath, /^[a-zA-Z0-9_/%]+$/);
    assert.equal(descriptor.creationPath.replace(/%s/g, '').includes('%'), false, type);
    assert.ok((descriptor.creationPath.match(/%s/g) ?? []).length <= 1, type);
  }
});

test('ADT object names are data, never sprintf format strings', () => {
  const untrusted = '%.999999999f';
  assert.equal(objectPath('FUGR/FF', untrusted, untrusted),
    `/sap/bc/adt/functions/groups/${encodeURIComponent(untrusted)}/fmodules/${encodeURIComponent(untrusted)}`);
});
