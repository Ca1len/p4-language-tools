'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {liveDiagnostics} = require('../src/liveDiagnostics');
const run = (text, options) => liveDiagnostics({text}, options);

test('reports UTF-16 delimiter ranges on dirty buffers without a compiler', () => {
  const source = 'control C() {\r\n  apply { /*😀*/ call(] ); }\r\n}';
  const [d] = run(source);
  assert.equal(d.code, 'unexpected-delimiter');
  assert.deepEqual(d.range.start, {line:1, character:source.split('\n')[1].indexOf(']')});
  const [open] = run('parser P() { state start {}');
  assert.deepEqual(open.range, {start:{line:0,character:11},end:{line:0,character:12}});
  assert.deepEqual(run('parser P() { state start {} }'), []);
});

test('preserves legal multiline P4 strings, comments and escaped macro lines', () => {
  const source = [
    '#define BODY(name) { \\',
    '  (((x]',
    '@description("one [', '#include <bogus.p4>', 'two \\" three")',
    '// stray } \\', '#include "also-bogus.p4"',
    '/*', '#include <also-bogus.p4>', '*/',
    'control C() { apply {} }'
  ].join('\r\n');
  assert.deepEqual(run(source, {resolveInclude:()=>false,includePathsConfigured:true}), []);
  assert.equal(run('action f() { /* incomplete')[0].code, 'unclosed-comment');
  assert.equal(run('@description("a\nb')[0].code, 'unclosed-string');
});

test('literal includes report ranges using project search rules and cpp activity', () => {
  const text = '#include "ok.p4"\n#include <core.p4>\n#include "bad.p4"\n#include MACRO\n#include "maybe.p4"';
  const opts = {resolveInclude: d => d.name === 'ok.p4', uncertainRanges: [{start:text.indexOf('#include "maybe'), end:text.length}]};
  const implicit = run(text, opts);
  assert.equal(implicit.length, 1);
  assert.deepEqual(implicit[0].range, {start:{line:2,character:9},end:{line:2,character:17}});
  assert.deepEqual(run(text,{...opts,includePathsConfigured:true}).map(d => d.range.start.line),[1,2]);
  assert.deepEqual(run('{\n(\n}\n', {uncertainRanges:[{start:2,end:4}]}), []);
});
