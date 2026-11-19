'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDocument } = require('../src/format');

function formatted(text, options) {
  let lines = text.split('\n');
  const edits = formatDocument(text, options);
  for (const { range, newText } of edits) {
    assert.equal(range.start.character, 0);
    assert.equal(range.start.line, range.end.line);
    assert.match(newText, /^[ \t]*$/);
    const line = range.start.line;
    assert.match(lines[line].slice(0, range.end.character), /^[ \t]*$/);
    lines[line] = newText + lines[line].slice(range.end.character);
  }
  return lines.join('\n');
}

test('formats P4-14 and P4-16 nesting without changing field values, end-of-line comments or CRLF', () => {
  const source = 'header_type h {\r\nfields {\r\nf : 8;  // }\r\n}\r\n}\r\ncontrol C() {\r\napply {\r\na();\r\n}\r\n}';
  const actual = formatted(source, { insertSpaces: false, tabSize: 8 });
  assert.equal(actual, 'header_type h {\r\n\tfields {\r\n\t\tf : 8;  // }\r\n\t}\r\n}\r\ncontrol C() {\r\n\tapply {\r\n\t\ta();\r\n\t}\r\n}');
  assert.deepEqual(formatDocument(actual, { insertSpaces: false }), []);
});

test('keeps macro lines, block comment interiors and continued strings byte-for-byte', () => {
  const input = ['  #define M(x) \\', '     ((x) + 1)', 'action f() {',
    '/* {', ' comment */', 'log("a\\', '   b");', 'x=M(1);', '}'].join('\n');
  const result = formatted(input, { tabSize: 2, insertSpaces: true }).split('\n');
  const original = input.split('\n');
  for (const i of [0, 1, 4, 6]) assert.equal(result[i], original[i]);
  assert.equal(result[7], '  x=M(1);');
});

test('resets nesting at alternative preprocessor branches and leaves malformed files unchanged', () => {
  const branches = '#if V\naction f() {\n#else\naction g() {\n#endif\nfoo();\n}';
  assert.match(formatted(branches, { tabSize: 2 }), /\n  foo\(\);\n}/);
  for (const source of ['control C() {\napply {', 'action f() {\nfoo(];\n}', '#if V\n{\n#endif\n}', '  /* unclosed']) {
    assert.deepEqual(formatDocument(source), []);
  }
});
