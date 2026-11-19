'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { indexDocument } = require('../src/indexer');
const { applyTypoFix } = require('../src/compilerFix');

test('only fix a single compiler-confirmed apply typo at the current saved token', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-fix-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const filename = path.join(dir, 'switch.p4');
  const uri = pathToFileURL(filename).href;
  const text = '    example_table_key.aply();';
  const p = character => ({line: 0, character});
  const range = {start: p(22), end: p(26)};
  const cursor = {start: p(24), end: p(24)};
  const diagnostic = {uri, severity: 1, message: 'syntax error, unexpected IDENTIFIER, expecting APPLY', range};
  const action = (selection, diagnostics, buffer = text) => applyTypoFix(
    {uri, text: buffer, index: indexDocument(buffer, uri)}, selection, [{diagnostics}], filename);
  fs.writeFileSync(filename, text);
  assert.deepEqual(action(range, [diagnostic]).edit.changes[uri], [{range, newText: 'apply'}]);
  assert.deepEqual(action(cursor, [diagnostic]).edit.changes[uri], [{range, newText: 'apply'}]);
  assert.equal(action(cursor, []), undefined);
  assert.equal(action(cursor, [{...diagnostic, uri: pathToFileURL(path.join(dir, 'elsewhere.p4')).href}]), undefined);
  assert.equal(action(cursor, [{...diagnostic, message: diagnostic.message + ' or IDENTIFIER'}]), undefined);
  assert.equal(action(cursor, [{...diagnostic, severity: 2}]), undefined);
  assert.equal(action(cursor, [{...diagnostic, range: {start: p(21), end: p(25)}}]), undefined);
  assert.equal(action({start: p(23), end: p(27)}, [diagnostic]), undefined);
  assert.equal(action({start: p(28), end: p(28)}, [diagnostic]), undefined);
  assert.equal(action(cursor, [diagnostic], text + ' // unsaved'), undefined);
  for (const changed of [text.replace('aply', 'aplyX'), text.replace('.', ' '), '//' + text.slice(2)]) {
    fs.writeFileSync(filename, changed);
    assert.equal(action(cursor, [diagnostic], changed), undefined);
  }
});
