'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {indexDocument, positionAt} = require('../server/src/indexer');
const {macroTargets, macroAt} = require('../server/src/macros');
const {signatureHelp} = require('../server/src/signatures');
function doc(text, uri='file:///a.p4') { return {text, uri, index:indexDocument(text,uri)}; }
test('documented SDK macros expose tokens, active argument and help from an included file', () => {
  const sdk = doc('/**\n * Tag packets.\n * @param port Output port\n */\n#define TAG(h, \\\n port) h.tag = port\n', 'file:///sdk.p4');
  const use = doc('control C() { apply { TAG(f(1, 2), ); } }');
  const [target] = macroAt(use,positionAt(use.text,use.text.indexOf('TAG')+1),[sdk]);
  assert.equal(target.declaration.token.range.start.line,4);
  assert.equal(target.label,'#define TAG(h, port)');
  assert.equal(target.docs.summary,'Tag packets.');
  assert.equal(target.docs.params.port,'Output port');
  const result = signatureHelp(use,positionAt(use.text,use.text.indexOf(', )')+2),[sdk]);
  assert.equal(result.activeParameter,1);
  assert.equal(result.signatures[0].parameters[1].documentation.value,'Output port');
});
test('excludes commented directives and respects local undef/definition order', () => {
  const use = doc('/*\n#define HIDDEN(x) 1\n*/\n#define BEFORE 10\n#undef BEFORE\n#define AFTER 20\n');
  assert.deepEqual(macroTargets(use,'HIDDEN'),[]);
  assert.deepEqual(macroTargets(use,'BEFORE'),[]);
  assert.equal(macroTargets(use,'BEFORE',[],use.text.indexOf('#undef'))[0].label,'#define BEFORE 10');
  assert.deepEqual(macroTargets(use,'AFTER',[],0),[]);
  assert.equal(macroAt(use,positionAt(use.text,use.text.indexOf('BEFORE')+1))[0].label,'#define BEFORE 10');
  assert.deepEqual(macroTargets(use,'BEFORE',[doc('#define BEFORE 2')]),[]);
});
test('preserves conditional definitions and detects object-like macros with parenthesized values', () => {
  const file = doc('#ifdef A\n#define RUN(x) x\n#else\n#define RUN(a,b) (b)\n#endif\n#define OBJECT (7)\n');
  assert.deepEqual(macroTargets(file,'RUN').map(x => [x.parameters, x.conditional]),[[['x'],true],[['a','b'],true]]);
  assert.equal(macroTargets(file,'OBJECT')[0].parameters,null);
});
