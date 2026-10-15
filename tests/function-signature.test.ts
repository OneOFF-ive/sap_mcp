import test from 'node:test';
import assert from 'node:assert/strict';
import { functionDefinition } from '../src/function-signature.js';
import { compareSavedSource, sameSavedSource, savedSourceHash } from '../src/adt.js';

const uri = '/sap/bc/adt/functions/groups/zgroup/fmodules/zmodule';
const body = '\n  WRITE iv_text.\nENDFUNCTION.';
const header = "FUNCTION zmodule\n IMPORTING VALUE(iv_text) TYPE string DEFAULT 'a.  b'\n EXPORTING ev_length TYPE i\n CHANGING cv TYPE REF TO object\n TABLES t_return TYPE bapiret2 OPTIONAL\n EXCEPTIONS invalid_input.";
const original = header + body;
const formatted = header.replace('FUNCTION zmodule', 'function ZMODULE').replace('VALUE(iv_text)', 'value ( IV_TEXT )')
  .replace('TYPE string', 'type   STRING').replace('ev_length TYPE i', 'EV_LENGTH\n TYPE I') + body;

test('supported function definitions accept token-preserving formatting and share activation hashes', () => {
  assert.ok(functionDefinition(original));
  assert.deepEqual(compareSavedSource(original, formatted, uri), { equivalent: true, normalization_applied: true, warnings: [] });
  assert.equal(savedSourceHash(original, uri), savedSourceHash(formatted, uri));
  assert.equal(sameSavedSource(original, formatted), false);
  assert.equal(sameSavedSource(original, formatted, '/sap/bc/adt/functions/groups/zgroup/includes/lzgrouptop'), false);
});

test('parameter semantics, literal data, implementation and order must remain unchanged', () => {
  for (const [from, to] of [['TYPE string', 'TYPE i'], ['OPTIONAL', ''], ['VALUE(iv_text)', 'REFERENCE(iv_text)'],
    ['ev_length', 'ev_other'], ['EXPORTING', 'CHANGING'], ['invalid_input', 'other_error'],
    ["'a.  b'", "'a. b'"], ["'a.  b'", "'A.  b'"], ['WRITE iv_text.', 'WRITE 1.'],
    ['  WRITE', ' WRITE'], ['cv TYPE REF TO object', 'cv TYPE object']]) {
    assert.equal(sameSavedSource(original, formatted.replace(from, to) === formatted ? original.replace(from, to) : formatted.replace(from, to), uri), false, from);
    assert.notEqual(savedSourceHash(original, uri), savedSourceHash(original.replace(from, to), uri), from);
  }
  const implementation = 'FUNCTION zmodule.\n WRITE |a  b|.\nENDFUNCTION.';
  assert.equal(sameSavedSource(implementation, implementation.replace('a  b', 'a b'), uri), false);
});

test('definition comments may change only with an explicit warning; body comments remain significant', () => {
  const comment = 'FUNCTION zmodule\n " interface comment.\n IMPORTING iv TYPE i.' + body;
  const normalized = comment.replace(' " interface comment.\n', '');
  assert.deepEqual(compareSavedSource(comment, normalized, uri), { equivalent: true, normalization_applied: true, warnings: ['FUNCTION_DEFINITION_COMMENTS_CHANGED'] });
  assert.equal(sameSavedSource(comment, normalized + '\n* removed body comment', uri), false);
  assert.equal(compareSavedSource(original, formatted.replace('WRITE iv_text.', 'WRITE 1.'), uri).difference, 'implementation');
});

test('unsupported, malformed or ambiguous definitions fall back to existing strict verification', () => {
  for (const definition of ['FUNCTION zmodule IMPORTING iv TYPE i ##UNKNOWN.',
    'FUNCTION zmodule TABLES t STRUCTURE bapiret2.', 'FUNCTION zmodule EXCEPTIONS bad = 1.',
    'FUNCTION zmodule IMPORTING iv TYPE SORTED TABLE OF i WITH UNIQUE KEY table_line.',
    'FUNCTION zmodule IMPORTING iv TYPE i iv TYPE i.', 'FUNCTION zmodule IMPORTING.',
    'FUNCTION zmodule IMPORTING iv TYPE string DEFAULT |dynamic|.',
    "FUNCTION zmodule IMPORTING iv TYPE string DEFAULT 'unclosed.",
    'FUNCTION zmodule IMPORTING iv TYPE i', 'FUNCTION zmodule CHANGING cv TYPE i IMPORTING iv TYPE i.']) {
    assert.equal(functionDefinition(definition), undefined, definition);
    assert.equal(sameSavedSource(definition, definition, uri), true);
    assert.equal(compareSavedSource(definition, definition.replace('FUNCTION', 'function'), uri).difference, 'unsupported_definition');
  }
});

test('quoted defaults retain escaped quotes, periods, spaces and case', () => {
  for (const literal of ["'a''b. c'", '`A``B. C`', '-42', 'abap_true']) {
    const a = `FUNCTION zmodule IMPORTING iv TYPE string DEFAULT ${literal}.` + body;
    const b = a.replace('IMPORTING iv', 'importing   IV');
    assert.equal(sameSavedSource(a, b, uri), true);
  }
});
