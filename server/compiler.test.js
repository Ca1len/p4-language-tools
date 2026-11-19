'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { parseDiagnostics, runCompiler } = require('./compiler');

const vendorLog = [
  'FRONTEND layer processing started...',
  '/work/p4-project/src/switch.p4(57):syntax error, unexpected IDENTIFIER, expecting APPLY',
  '    example_table_key.aply',
  '                      ^^^^',
  '[--Werror=overlimit] error: 1 errors encountered, aborting compilation',
  'Compilation failed!',
].join('\n');

test('exit 1 with a vendor syntax error produces a single diagnostic on aply', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-vendor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'p4c-vendor');
  fs.writeFileSync(executable, `#!${process.execPath}\nconsole.error(${JSON.stringify(vendorLog)}); process.exitCode = 1;\n`, { mode: 0o755 });
  const result = await runCompiler({ cwd: dir, executable, entrypoint: 'switch.p4' });
  assert.equal(result.exitCode, 1);
  assert.equal(result.error, null);
  assert.deepEqual(result.diagnostics, [{
    uri: 'file:///work/p4-project/src/switch.p4',
    range: { start: { line: 56, character: 22 }, end: { line: 56, character: 26 } },
    severity: 1,
    source: 'p4c-vendor',
    message: 'syntax error, unexpected IDENTIFIER, expecting APPLY',
  }]);
});

test('an unterminated stdout banner cannot prefix a stderr diagnostic path', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-streams-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const executable = path.join(cwd, 'compiler');
  fs.writeFileSync(executable, [
    `#!${process.execPath}`,
    "process.stdout.write('FRONTEND layer processing started...');",
    "setTimeout(() => console.error('inc.p4(3):syntax error, unexpected IDENTIFIER\\n    aply\\n    ^^^^'), 25);",
    'process.exitCode = 1;',
  ].join('\n'), { mode: 0o755 });
  const result = await runCompiler({ cwd, executable, entrypoint: 'main.p4' });
  assert.equal(result.error, null);
  assert.equal(result.diagnostics.length, 1);
  const [issue] = result.diagnostics;
  assert.equal(fileURLToPath(issue.uri), path.join(cwd, 'inc.p4'));
  assert.deepEqual(issue.range, { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } });
});

test('maps p4c marker bytes to UTF-16 across tabs and multibyte text', () => {
  const prefix = '\t/*é😀*/ ';
  const output = [
    'inc/header file.p4(8): syntax error at token',
    prefix + 'aply',
    '\t' + ' '.repeat(Buffer.byteLength(prefix) - 1) + '^^^^',
    'inc/header file.p4(10,3): warning: implicit conversion',
    '    unrelated line',
    'Compilation failed!',
  ].join('\r\n');
  const items = parseDiagnostics(output, '/project');
  assert.equal(items.length, 2);
  assert.equal(fileURLToPath(items[0].uri), '/project/inc/header file.p4');
  assert.deepEqual(items[0].range, {
    start: { line: 7, character: prefix.length }, end: { line: 7, character: prefix.length + 4 },
  });
  assert.deepEqual(items[1].range.start, { line: 9, character: 2 });
});

test('parses real p4c format, caret, severity, and relative paths', () => {
  const lines = [
    "tmp.p4(10): [--Werror=type-error] error: 'meta.h' cannot be compared",
    '            if (meta.h == {#}) meta.f = 1;',
    '                ^^^^^^',
    '/tmp/inc.p4(2): warning: unused symbol',
  ];
  const items = parseDiagnostics(lines.join('\n'), '/project');
  assert.equal(items.length, 2);
  assert.equal(fileURLToPath(items[0].uri), '/project/tmp.p4');
  assert.deepEqual(items[0].range, { start: { line: 9, character: 16 }, end: { line: 9, character: 22 } });
  assert.equal(items[0].severity, 1);
  assert.equal(fileURLToPath(items[1].uri), '/tmp/inc.p4');
  assert.equal(items[1].severity, 2);
});

test('parses GCC-style line/column and ANSI colors', () => {
  const items = parseDiagnostics('\u001b[31msrc/header.p4:3:7: error: invalid\u001b[0m\n', '/project');
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].range.start, { line: 2, character: 6 });
  assert.equal(items[0].message, 'invalid');
});

test('runs compiler with exact argument array and reads included-file diagnostics from stdout alone', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4 test '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'fake-compiler');
  fs.writeFileSync(fixture, `#!${process.execPath}\n` + [
    "require('fs').writeFileSync(process.env.P4_TEST_ARGS, JSON.stringify(process.argv.slice(2)));",
    "process.stdout.write('inc.p4(3): [--Werror=type-error] error: invalid\\n');",
    'process.exitCode = 1;',
  ].join('\n'), { mode: 0o755 });
  const out = path.join(dir, 'args.json');
  process.env.P4_TEST_ARGS = out;
  t.after(() => delete process.env.P4_TEST_ARGS);
  const r = await runCompiler({ cwd: dir, executable: fixture, entrypoint: 'main file.p4', standard: 'p4-14', includePaths: ['headers with spaces'], args: ['-DNAME=one;touch nope'] });
  assert.equal(r.error, null);
  assert.equal(r.exitCode, 1);
  assert.equal(fileURLToPath(r.diagnostics[0].uri), path.join(dir, 'inc.p4'));
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), ['--std', 'p4-14', '-I', path.join(dir, 'headers with spaces'), '-DNAME=one;touch nope', path.join(dir, 'main file.p4')]);
  assert.equal(fs.existsSync(path.join(dir, 'nope')), false);
});

