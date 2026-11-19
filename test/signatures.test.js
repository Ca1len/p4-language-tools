'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const { indexDocument, positionAt } = require('../server/src/indexer');
const { signatureHelp, callableTargets } = require('../server/src/signatures');
function document(text, uri = 'file:///test.p4') { return { text, uri, index: indexDocument(text, uri) }; }
function help(text, includes = [], language = 'auto') {
  const offset = text.indexOf('|');
  assert.notEqual(offset, -1);
  const doc = document(text.replace('|',''));
  return signatureHelp(doc, positionAt(doc.text, offset), includes.map(t => document(t, 'file:///inc.p4')), language);
}
test('action signatures show source docs and parameter docs across includes; nested commas are ignored', () => {
  const declaration = `/** Mark traffic.
 * @param mask Bits to mark.
 */
action mark(in bit<8> value, in bit<8> mask) { }`;
  const r = help('control C() { apply { mark(f<bit<8>, bit<16>>(1, 2), |); } }', [declaration]);
  assert.equal(r.activeParameter, 1);
  assert.match(r.signatures[0].label, /action mark\(in bit<8>/);
  assert.match(r.signatures[0].documentation.value, /Mark traffic/);
  assert.match(r.signatures[0].parameters[1].documentation.value, /Bits to mark/);
});
test('scope shadows distinct actions, named arguments select their actual parameter', () => {
  const r = help('action f(bit<8> x) {} control C() { action f(bit<16> value, bit<8> mask) {} apply { f(mask = |); } }');
  assert.equal(r.activeParameter, 1);
  assert.equal(r.signatures.length, 1);
  assert.match(r.signatures[0].label, /bit<16> value/);
});
test('P4_14 actions, primitive declarations and standard modify_field', () => {
  assert.equal(help('action add_tag(tag) {} action f() { add_tag(|); }').signatures[0].parameters[0].label, 'tag');
  assert.match(help('action f() { custom(|); }', ['primitive_action custom(field);']).signatures[0].label, /custom\(field\)/);
  const builtin = help('action f() { modify_field(h.x, 3, |); }', [], 'p4-14');
  assert.equal(builtin.signatures[builtin.activeSignature].parameters[builtin.activeParameter].label, 'mask');
  assert.equal(help('action f() { modify_field(h.x, 3, |); }', [], 'p4-16'), null);
});
test('receiver type filters overloaded extern methods; generic return extern functions work', () => {
  const inc = 'extern A<T> { A(); void read(out T v); void read(out T v, in bit<8> index); } extern B { void read(bool wrong); } extern bit<8> choose<T>(in T item);';
  const r = help('control C() { A<bit<8>>() a; apply { a.read(v, |); } }', [inc]);
  assert.equal(r.signatures.length, 2);
  assert.equal(r.signatures[r.activeSignature].parameters[1].label, 'in bit<8> index');
  assert.match(help('control C() { apply { choose<bit<8>>(|); } }', [inc]).signatures[0].label, /extern bit<8> choose<T>/);
  assert.equal(help('control C() { apply { unknown.read(|); } }', [inc]), null);
});
test('extern supplied via control parameter and control apply/constructor', () => {
  const inc = 'extern A { void send(in bit<8> port); } control Forward(in bit<8> port)(bool enabled) {apply {}}';
  assert.match(help('control C(A output) { apply { output.send(|); } }', [inc]).signatures[0].label, /void send/);
  assert.match(help('control C() { Forward(true) f; apply { f.apply(|); } }', [inc]).signatures[0].label, /^Forward.apply\(in bit<8> port\)/);
  assert.match(help('control C() { Forward(|) f; apply {} }', [inc]).signatures[0].label, /^Forward\(bool enabled\)/);
});
test('callable navigation exposes a source declaration inside unopened dependencies', () => {
  const doc = document('control C() { apply { send(1); } }');
  const dep = document('extern void send(in bit<8> port);', 'file:///api.p4');
  const target = callableTargets(doc, doc.index.tokens.find(t => t.text === 'send'), [dep])[0];
  assert.equal(target.doc.uri, dep.uri);
  assert.equal(target.declaration.token.start, dep.text.indexOf('send'));
});
test('declaration hover metadata selects the exact documented overload', () => {
  const {declarationSignatures} = require('../server/src/signatures');
  const doc = document('extern register<T> {\n /// Single index\n void read(T a);\n /// Double index\n void read(T a, T b);\n}');
  const reads = doc.index.tokens.filter(t => t.text === 'read');
  assert.equal(declarationSignatures(doc, reads[0])[0].docs.summary, 'Single index');
  assert.deepEqual(declarationSignatures(doc, reads[1]).map(s => [s.label, s.docs.summary]), [['void read(T a, T b)', 'Double index']]);
});
test('tuple comparisons with separate operands count as separate arguments', () => {
  const r = help('action f(bool a, bool b, bool c) {} control C() { apply { f(x < y, z > w, |); } }');
  assert.equal(r.activeParameter, 2);
});
test('an unfinished aggregate argument retains its enclosing argument position', () => {
  const r = help('action f(bit<8> x, tuple<bit<8>,bit<8>> fields) {} control C() { apply { f(7, {1, |');
  assert.equal(r.activeParameter, 1);
});
test('typed built-in P4_16 header and table methods provide zero-argument signatures', () => {
  const r = help('header H { bit<8> x; } control C(in H h) { apply { h.isValid(|); } }', [], 'p4-16');
  assert.match(r.signatures[0].label, /isValid\(\)/);
  assert.equal(r.signatures[0].parameters.length, 0);
  const t = help('control C() { table t {actions={}} apply { t.apply(|); } }', [], 'p4-16');
  assert.match(t.signatures[0].label, /apply\(\)/);
});
