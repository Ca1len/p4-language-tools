'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { syntaxDiagnostics } = require('../src/antlrCheck');

test('upstream P4_16 ANTLR grammar accepts named types, rejects an unbalanced declaration', () => {
  const source = '#include <core.p4>\nheader H { bit<8> f; }\ncontrol C(inout H h) { apply { h.f = 0; } }';
  assert.deepEqual(syntaxDiagnostics(source), []);
  const invalid = source.replace('f; }','f }');
  const [problem] = syntaxDiagnostics(invalid);
  assert.equal(problem.source, 'P4 ANTLR');
  assert.match(problem.message, /missing ';'/);
  assert.deepEqual(problem.range.start, {line:1,character:20});
});

test('positions use UTF-16 for unicode comments and survive CRLF includes', () => {
  const line = '/* 🛰 */ header H { bit<8> field }';
  const [problem] = syntaxDiagnostics('# include "sdk.p4" // ok\r\n'+line+'\r\n');
  assert.deepEqual(problem.range, {start:{line:1,character:line.indexOf('}')},end:{line:1,character:line.indexOf('}')+1}});
});

test('unsupported CPP branches skip local syntax diagnostics; multiline comments do not', () => {
  assert.deepEqual(syntaxDiagnostics('#if UNKNOWN\nheader BAD {....\n#endif'), []);
  assert.ok(syntaxDiagnostics('/*\n#if UNKNOWN\n*/\nheader H { bit<8> x }').length);
});
