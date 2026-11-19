'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { declarationDocs, docsMarkdown } = require('../server/src/docs');

test('reads Doxygen comments, directions, continuation, annotations and return text', () => {
  const source = [
    '/** @brief Write bits.',
    ' * @param[in, out] dst Destination.',
    ' *                Updated in place.',
    ' * @return Written count.',
    ' */',
    '@name("write)") @description(',
    '    "Available on device")',
    'bit<8> write_bits(inout bit<8> dst);'
  ].join('\r\n');
  const docs = declarationDocs(source, source.indexOf('write_bits'));
  assert.equal(docs.summary, 'Write bits.\n\nAvailable on device');
  assert.equal(docs.params.dst, 'Destination.\nUpdated in place.');
  assert.equal(docs.returns, 'Written count.');
});

test('reads P4_14 action comments, P4 SDK block comments and simple annotations', () => {
  const source = [
    '/// Select a path.', '//! @param port Egress port.',
    'action send(port) {}', '/* Source SDK comment */', 'header_type H {}',
    '@brief("Fast") @description("No metadata")', 'table fib {}'
  ].join('\n');
  assert.equal(declarationDocs(source, source.indexOf('action')).params.port, 'Egress port.');
  assert.equal(declarationDocs(source, source.indexOf('header_type')).summary, 'Source SDK comment');
  assert.equal(declarationDocs(source, source.indexOf('fib')).summary, 'Fast\n\nNo metadata');
});

test('documents do not cross blank lines, inline trailing comments, declarations, strings or directives', () => {
  const source = [
    '// Detached', '', 'action first() {} // trailing',
    'action second() {}', '/** A field. */', 'bit<8> field;',
    'bit<8> next;', '#define FAKE "/// fake"', 'action third() {}'
  ].join('\n');
  for (const name of ['first', 'second', 'next', 'third']) assert.equal(declarationDocs(source, source.indexOf(name)).summary, '');
  assert.equal(declarationDocs(source, source.indexOf('field;')).summary, 'A field.');
});

test('hover renders comment text literally and cache follows unsaved source edits', () => {
  for (const note of ['[run](command:run)', '<img src=example>', 'Second note']) {
    const source = '/// ' + note + '\nconst bit<8> version=1;';
    const docs = declarationDocs(source, source.indexOf('version'));
    assert.equal(docs.summary, note);
    const markdown = docsMarkdown(docs);
    assert.doesNotMatch(markdown, /(?<!\\)\[run\]|(?<!\\)<img/);
  }
});
