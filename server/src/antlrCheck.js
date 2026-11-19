'use strict';

const MAX_SOURCE_UNITS = 512 * 1024;
const MAX_DIAGNOSTICS = 30;

// Ignore standalone include directives in the local syntax pass. The upstream
// grammar accepts nominal type identifiers without resolving their declarations.
// Input with preprocessing that could change the grammar is left to p4c unless
// the caller has already produced a line- and column-preserving active view.
function localSource(text) {
  if (!text.includes('#')) return text;
  const parts = /\/\*[\s\S]*?(?:\*\/|(?![\s\S]))|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*(?:"|(?![\s\S]))|^[\t \uFEFF]*#[^\r\n]*/gm;
  let supported = true;
  const masked = text.replace(parts, part => {
    if (!/^\s*#/.test(part)) return part;
    const harmless = /^\s*#\s*(?:include\s*(?:"[^"\r\n]+"|<[^>\r\n]+>)|pragma\s+once|line\s+\d+(?:\s+"[^"]*")?)\s*(?:\/\/.*|\/\*.*?\*\/\s*)?$/;
    if (!harmless.test(part) || /\\$/.test(part)) supported = false;
    return ' '.repeat(part.length);
  });
  return supported ? masked : undefined;
}

/**
 * Synchronously check one P4_16 document. Use a bounded worker when serving
 * interactive requests. Ranges are local UTF-16 positions in the supplied text.
 */
function syntaxDiagnostics(text) {
  if (typeof text !== 'string' || !text.length || text.length > MAX_SOURCE_UNITS) return [];
  const source = localSource(text);
  if (source === undefined) return [];

  const { parse } = require('../vendor-antlr/p4-parser');
  const lines = text.split('\n');
  const diagnostics = [];
  const reachedLimit = Symbol('Maximum P4 syntax diagnostics');
  const lineOffsets = new Map();
  function at(lineNumber, column) {
    let offsets = lineOffsets.get(lineNumber);
    if (!offsets) {
      offsets = [0];
      const line = (lines[lineNumber] || '').replace(/\r$/, '');
      for (const ch of line) offsets.push(offsets[offsets.length - 1] + ch.length);
      lineOffsets.set(lineNumber, offsets);
    }
    return { line: lineNumber, character: offsets[Math.max(0, Math.min(column, offsets.length - 1))] };
  }
  try {
    parse(source, (line, column, width, message) => {
      const row = Math.max(0, Math.min(line, lines.length - 1));
      diagnostics.push({
        range: { start: at(row, column), end: at(row, column + width) },
        severity: 1, source: 'P4 ANTLR', message
      });
      if (diagnostics.length >= MAX_DIAGNOSTICS) throw reachedLimit;
    });
  } catch (error) {
    if (error !== reachedLimit) throw error;
  }
  return diagnostics;
}

module.exports = { syntaxDiagnostics };
