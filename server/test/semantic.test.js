'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { indexDocument } = require('../src/indexer');
const { legend, semanticTokens } = require('../src/semantic');

function source(text, filename = 'main.p4') {
  const uri = 'file:///project/' + filename;
  return {uri, text, index:indexDocument(text,uri)};
}
function decoded(doc, helpers) {
  const {data} = semanticTokens(doc,helpers);
  assert.equal(data.length % 5, 0);
  const lines = doc.text.split('\n');
  const result = [];
  let line = 0, character = 0;
  for (let i = 0; i < data.length; i += 5) {
    const [delta, column, length, type, modifiers] = data.slice(i,i+5);
    assert.ok(delta >= 0 && column >= 0 && length > 0, 'unsigned token encoding');
    assert.ok(type >= 0 && type < legend.tokenTypes.length);
    line += delta;
    character = delta ? column : character + column;
    const previous = result.at(-1);
    if (previous?.line === line) assert.ok(character >= previous.end, 'disjoint tokens');
    result.push({line, start:character, end:character+length,
      name:lines[line].slice(character,character+length), role:legend.tokenTypes[type],
      modifiers: legend.tokenModifiers.filter((_,bit)=>modifiers & (1 << bit)) });
  }
  return result;
}

test('P4_16 semantic colors follow the binding across includes, shadowing and nested members', () => {
  const header = source('header Eth { bit<8> kind; }\nstruct Headers { Eth eth; }','wire.p4');
  const doc = source('#include "wire.p4"\r\ncontrol Switch(inout Headers h) {\r\n' +
    ' action hit(bit<8> value) { /*🙂*/ h.eth.kind = value; }\r\n' +
    ' table routes { actions = { hit; } }\r\n apply { routes.apply(); h.eth.setValid(); hit(1); }\r\n}\r\n' +
    'control Other() { bit<8> hit; apply { hit = 2; } }');
  const out = decoded(doc,{dependencies:[header],language:'p4-16'});
  const byName = name => out.filter(t=>t.name===name);
  assert.deepEqual(byName('hit').map(t=>t.role), ['function','function','function','variable','variable']);
  assert.deepEqual(byName('Headers').map(t=>t.role), ['struct']);
  assert.deepEqual(byName('value').map(t=>[t.role,t.modifiers]), [['parameter',['declaration']], ['parameter',[]]]);
  assert.deepEqual(byName('kind').map(t=>[t.role,t.start]), [['property',doc.text.split('\n')[2].indexOf('kind')]]);
  assert.deepEqual(byName('routes').map(t=>t.role), ['p4Table','p4Table']);
  assert.ok(byName('setValid').some(t=>t.role==='method'&& t.modifiers.includes('defaultLibrary')));
  assert.ok(!out.some(t=>t.name==='wire'), 'include path left to grammar');
});
test('P4_14 state names, untyped action parameters, primitive calls and fields have meaningful colors', () => {
  const doc = source('header_type H { fields { word : 16; } }\nheader H foo;\nparser start { extract(foo); return next; }\nparser next { return ingress; }\naction set(v) { modify_field(foo.word, v); }','legacy.p4_14');
  const out = decoded(doc,{language:'p4-14'});
  const roles = n => out.filter(t=>t.name===n).map(t=>t.role);
  assert.deepEqual(roles('H'),['struct','struct']);
  assert.deepEqual(roles('word'),['property','property']);
  assert.deepEqual(roles('next'),['p4ParserState','p4ParserState']);
  assert.deepEqual(roles('v'),['parameter','parameter']);
  assert.deepEqual(roles('modify_field'),['function']);
});
test('Deltas retain new buffer positions, macro scope, annotations, enums and readonly references', () => {
  const doc = source('/* #define GHOST 0 */\n#define PORT 7\n@brief("PORT ghost")\nconst bit<8> DEFAULT = PORT;\nenum Mode { A, B }\naction run() { Mode m = Mode.B; bit<8> n = DEFAULT; }\n#undef PORT\naction x() { PORT(); }');
  const out = decoded(doc,{isInactiveLine: line=>line===7});
  const byName = name => out.filter(t=>t.name===name);
  assert.deepEqual(byName('PORT').map(t=>[t.line,t.role]), [[1,'macro'],[3,'macro']]);
  assert.deepEqual(byName('B').map(t=>t.role), ['enumMember','enumMember']);
  assert.deepEqual(byName('DEFAULT').map(t=>t.modifiers),[['declaration','readonly'],['readonly']]);
  assert.deepEqual(byName('brief').map(t=>t.role), ['decorator']);
  assert.equal(byName('GHOST').length, 0);
  assert.ok(out.every(t=>t.line!==7));
});
