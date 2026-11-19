'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {indexDocument, findTokenAt, positionAt} = require('../src/indexer');
const {memberCandidates, memberTarget, memberCompletions} = require('../src/members');

function document(text, uri) { return {uri, text, index:indexDocument(text,uri)}; }

test('P4_16: resolves a field through parameter, alias, stack and included type definitions', () => {
  const types = document('header E { bit<48> dst; bit<48> src; } typedef E Ether; struct H { Ether[2] eth; }','types');
  const main = document('control Ingress(inout H metadata) { apply { metadata.eth[1].dst = 3; } }','main');
  const visible = [main, types];
  const index = main.text.indexOf('.dst')+1;
  const token = findTokenAt(main.index, positionAt(main.text,index));
  assert.equal(memberTarget(main,token,visible).doc,types);
  assert.equal(memberTarget(main,token,visible).declaration.name,'dst');
  assert.deepEqual(memberCompletions(main,index,visible).map(t => t.declaration.name), ['dst','src']);
  assert.deepEqual(memberCompletions(main,index+2,visible).map(t => t.declaration.name), ['dst','src']);
  assert.equal(memberTarget(main,token,[main]),undefined);
  const dupe = document('header E { bit<9> dst; }','other');
  assert.equal(memberTarget(main,token,[...visible,dupe]),undefined);
});

test('P4_14: header_type fields reached through metadata and header instances', () => {
  const lib = document('header_type md_t { fields { port : 9; flags : 2; } }','types');
  for (const kw of ['metadata', 'header']) {
    const main = document(kw+' md_t md; action send(x) { modify_field(md.port, x); }','main');
    const visible = [main,lib];
    const offset = main.text.indexOf('.port')+1;
    assert.deepEqual(memberCompletions(main,offset,visible).map(t => t.declaration.name), ['port','flags']);
    assert.equal(memberTarget(main, findTokenAt(main.index,positionAt(main.text,offset)), visible).declaration.display,'port : 9');
  }
});

test('extern methods respect receiver type, generic instance and overloads', () => {
  const lib = document('extern register<T> { register(bit<32> s); void read(out T v); void read(out T v, bit<8> i); } extern Other { void wrong(); }','externs');
  const main = document('control P() { register<bit<8>>(20) r; apply { r.read(x); } }','main');
  const token = findTokenAt(main.index, positionAt(main.text,main.text.indexOf('.read')+1));
  const matches = memberCandidates(main,token,[main,lib]);
  assert.equal(matches.length,2);
  assert.ok(matches.every(m => m.doc === lib && m.declaration.name==='read' && m.declaration.isMember));
  assert.equal(memberTarget(main,token,[main,lib]),undefined);
});

test('Go to Type Definition points at an explicit alias even for scalar underlying types', () => {
  const { typeTarget } = require('../src/members');
  const defs = document('typedef bit<9> Port;','defs');
  const main = document('control C(in Port value) { apply { } }','main');
  const param = main.index.declarations.find(d => d.name === 'value');
  const match = typeTarget(main, param, [main,defs]);
  assert.equal(match.doc, defs);
  assert.equal(match.declaration.name, 'Port');
  assert.equal(typeTarget(defs, match.declaration, [main,defs]), undefined);
});

test('built-in methods are bound to typed header values, stack elements, and P4_16 tables', () => {
  const {builtinMembers,builtinInfo} = require('../src/members');
  const deps = document('header H { bit<8> f; } struct S { H h; H[2] stack; }','deps');
  const main = document('control C(inout S s) { table t { actions = { } } apply { s.h.isValid(); s.stack[1].setValid(); s.stack.isValid(); s.isValid(); t.apply(); } }','main');
  const visible = [main,deps];
  const list = expr => builtinMembers(main,main.text.indexOf(expr)+expr.lastIndexOf('.')+1,visible).map(x => x.name);
  const token = expr => findTokenAt(main.index,positionAt(main.text,main.text.indexOf(expr)+expr.lastIndexOf('.')+1));
  assert.deepEqual(list('s.h.isValid'), ['isValid','setValid','setInvalid']);
  assert.deepEqual(list('s.stack[1].setValid'), ['isValid','setValid','setInvalid']);
  assert.deepEqual(list('s.stack.isValid'), []);
  assert.deepEqual(list('s.isValid'), []);
  assert.equal(builtinInfo(main,token('t.apply'),visible).label, 'apply()');
  assert.equal(builtinInfo(main,token('t.apply'),visible,'p4-14'), undefined);
  assert.equal(memberTarget(main,token('s.h.isValid'),visible), undefined);
});
