'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {indexDocument} = require('../src/indexer');
const {inlayHints} = require('../src/inlay');
const mk = (text, name='main.p4') => ({uri:name, text,index:indexDocument(text,name)});
const labels = hints => hints.map(h=>h.label);

test('inlays honor nested calls, comments, quoted arguments, request range and UTF-16 columns', () => {
  const api = mk('extern bit<8> one(in bit<8> digit);\nextern void two(in bit<8> width, in string title);');
  const main = mk('control C() { apply {\r\n  two(one(0), /*🙂*/ "str,inside");\r\n} }');
  const out = inlayHints(main,null,[api]);
  assert.deepEqual(labels(out),['width:','digit:','title:']);
  assert.deepEqual(out.map(h=>h.position),['one','0','"str'].map(s=>({line:1,character:main.text.split('\n')[1].indexOf(s)})));
  assert.deepEqual(labels(inlayHints(main,{start:{line:1,character:15},end:{line:2,character:0}},[api])),['title:']);
});

test('suppress named and obvious arguments, ambiguous overloads, annotations and declaration sites', () => {
  const doc = mk('extern void go(in bool valid);\nextern void a(in bool flag);\nextern void a(in bit<1> mask);\n' +
    'control C(in bool valid) { apply { go(valid); go(valid = false); a(0); @go(1) go(false); } }');
  assert.deepEqual(labels(inlayHints(doc,null)),['valid:']);
});

test('P4_14 primitive and untyped action parameter hints work for real uses', () => {
  const doc = mk('action tag(val) { modify_field(meta.x, val); }\naction run() { tag(3); }','legacy.p4_14');
  assert.deepEqual(labels(inlayHints(doc,null)),['dest:','value:','val:']);
});

test('extern method hints use receiver type and suppress an obvious field argument', () => {
  const api=mk('extern Device { void send(in bit<8> port, in bit<8> qos); }');
  const main=mk('control C(Device dev) { apply { dev.send(meta.port, 8w3); } }');
  assert.deepEqual(labels(inlayHints(main,null,[api])), ['qos:']);
});