test('returns actionable errors for missing compiler and unparsed failures', async t => {
  let result = await runCompiler({ entrypoint: 'x.p4', executable: '/path/that/does/not/exist' });
  assert.match(result.error, /Cannot start/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'compiler');
  fs.writeFileSync(executable, `#!${process.execPath}\nconsole.error('no such target'); process.exit(2);\n`, { mode: 0o755 });
  result = await runCompiler({ entrypoint: 'x.p4', executable });
  assert.match(result.error, /no such target/);
  assert.equal(result.exitCode, 2);
});

test('times out runaway compilers', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'compiler');
  fs.writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const result = await runCompiler({ entrypoint: 'x.p4', executable, timeoutMs: 100 });
  assert.match(result.error, /timed out/);
});

test('does not hide unexplained compiler failure just because a warning was parsed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-warning-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'compiler');
  fs.writeFileSync(executable, `#!${process.execPath}\nconsole.error('x.p4(2): warning: something'); process.exit(1);\n`, { mode: 0o755 });
  const result = await runCompiler({ entrypoint: 'x.p4', executable });
  assert.match(result.error, /exit 1/);
  assert.equal(result.diagnostics.length, 1);
});

test('keeps the actual P4 type error following the caret excerpt', () => {
  const output = [
    "invalid.p4(3): [--Werror=type-error] error: 'p = true'",
    '        p = true;', '          ^', '  ---- Actual error:',
    "  Cannot cast implicitly type 'bool' to type 'bit<8>'",
    '  ---- Originating from:', "  invalid.p4(3): Source expression 'true' produces a result of type 'bool'",
    '          p = true;', '              ^^^^'
  ].join('\n');
  const items = parseDiagnostics(output, '/project');
  assert.equal(items.length, 1);
  assert.equal(items[0].message, "'p = true'\nCannot cast implicitly type 'bool' to type 'bit<8>'");
  assert.deepEqual(items[0].range.start, {line:2,character:10});
  assert.equal(items[0].code, 'type-error');
  assert.deepEqual(items[0].relatedInformation, [{
    location: { uri: 'file:///project/invalid.p4', range: { start: {line:2,character:12}, end: {line:2,character:16} } },
    message: "Source expression 'true' produces a result of type 'bool'",
  }]);
});

test('p4c located Actual error and repeated origins link across files without becoming separate problems', () => {
  // Output of upstream p4test for an out parameter declared in decl.p4i.
  const first = [
    "main.p4(6): [--Werror=type-error] error: 'f(8w1)'",
    '        f(8w1);',
    '        ^^^^^^',
    '  ---- Actual error:',
    "  main.p4(6): : Read-only value used for out/inout parameter 'v'",
    '          f(8w1);',
    '            ^^^',
    '  decl.p4i(1)',
    '  void f(out bit<8> v){}',
    '                    ^',
    '  ---- Originating from:',
    "  decl.p4i(1): Function type 'f' does not match invocation type '<Method call>'",
    '  void f(out bit<8> v){}',
    '       ^',
    '  main.p4(6)',
    '          f(8w1);',
    '          ^^^^^^',
  ];
  const other = [
    'include dir/next.p4(2): [--Wwarn=unused] warning: unused declaration',
    '/*😀*/ abc', '         ^^^',
    'Compilation finished',
    '  ---- Originating from:',
    '  unrelated.p4(1): not part of the warning',
  ];
  const [error, warning, ...extra] = parseDiagnostics([...first, ...other].join('\n'), '/project');
  assert.deepEqual(extra, []);
  assert.equal(error.message, "'f(8w1)'\nRead-only value used for out/inout parameter 'v'");
  assert.equal(warning.code, 'unused');
  assert.equal(warning.severity, 2);
  assert.equal(warning.relatedInformation, undefined);
  const links = error.relatedInformation.map(({location, message}) =>
    [fileURLToPath(location.uri), location.range.start.line, location.range.start.character, location.range.end.character, message]);
  assert.deepEqual(links, [
    ['/project/main.p4', 5, 10, 13, "Read-only value used for out/inout parameter 'v'"],
    ['/project/decl.p4i', 0, 18, 19, 'void f(out bit<8> v){}'],
    ['/project/decl.p4i', 0, 5, 6, "Function type 'f' does not match invocation type '<Method call>'"],
    ['/project/main.p4', 5, 8, 14, 'f(8w1);'],
  ]);
});

test('p4c duplicate declaration points to the original definition outside a named section', () => {
  const output = [
    'decl.p4i(2): [--Werror=duplicate] error: Con duplicates Con.',
    'const bit<8> Con = 1;', '             ^^^',
    'other header.p4i(7)', 'const bit<8> Con = 0;', '             ^^^',
  ];
  const [error, ...rest] = parseDiagnostics(output.join('\n'), '/project');
  assert.deepEqual(rest, []);
  assert.equal(error.code, 'duplicate');
  assert.deepEqual(error.relatedInformation, [{
    location: {uri: 'file:///project/other%20header.p4i',
      range: {start: {line: 6, character: 13}, end: {line: 6, character: 16}}},
    message: 'const bit<8> Con = 0;',
  }]);
});
