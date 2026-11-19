'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preprocess } = require('../src/preprocess');

test('keeps the selected branch and preserves UTF-16 offsets and CRLF for both P4 dialects', () => {
  const source = '#if defined(ASIC) && ASIC >= 0x20U\r\nheader_type Foo { fields { port: 8; } }\r\n#elif ASIC == 017\r\nheader Foo { bit<8> port; }\r\n#else\r\n// 🚀 fallback\r\n#endif\r\n';
  const a = preprocess(source, ['-D', 'ASIC=32']);
  assert.equal(a.text.length, source.length);
  assert.equal(a.text.indexOf('header_type'), source.indexOf('header_type'));
  assert.deepEqual(a.text.match(/\r\n/g), source.match(/\r\n/g));
  assert.ok(!a.text.includes('bit<8>') && !a.text.includes('🚀'));
  const b = preprocess(source, ['-DASIC=15']);
  assert.ok(b.text.includes('bit<8>') && !b.text.includes('header_type'));
  assert.equal(b.text.indexOf('port'),source.lastIndexOf('port'));
  assert.deepEqual(b.diagnostics,[]);
});

test('tracks definite and possible environments across nested branches', () => {
  const source = '#if ARCH_FN(x)\n#define MODE 2\nunknownA\n#else\n#define MODE 2\nunknownB\n#endif\n#if MODE == 2\nmode2\n#else\nmode3\n#endif\n';
  const out = preprocess(source);
  assert.ok(out.text.includes('unknownA') && out.text.includes('unknownB'));
  assert.ok(out.uncertainRanges.length);
  assert.ok(out.text.includes('mode2') && !out.text.includes('mode3'));
  const varied = preprocess(source.replace('MODE 2\nunknownA','MODE 5\nunknownA'));
  assert.ok(varied.text.includes('mode2') && varied.text.includes('mode3'));
});

test('unknown inherited macros and unresolved includes retain possible branches', () => {
  const body = '#ifdef FEATURE\nyes\n#else\nno\n#endif\n';
  assert.ok(preprocess(body).text.includes('yes'));
  assert.ok(preprocess(body,['-UFEATURE']).text.includes('no'));
  assert.ok(!preprocess(body,['-UFEATURE']).text.includes('yes'));
  assert.ok(preprocess('#include "vendor.p4"\n' + body,['-UFEATURE']).text.includes('yes'));
  const header = {id:'vendor.p4', text:'#define FEATURE 1\n'};
  const withSdk = preprocess('#include "vendor.p4"\n'+body, [], {readInclude: () => header});
  assert.ok(withSdk.text.includes('yes') && !withSdk.text.includes('\nno\n'));
  const reset = preprocess('#define FEATURE 1\n#undef FEATURE\n' + body);
  assert.ok(!reset.text.includes('yes'));
});

test('handles continuations, comments and broken directive nesting while typing', () => {
  const src = '/*\n#if 0\n*/\n#define ENABLE 1\n#if ENABLE && \\\n (3 > 1)\ngood\n#else\nbad\n#endif\n';
  assert.ok(preprocess(src).text.includes('good') && !preprocess(src).text.includes('bad'));
  const incomplete = '#if 0\nheader MayBeVisible {}\n';
  const result = preprocess(incomplete);
  assert.equal(result.text,incomplete);
  assert.match(result.diagnostics[0].message, /endif/);
  assert.equal(preprocess('#else\n#endif\n').diagnostics.length,2);
});

test('an opaque macro replacement may change expression precedence', () => {
  const source = '#define FLAG 1 || 2\n#if FLAG && 0\nleft\n#else\nright\n#endif';
  const {text} = preprocess(source);
  assert.ok(text.includes('left') && text.includes('right'));
});
