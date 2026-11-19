'use strict';

const matchingOpen = new Map([['}', '{'], [')', '('], [']', '[']]);
const matchingClose = new Map([['{', '}'], ['(', ')'], ['[', ']']]);

/**
 * Structural diagnostics for one editor snapshot. The optional preprocessed
 * text must retain source line breaks and UTF-16 offsets. Unknown CPP paths
 * can legitimately have incompatible delimiter stacks.
 */
function liveDiagnostics(doc, options = {}) {
  const text = options.text ?? doc.text;
  const diagnostics = [];
  const opens = [];
  const uncertain = options.uncertainRanges || [];
  let region = 0;
  let delimiterCheck = true;
  let state = 'code';
  let literalStart;
  let continuedDirective = false;
  let continuedComment = false;

  function report(code, message, range, severity = 1) {
    if (diagnostics.length < 32) diagnostics.push({source: 'p4-editor', code, severity, message, range});
  }
  function rangeAt(line, column, length = 1) {
    return { start: {line, character: column}, end: {line, character: column + length} };
  }
  function delimiter(char, line, column) {
    if (!delimiterCheck) return;
    if (matchingClose.has(char)) {
      opens.push({char, line, column});
      return;
    }
    if (!matchingOpen.has(char)) return;
    const open = opens.pop();
    if (open?.char === matchingOpen.get(char)) return;
    const message = open ? `Expected '${matchingClose.get(open.char)}' before '${char}'.` : `Unexpected '${char}'.`;
    report('unexpected-delimiter', message, rangeAt(line, column));
    delimiterCheck = false; // One mismatched token could corrupt every following match.
  }

  let line = 0, start = 0;
  while (start < text.length) {
    const lf = text.indexOf('\n', start);
    const end = lf < 0 ? text.length : lf;
    const raw = text.slice(start, end);
    const next = lf < 0 ? end : end + 1;
    while (region < uncertain.length && uncertain[region].end <= start) ++region;
    const inUnknownBranch = region < uncertain.length && uncertain[region].start < next;
    if (inUnknownBranch) {
      // Once a possible alternative can open/close a block, the stack for
      // code following the conditional cannot be reconstructed reliably.
      if (/[{}()[\]]/.test(raw)) delimiterCheck = false;
      start = next;
      ++line;
      continue;
    }

    const directive = !continuedComment && state === 'code' && /^[ \t]*#/.test(raw);
    if (directive && !continuedDirective && options.resolveInclude) {
      const include = /^[ \t]*#[ \t]*include\b[ \t]*(?:"([^"\r\n]+)"|<([^>\r\n]+)>)/.exec(raw);
      if (include) {
        const quoted = include[1] !== undefined;
        const name = include[1] ?? include[2];
        const endCol = include[0].length, col = endCol - name.length - 2;
        const target = {name, quoted, start: start + col, end: start + endCol};
        if ((quoted || options.includePathsConfigured) && !options.resolveInclude(target)) {
          report('missing-include', `Cannot find '${name}' in the editor's include search paths.`,
            rangeAt(line, col, endCol - col), 2);
        }
      }
    }
    const skipDelimiters = directive || continuedDirective;
    const splice = lf >= 0 && /\\\r?$/.test(raw);
    continuedDirective = skipDelimiters && splice;
    if (continuedComment) {
      continuedComment = splice;
    } else {
      for (let col = 0; col < raw.length; ++col) {
        const ch = raw[col], after = raw[col + 1];
        if (state === 'block-comment') {
          if (ch === '*' && after === '/') { state = 'code'; ++col; }
          continue;
        }
        if (state === 'string') {
          if (ch === '\\') ++col;
          else if (ch === '"') state = 'code';
          continue;
        }
        if (ch === '/' && after === '/') { continuedComment = splice; break; }
        if (ch === '/' && after === '*') {
          state = 'block-comment'; literalStart = rangeAt(line, col, 2); ++col;
        } else if (ch === '"') {
          state = 'string'; literalStart = rangeAt(line, col);
        } else if (!skipDelimiters) {
          delimiter(ch, line, col);
        }
      }
    }
    ++line;
    start = next;
  }
  if (state === 'block-comment') report('unclosed-comment', "Block comment is missing '*/'.", literalStart);
  else if (state === 'string') report('unclosed-string', 'Missing closing double quote.', literalStart);
  else if (delimiterCheck) {
    for (const open of opens.slice(-8))
      report('unclosed-delimiter', `Missing '${matchingClose.get(open.char)}' for '${open.char}'.`, rangeAt(open.line, open.column));
  }
  return diagnostics;
}

module.exports = { liveDiagnostics };
