'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { indexDocument } = require('../src/indexer');
const { enumMember, enumCompletions } = require('../src/enum');

function file(text, uri = 'file:///main.p4') { return {uri, text, index:indexDocument(text, uri)}; }

test('serializable enum lookup, explicit source value and declaration identity across includes', () => {
  const api = file('enum bit<16> Code { @name("red") RED = 16w0x0001, BLUE = (MASK + 2), }','file:///sdk.p4');
  const main = file('void f() { Code test = Code.BLUE; }');
  const type = api.index.declarations.find(decl => decl.name === 'Code');
  assert.equal(type.kind, 10);
  const candidates = enumCompletions(main, main.text.indexOf('Code.BLUE') + 5, [api]);
  assert.deepEqual(candidates.map(x => x.label), ['Code.RED = 16w0x0001', 'Code.BLUE = (MASK + 2)']);
  const site = main.index.tokens.find(t => t.text === 'BLUE');
  const target = enumMember(main, site, [api]);
  assert.equal(target.declaration, enumMember(api, type.enumMembers[1].token).declaration);
  assert.equal(target.doc, api);
});

test('untyped enum members have no inferred numbers; ambiguity and receiver shadowing suppress hits', () => {
  const api = file('enum Mode { Idle, Busy }', 'file:///mode.p4');
  assert.deepEqual(api.index.declarations.filter(d => d.kind === 22).map(m => m.display), ['Mode.Idle', 'Mode.Busy']);
  const main = file('void f() { Mode.Busy; }');
  const site = main.index.tokens.find(t => t.text === 'Busy');
  assert.equal(enumMember(main, site, [api]).label, 'Mode.Busy');
  assert.equal(enumMember(main, site, [api, file('enum Mode { Unknown }', 'file:///other.p4')]), undefined);
  const shadow = file('void g(bit<8> Mode) { Mode.Busy; }');
  assert.equal(enumMember(shadow, shadow.index.tokens.find(t => t.text === 'Busy'), [api]), undefined);
});
