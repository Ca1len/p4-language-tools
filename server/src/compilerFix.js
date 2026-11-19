'use strict';

const fs = require('node:fs');
const { findTokenAt } = require('./indexer');

// p4c reports this precise parser expectation for a misspelled table apply.
// The current buffer, compiler span, and saved source must all agree.
function applyTypoFix(doc, selection, builds, filename) {
  const token = findTokenAt(doc.index, selection.start);
  if (token?.text !== 'aply' || doc.index.tokens[token.index - 1]?.text !== '.') return;
  const { start, end } = token.range;
  if (selection.start.line !== start.line || selection.end.line !== end.line ||
      selection.start.character < start.character || selection.start.character >= end.character ||
      selection.end.character > end.character) return;
  const expected = 'syntax error, unexpected IDENTIFIER, expecting APPLY';
  for (const { diagnostics } of builds) {
    const match = diagnostics.find(d => d.uri === doc.uri && d.severity === 1 && d.message === expected &&
      d.range.start.line === start.line && d.range.end.line === end.line &&
      d.range.start.character === start.character && d.range.end.character === end.character);
    if (!match) continue;
    try {
      if (fs.readFileSync(filename, 'utf8') !== doc.text) return;
    } catch { return; }
    return { title: "Replace 'aply' with 'apply'", kind: 'quickfix',
      edit: { changes: { [doc.uri]: [{ range: token.range, newText: 'apply' }] } } };
  }
}

module.exports = { applyTypoFix };
