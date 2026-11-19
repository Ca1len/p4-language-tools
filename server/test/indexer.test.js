'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {indexDocument, findTokenAt, resolve, positionAt} = require('../src/indexer');

test('indexes declarations and ignores comments, strings and directives', () => {
  const text = '#include <core.p4>\nheader ethernet_t { bit<48> dst; }\n// action ghost() {}\ncontrol C(inout ethernet_t h) { action forward() { h.dst = 0; } apply { forward(); } }\n';
  const idx = indexDocument(text, 'file:///sample.p4');
  assert.deepEqual(idx.declarations.map(d => d.name), ['ethernet_t', 'C', 'h', 'forward', 'dst']);
  const call = text.lastIndexOf('forward');
  const tok = findTokenAt(idx, positionAt(text, call));
  assert.equal(resolve(idx, tok).name, 'forward');
  const h = text.indexOf('h.dst');
  assert.equal(resolve(idx, findTokenAt(idx, positionAt(text, h))).name, 'h');
  assert.equal(resolve(idx, findTokenAt(idx, positionAt(text, h + 2))), undefined);
});

test('scopes shadowed names and tolerates malformed buffers', () => {
  const text = 'action a() { bit<8> x; { bit<8> x; x = 1; } x = 2; }';
  const idx = indexDocument(text);
  const inner = findTokenAt(idx, positionAt(text, text.indexOf('x = 1')));
  const outer = findTokenAt(idx, positionAt(text, text.indexOf('x = 2')));
  assert.notEqual(resolve(idx, inner), resolve(idx, outer));
  assert.doesNotThrow(() => indexDocument('parser P( { /* unfinished'));
});

test('understands basic P4-14 declaration forms', () => {
  const idx = indexDocument('header_type ethernet_t { fields { dst : 48; } }\nheader ethernet_t ethernet;\nparser start { return ingress; }\ncontrol ingress { apply(t); }\ntable t { actions { drop; } }');
  for (const name of ['ethernet_t', 'dst', 'ethernet', 'start', 'ingress', 't']) assert.ok(idx.declarations.some(d => d.name === name), name);
});

test('UTF-16 offsets match editor positions', () => {
  const text = '// 😀\naction f() {}';
  const idx = indexDocument(text);
  assert.equal(findTokenAt(idx, {line:1, character:7}).text, 'f');
});

test('uses UTF-16 positions for CRLF files', () => {
  const text = '// 😀\r\naction doit() {\r\n  bit<8> x;\r\n}\r\n';
  const idx = indexDocument(text);
  const declaration = idx.declarations.find(d => d.name === 'x');
  assert.deepEqual(declaration.token.range, {start: {line: 2, character: 9}, end: {line: 2, character: 10}});
  assert.equal(findTokenAt(idx, {line: 2, character: 9}), declaration.token);
  assert.deepEqual(positionAt(text, text.indexOf('action')), {line: 1, character: 0});
});
