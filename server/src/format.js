'use strict';

const closer = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
const isCloser = new Set(closer.values());

// Only record brackets and the first other non-comment token. Spelling, UTF-16
// columns, line endings and trivia in the document are left to the editor.
function scanLine(line, state) {
  const tokens = [];
  let firstCode = -1;
  let lineComment = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i], next = line[i + 1];
    if (state.comment) {
      if (c === '*' && next === '/') { state.comment = false; i++; }
      continue;
    }
    if (state.quote) {
      if (c === '\\') i++;
      else if (c === state.quote) state.quote = '';
      continue;
    }
    if (c === '/' && next === '/') { lineComment = true; break; }
    if (c === '/' && next === '*') { state.comment = true; i++; continue; }
    if (/\s/.test(c)) continue;
    if (firstCode === -1) firstCode = i;
    if (closer.has(c) || isCloser.has(c)) tokens.push(c);
    else if (tokens.at(-1) !== '.') tokens.push('.');
    if (c === '"' || c === "'") state.quote = c;
  }
  return { tokens, firstCode, lineComment };
}

// At #else / #elif start again with the nesting present before #if. A
// conditional can introduce a surrounding block only if every branch does so.
function conditionalDirective(line, nesting, conditions) {
  const directive = /^#\s*(\w+)/.exec(line)?.[1];
  if (['if', 'ifdef', 'ifndef'].includes(directive)) {
    conditions.push({ start: nesting.slice(), end: undefined, sawElse: false });
    return nesting;
  }
  if (!['else', 'elif', 'elifdef', 'elifndef', 'endif'].includes(directive)) return nesting;
  const condition = conditions.at(-1);
  if (!condition || (condition.sawElse && directive !== 'endif')) return null;
  const end = nesting.join('');
  if (condition.end !== undefined && condition.end !== end) return null;
  condition.end = end;
  if (directive === 'endif') {
    conditions.pop();
    if (!condition.sawElse && end !== condition.start.join('')) return null;
    return nesting;
  }
  if (directive === 'else') condition.sawElse = true;
  return condition.start.slice();
}

/** Return indentation edits using only LSP TextEdit objects, or [] when unbalanced. */
function formatDocument(text, options = {}) {
  const tabSize = Number.isInteger(options.tabSize) && options.tabSize >= 1 && options.tabSize <= 32 ? options.tabSize : 4;
  const unit = options.insertSpaces === false ? '\t' : ' '.repeat(tabSize);
  const lines = text.split(/\r\n|\r|\n/);
  const state = { quote: '', comment: false };
  let nesting = [], macro = false, continuedLine = false, continuedComment = false;
  const conditions = [], edits = [];
  for (let number = 0; number < lines.length; number++) {
    const line = lines[number];
    const isContinuation = continuedLine;
    continuedLine = /\\[\t ]*$/.test(line);
    if (continuedComment) {
      continuedComment = continuedLine;
      if (macro) macro = continuedLine;
      continue;
    }

    const beginsInside = state.comment || !!state.quote;
    const { tokens, firstCode, lineComment } = scanLine(line, state);
    continuedComment = lineComment && continuedLine;
    const directive = firstCode >= 0 && line[firstCode] === '#';
    if (macro || directive) {
      if (!macro && directive) {
        nesting = conditionalDirective(line.slice(firstCode), nesting, conditions);
        if (!nesting) return [];
      }
      macro = continuedLine;
      continue;
    }

    let expectedDepth = nesting.length;
    let leadingClosers = true;
    for (const token of tokens) {
      if (isCloser.has(token)) {
        if (nesting.pop() !== token) return [];
        if (leadingClosers) expectedDepth--;
      } else {
        leadingClosers = false;
        if (closer.has(token)) nesting.push(closer.get(token));
      }
    }
    if (beginsInside || isContinuation || !line.trim()) continue;
    // Bounds keep incomplete or generated structures from requesting a huge
    // replacement. Such a document can still use the rest of the language server.
    if (expectedDepth > 256) return [];
    const indent = /^[ \t]*/.exec(line)[0];
    const newText = unit.repeat(expectedDepth);
    if (indent === newText) continue;
    edits.push({ range: { start: { line: number, character: 0 }, end: { line: number, character: indent.length } }, newText });
  }
  return nesting.length || conditions.length || state.quote || state.comment || macro ? [] : edits;
}

module.exports = { formatDocument };
