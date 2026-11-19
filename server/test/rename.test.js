'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { indexDocument, positionAt } = require('../src/indexer');
const { prepareRename, rename } = require('../src/rename');

function fixture(source) {
  const uri = 'file:///main.p4';
  const doc = { uri, text: source, version: 7, index: indexDocument(source, uri) };
  return {doc, at: value => positionAt(source, source.indexOf(value) + 1)};
}

test('local scalar rename changes only bound tokens and guards the document version', () => {
  const {doc, at} = fixture('action act(bit<8> n) {\n bit<8> old = n; // old\n old = old + n;\n}\naction next() { bit<8> old; }');
  assert.equal(prepareRename(doc, at('old = old')).placeholder, 'old');
  const [change] = rename(doc, at('old = old'), 'sum').documentChanges;
  assert.deepEqual(change.textDocument, {uri:doc.uri, version:7});
  assert.deepEqual(change.edits.map(e=>e.range.start.line), [1,2,2]);
  assert.throws(() => rename(doc, at('old = old'), 'n'), /already occurs/);
  assert.throws(() => rename(doc, at('old = old'), 'exit'), /identifier/);
  assert.equal(prepareRename(doc, at('n)')), null);
});
test('refuses macros, in-body directives, nested blocks, calls and incomplete declarations', () => {
  for (const body of ['bit<8> old; use(old);', 'bit<8> old; if (true) { old = 2; }', 'bit<8> old;\n#if X\nold = 1;\n#endif']) {
    const {doc, at} = fixture('action a() { ' + body + '\n}');
    assert.equal(prepareRename(doc, at('old')), null);
  }
  const {doc, at} = fixture('action a() { bit<8> old = N; }');
  assert.equal(prepareRename(doc, at('old'), [{text:'#define N old'}]), null);
  assert.equal(prepareRename(doc, at('old'), [], ['-DN=old']), null);
  const incomplete = fixture('action a() { bit<8> old;');
  assert.equal(prepareRename(incomplete.doc, incomplete.at('old')), null);
});
