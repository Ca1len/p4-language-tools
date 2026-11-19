'use strict';
// P4TEST_16=/path/to/p4test P4TEST_14=/path/to/p4test node --test test/real-compiler.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {runCompiler} = require('../server/compiler');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-language-tools-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  return dir;
}

test('real P4_16 compiler checks a pipeline and locates an error in its header', {skip:!process.env.P4TEST_16}, async t => {
  const cwd = workspace(t);
  const component = path.join(cwd, 'component.p4');
  const unit = '#include "component.p4"\ncontrol Iface(inout bit<8> port);\npackage Pipeline(Iface choose);\nPipeline(Choose()) main;\n';
  const code = 'control Choose(inout bit<8> p) {\n    apply {\n        p = 8w7;\n    }\n}\n';
  fs.writeFileSync(path.join(cwd, 'main.p4'), unit);
  fs.writeFileSync(component, code);
  const options = {cwd, executable:process.env.P4TEST_16, entrypoint:'main.p4', standard:'p4-16'};
  const valid = await runCompiler(options);
  assert.equal(valid.error, null);
  assert.equal(valid.exitCode, 0);
  fs.writeFileSync(component, code.replace('8w7', 'true'));
  const invalid = await runCompiler(options);
  assert.equal(invalid.error, null);
  assert.notEqual(invalid.exitCode, 0);
  const issue = invalid.diagnostics.find(d => d.severity === 1 && d.uri === pathToFileURL(component).href);
  assert.ok(issue, JSON.stringify(invalid));
  assert.equal(issue.range.start.line, 2);
  assert.match(issue.message, /bool/);

  fs.writeFileSync(component, code.replace('apply {', 'aply {'));
  const syntax = await runCompiler(options);
  assert.equal(syntax.error, null);
  assert.notEqual(syntax.exitCode, 0);
  const typo = syntax.diagnostics.find(d => d.uri === pathToFileURL(component).href && d.severity === 1);
  assert.ok(typo, JSON.stringify(syntax));
  assert.match(typo.message, /syntax error/);
  assert.deepEqual(typo.range, {start:{line:1, character:4}, end:{line:1, character:8}});
});

test('real P4_14 compiler accepts a program in legacy syntax', {skip:!process.env.P4TEST_14}, async t => {
  const cwd = workspace(t);
  fs.writeFileSync(path.join(cwd, 'legacy.p4'), [
    'header_type ethernet_t { fields { dest : 48; } }', 'header ethernet_t ethernet;',
    'parser start { extract(ethernet); return ingress; }', 'control ingress {}', 'control egress {}', ''
  ].join('\n'));
  const result = await runCompiler({cwd, executable:process.env.P4TEST_14, entrypoint:'legacy.p4', standard:'p4-14'});
  assert.equal(result.error, null);
  assert.equal(result.exitCode, 0);
});
