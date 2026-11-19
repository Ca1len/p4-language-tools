'use strict';

// Black-box LSP integration tests. Run: node --test test/integration.test.js
// Only Node.js built-ins are used; no VS Code process or P4 compiler required.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const serverPath = process.env.P4_LSP_TEST_SERVER || path.resolve(__dirname, '../server/src/server.js');

class Client {
  constructor() {
    this.proc = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.notifications = [];
    this.notificationWaiters = [];
    this.proc.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
    this.proc.stdout.on('data', chunk => this.consume(chunk));
    this.proc.on('exit', (code, signal) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`server exited code=${code}, signal=${signal}; stderr=${this.stderr}`));
      }
      this.pending.clear();
    });
  }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const headers = this.buffer.subarray(0, end).toString('ascii');
      const match = /^content-length:\s*(\d+)\s*$/im.exec(headers);
      assert.ok(match, `missing Content-Length: ${headers}`);
      const length = Number(match[1]);
      if (this.buffer.length < end + 4 + length) return;
      const payload = this.buffer.subarray(end + 4, end + 4 + length);
      this.buffer = this.buffer.subarray(end + 4 + length);
      const message = JSON.parse(payload.toString('utf8'));
      assert.equal(message.jsonrpc, '2.0');
      if (message.id !== undefined && !message.method && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } else if (message.id === undefined && message.method) {
        this.notifications.push(message);
        for (const waiter of [...this.notificationWaiters]) if (waiter.predicate(message)) {
          clearTimeout(waiter.timer);
          this.notificationWaiters.splice(this.notificationWaiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      } else if (message.id !== undefined && message.method) {
        // Reply to standard requests emitted by servers.
        this.send({ jsonrpc: '2.0', id: message.id, result: message.method === 'workspace/configuration' ? message.params.items.map(() => ({})) : null });
      }
    }
  }
  send(message) {
    const payload = Buffer.from(JSON.stringify(message));
    this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`), payload]));
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  waitForNotification(predicate, timeoutMs = 5000) {
    const prior = this.notifications.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => {
        this.notificationWaiters.splice(this.notificationWaiters.indexOf(waiter), 1);
        reject(new Error(`notification timed out; stderr=${this.stderr}; notifications=${JSON.stringify(this.notifications)}`));
      }, timeoutMs) };
      this.notificationWaiters.push(waiter);
    });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout in ${method}; stderr=${this.stderr}`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
}

function position(text, needle, occurrence = 0) {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(needle, index + 1);
    assert.notEqual(index, -1, `missing ${needle}`);
  }
  const before = text.slice(0, index);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines.at(-1).length + 1 };
}
function locations(result) { return Array.isArray(result) ? result : result ? [result] : []; }
function at(loc, uri, pos) {
  const r = loc.targetSelectionRange || loc.range;
  return (loc.uri || loc.targetUri) === uri && r && r.start.line === pos.line;
}

test('P4 language server speaks LSP and indexes an include', { timeout: 30000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-lsp-integration-'));
  const lib = 'header ethernet_t {\n    bit<48> dst;\n    bit<48> src;\n}\n';
  const main = '#include "headers.p4"\n\nstruct headers_t {\n    ethernet_t ethernet;\n}\n\ncontrol ingress(inout headers_t hdr) {\n    action mark_drop() { }\n    apply { mark_drop(); }\n}\n';
  const libPath = path.join(temp, 'headers.p4');
  const mainPath = path.join(temp, 'main.p4');
  fs.writeFileSync(libPath, lib);
  fs.writeFileSync(mainPath, main);
  const uri = pathToFileURL(mainPath).href;
  const libUri = pathToFileURL(libPath).href;
  const client = new Client();
  t.after(() => { client.proc.kill(); fs.rmSync(temp, { recursive: true, force: true }); });
  const initialized = await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(temp).href,
    workspaceFolders: [{ uri: pathToFileURL(temp).href, name: 'test' }],
    capabilities: {},
  });
  assert.ok(initialized.capabilities);
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'p4', version: 1, text: main } });
  client.notify('textDocument/didOpen', { textDocument: { uri: libUri, languageId: 'p4', version: 1, text: lib } });
  const td = { uri };
  const call = (method, needle, occurrence = 0, extra = {}) => client.request(method, { textDocument: td, position: position(main, needle, occurrence), ...extra });
  const actionDecl = position(main, 'mark_drop', 0);
  const actionUse = position(main, 'mark_drop', 1);
  const definitions = locations(await call('textDocument/definition', 'mark_drop', 1));
  assert.ok(definitions.some(l => at(l, uri, actionDecl)), `action definition missing: ${JSON.stringify(definitions)}`);
  const refs = locations(await call('textDocument/references', 'mark_drop', 0, { context: { includeDeclaration: true } }));
  assert.ok(refs.some(l => at(l, uri, actionDecl)) && refs.some(l => at(l, uri, actionUse)), `references missing declaration or use: ${JSON.stringify(refs)}`);
  const hover = await call('textDocument/hover', 'mark_drop', 1);
  assert.ok(hover && hover.contents, `hover missing: ${JSON.stringify(hover)}`);
  const completion = await call('textDocument/completion', 'mark_drop', 1);
  const items = Array.isArray(completion) ? completion : completion?.items;
  assert.ok(Array.isArray(items) && items.some(x => x.label === 'mark_drop'), 'completion does not include declared action');
  const cross = locations(await call('textDocument/definition', 'ethernet_t'));
  assert.ok(cross.some(l => at(l, libUri, position(lib, 'ethernet_t'))), `included header definition missing: ${JSON.stringify(cross)}`);
  const docSymbols = await client.request('textDocument/documentSymbol', { textDocument: td });
  assert.ok(Array.isArray(docSymbols) && docSymbols.length, 'document symbols missing');
  const workspaceSymbols = await client.request('workspace/symbol', { query: 'ethernet_t' });
  assert.ok(Array.isArray(workspaceSymbols) && workspaceSymbols.some(s => s.name === 'ethernet_t'), 'workspace symbol missing');

  // An incremental unsaved edit must re-index the in-memory buffer and report
  // updated UTF-16 positions without modifying the source file on disk.
  const insert = '    // unsaved edit\n';
  const insertionPoint = { line: 7, character: 0 };
  client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: insertionPoint, end: insertionPoint }, text: insert }] });
  const changed = main.replace('    action mark_drop()', insert + '    action mark_drop()');
  const changedDefinition = locations(await client.request('textDocument/definition', { textDocument: td, position: position(changed, 'mark_drop', 1) }));
  assert.ok(changedDefinition.some(l => at(l, uri, position(changed, 'mark_drop', 0))), `didChange did not re-index buffer: ${JSON.stringify(changedDefinition)}`);
  assert.equal(fs.readFileSync(mainPath, 'utf8'), main, 'unsaved edit unexpectedly modified disk');

  // Two identically named actions must not be conflated. This is essential
  // for references and especially for rename, where incorrect edits lose data.
  const scoped = 'control First() {\n  action hit() { }\n  apply { hit(); }\n}\ncontrol Second() {\n  action hit() { }\n  apply { hit(); }\n}\n';
  const scopedPath = path.join(temp, 'scopes.p4');
  fs.writeFileSync(scopedPath, scoped);
  const scopedUri = pathToFileURL(scopedPath).href;
  client.notify('textDocument/didOpen', { textDocument: { uri: scopedUri, languageId: 'p4', version: 1, text: scoped } });
  const scopedParams = { textDocument: { uri: scopedUri }, position: position(scoped, 'hit', 1) };
  const scopedDefinition = locations(await client.request('textDocument/definition', scopedParams));
  assert.ok(scopedDefinition.length === 1 && at(scopedDefinition[0], scopedUri, position(scoped, 'hit', 0)), `scoped definition is ambiguous or incorrect: ${JSON.stringify(scopedDefinition)}`);
  const scopedRefs = locations(await client.request('textDocument/references', { ...scopedParams, context: { includeDeclaration: true } }));
  assert.equal(scopedRefs.length, 2, `references mix distinct scopes: ${JSON.stringify(scopedRefs)}`);
  assert.ok(scopedRefs.every(l => (l.uri === scopedUri) && [1, 2].includes(l.range.start.line)), `references cross scopes: ${JSON.stringify(scopedRefs)}`);
  if (initialized.capabilities.renameProvider) {
    // A scoped action name can also occur in control-plane metadata and is
    // outside the supported subset. F2 must decline it without offering edits.
    assert.equal(await client.request('textDocument/prepareRename', scopedParams), null);
    await assert.rejects(client.request('textDocument/rename', { ...scopedParams, newName: 'renamed' }));

  }
  assert.equal(await client.request('shutdown', null), null);
  client.notify('exit');
  const exit = await new Promise(resolve => client.proc.once('exit', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 0, signal: null });
});


test('LSP resolves only included files and compiles configured entrypoint after saving an include', { timeout: 30000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-lsp-compiler-'));
  fs.mkdirSync(path.join(temp, 'inc'));
  const main = '#include <headers.p4>\nstruct meta_t { ethernet_t eth; foreign_t foreign; }\n';
  const include = 'header ethernet_t {\n  bit<48> dst;\n}\n';
  const other = 'struct foreign_t { bit<8> x; }\n';
  const entrypoint = path.join(temp, 'main.p4');
  const includePath = path.join(temp, 'inc', 'headers.p4');
  const trace = path.join(temp, 'args.json');
  const fake = path.join(temp, 'fake-p4test');
  fs.writeFileSync(entrypoint, main);
  fs.writeFileSync(includePath, include);
  fs.writeFileSync(path.join(temp, 'unrelated.p4'), other);
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2)));\nprocess.stderr.write('inc/headers.p4(2): [--Werror=type-error] error: intentional type error\\n');\nprocess.exitCode = 1;\n`);
  fs.chmodSync(fake, 0o755);
  const rootUri = pathToFileURL(temp).href;
  const uri = pathToFileURL(entrypoint).href;
  const includeUri = pathToFileURL(includePath).href;
  const client = new Client();
  t.after(() => { client.proc.kill(); fs.rmSync(temp, { recursive: true, force: true }); });
  await client.request('initialize', {
    processId: process.pid, rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'test' }], capabilities: {},
    initializationOptions: { p4: { compiler: {
      enabled: true, path: fake, entrypoint: 'main.p4', language: 'p4-14',
      includePaths: ['inc'], args: ['--Wdisable=unused'], timeoutMs: 5000,
    } } },
  });
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'p4', version: 1, text: main } });
  client.notify('textDocument/didOpen', { textDocument: { uri: includeUri, languageId: 'p4', version: 1, text: include } });
  const includedDef = locations(await client.request('textDocument/definition', { textDocument: { uri }, position: position(main, 'ethernet_t') }));
  assert.ok(includedDef.some(loc => at(loc, includeUri, position(include, 'ethernet_t'))), `include path lookup failed: ${JSON.stringify(includedDef)}`);
  const unrelatedDef = locations(await client.request('textDocument/definition', { textDocument: { uri }, position: position(main, 'foreign_t') }));
  assert.deepEqual(unrelatedDef, [], `symbol from unrelated file resolved: ${JSON.stringify(unrelatedDef)}`);

  client.notify('textDocument/didSave', { textDocument: { uri: includeUri } });
  const notification = await client.waitForNotification(m => m.method === 'textDocument/publishDiagnostics' && m.params.uri === includeUri && m.params.diagnostics.length);
  const diagnostic = notification.params.diagnostics[0];
  assert.match(diagnostic.message, /intentional type error/);
  assert.equal(diagnostic.range.start.line, 1);
  assert.equal(diagnostic.severity, 1);
  const {params: log} = await client.waitForNotification(m => m.method === 'p4/compilerOutput');
  assert.equal(log.entrypoint, entrypoint);
  assert.equal(log.source, fake);
  assert.equal(log.exitCode, 1);
  assert.match(log.output, /intentional type error/);
  const args = JSON.parse(fs.readFileSync(trace, 'utf8'));
  assert.deepEqual(args, ['--std', 'p4-14', '-I', path.join(temp, 'inc'), '--Wdisable=unused', entrypoint]);
  await client.request('shutdown', null);
  client.notify('exit');
  const exit = await new Promise(resolve => client.proc.once('exit', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 0, signal: null });
});

test('manual checks use the configured unit, publish full compiler output and respect disabled compilation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-manual-'));
  const client = new Client();
  t.after(() => { client.proc.kill(); fs.rmSync(root, {recursive: true, force: true}); });
  const folder = pathToFileURL(root).href;
  const unit = path.join(root, 'main.p4');
  const include = path.join(root, 'included.p4');
  const uri = pathToFileURL(include).href;
  const compiler = path.join(root, 'test-compiler');
  fs.writeFileSync(unit, '#include "included.p4"\n');
  fs.writeFileSync(include, 'const bit<1> k = 0;\n');
  fs.writeFileSync(compiler, `#!${process.execPath}
const path = require('node:path');
if (path.basename(process.argv.at(-1)) !== 'main.p4') process.exit(7);
if (process.argv.includes('--backend-fail')) {
  console.log('x'.repeat(2500));
  console.error('A detailed backend failure after the banner.');
  process.exitCode = 2;
} else if (process.argv.includes('--warning')) {
  console.error('included.p4(1): warning: unused constant');
} else if (process.argv.includes('--slow-error')) {
  setTimeout(() => { console.error('included.p4(1): error: superseded problem'); process.exitCode = 1; }, 100);
}
`, {mode: 0o755});
  const configure = compilerSettings => client.notify('workspace/didChangeConfiguration', {settings: {p4: {compiler: compilerSettings}}});
  const check = (target = uri) => client.request('p4/checkProject', {uri: target});
  await client.request('initialize', {rootUri: folder, capabilities: {}});
  assert.equal((await check()).status, 'disabled');
  assert.equal(client.notifications.filter(m => m.method === 'p4/compilerOutput').length, 0);

  configure({enabled: true, path: compiler, entrypoint: 'main.p4', args: ['--warning']});
  const warning = await check(folder);
  assert.equal(warning.status, 'diagnostics');
  assert.equal(warning.errors, 0);
  assert.equal(warning.warnings, 1);
  assert.equal(warning.exitCode, 0);
  const forInclude = msg => msg.method === 'textDocument/publishDiagnostics' && msg.params.uri === uri;
  assert.equal(client.notifications.filter(forInclude).at(-1).params.diagnostics[0].message, 'unused constant');
  configure({args: ['--backend-fail']});
  const failure = await check();
  assert.equal(failure.status, 'failed');
  assert.equal(failure.exitCode, 2);
  const log = client.notifications.filter(m => m.method === 'p4/compilerOutput').at(-1).params;
  assert.equal(log.entrypoint, unit);
  assert.equal(log.exitCode, 2);
  assert.ok(log.output.includes('x'.repeat(2500)));
  assert.match(log.output, /A detailed backend failure/);
  assert.equal(client.notifications.filter(m => m.method === 'window/showMessage').length, 0);

  configure({args: ['--slow-error']});
  const older = check();
  configure({args: []});
  assert.equal((await check()).status, 'ok');
  assert.equal((await older).status, 'superseded');
  assert.ok(client.notifications.some(m => m.method === 'p4/compilerOutput' && m.params.superseded && /superseded problem/.test(m.params.output)));
  assert.deepEqual(client.notifications.filter(forInclude).at(-1).params.diagnostics, []);
  client.notify('exit');
});

test('shared header has one compiler warning across two builds, unrelated edits, and a locationless failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-problems-'));
  const client = new Client();
  t.after(() => { client.proc.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  const source = '#include "switch.p4"\n';
  const included = 'const bit<8> unused = 1;\n';
  const main = path.join(root, 'main.p4');
  const second = path.join(root, 'second.p4');
  const header = path.join(root, 'switch.p4');
  const other = path.join(root, 'other.p4');
  const fake = path.join(root, 'compiler');
  fs.writeFileSync(main, source);
  fs.writeFileSync(second, source);
  fs.writeFileSync(header, included);
  fs.writeFileSync(other, '// unrelated\n');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
if (fs.existsSync('fail')) {
  console.error('switch.p4(1): warning: unused constant');
  console.error('backend failed');
  process.exitCode = 1;
}
`, {mode: 0o755});
  fs.writeFileSync(path.join(root, 'fail'), '');

  const uri = pathToFileURL(main).href;
  const headerUri = pathToFileURL(header).href;
  const secondUri = pathToFileURL(second).href;
  const otherUri = pathToFileURL(other).href;
  await client.request('initialize', {
    rootUri: pathToFileURL(root).href, capabilities: {},
    initializationOptions: {p4: {syntaxDiagnostics: {enabled: false},
      compiler: {enabled: true, path: fake}}},
  });
  client.notify('initialized', {});
  const open = (uri, text) => client.notify('textDocument/didOpen', {textDocument: {uri, text, version: 1, languageId: 'p4'}});
  const save = uri => client.notify('textDocument/didSave', {textDocument: {uri}});
  const headerDiagnostics = msg => msg.method === 'textDocument/publishDiagnostics' && msg.params.uri === headerUri;
  const warning = msg => headerDiagnostics(msg) && msg.params.diagnostics.some(d => d.severity === 2 && d.message === 'unused constant');
  const backendFailure = msg => msg.method === 'window/showMessage' && msg.params.message.includes('backend failed');
  open(uri, source);
  save(uri);
  await client.waitForNotification(warning);
  await client.waitForNotification(backendFailure);

  for (const event of [
    () => open(headerUri, included),
    () => client.notify('textDocument/didClose', {textDocument: {uri: headerUri}}),
    () => client.notify('workspace/didChangeWatchedFiles', {changes: [{uri: otherUri, type: 2}]}),
    () => {
      open(otherUri, '// unrelated\n');
      client.notify('textDocument/didChange', {textDocument: {uri: otherUri, version: 2}, contentChanges: [{text: '// changed'}]});
    },
  ]) {
    event();
    await client.request('textDocument/documentSymbol', {textDocument: {uri}});
    assert.ok(warning(client.notifications.filter(headerDiagnostics).at(-1)));
  }

  open(secondUri, source);
  client.notifications.length = 0;
  save(secondUri);
  await client.waitForNotification(backendFailure);
  assert.equal(client.notifications.filter(headerDiagnostics).at(-1).params.diagnostics.length, 1);

  fs.unlinkSync(path.join(root, 'fail'));
  client.notifications.length = 0;
  save(uri);
  await client.waitForNotification(warning); // The second entrypoint still reports it.
  save(secondUri);
  await client.waitForNotification(msg => headerDiagnostics(msg) && !msg.params.diagnostics.length);
  client.notify('exit');
});

const documentationScenarios = [
  {
    dialect: 'p4-16', suffix: '.p4', callee: 'classify',
    api: '/** Classify a packet.\n * @param mark QoS marker.\n */\naction classify(in bit<16> key, in bit<8> mark) { }\n',
    program: 'control Ingress() { apply { classify(16w7, 8w3); } }\n',
    argument: '8w3', docs: 'Classify a packet', paramDocs: 'QoS marker'
  },
  {
    dialect: 'p4-14', suffix: '.p4_14', callee: 'write_pair',
    api: '/// Write packet metadata.\n/// @param value Replacement value.\nprimitive_action write_pair(field, value);\n',
    program: 'header_type hdr_t { fields { tag : 8; } }\nheader hdr_t h;\naction stamp() { write_pair(h.tag, 17); }\n',
    argument: '17', docs: 'Write packet metadata', paramDocs: 'Replacement value'
  }
];

for (const specimen of documentationScenarios) {
  test(specimen.dialect + ' exposes source docs, signatures and source locations through a transitive include', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-doc-integration-'));
    const client = new Client();
    t.after(() => { client.proc.kill(); fs.rmSync(root, { recursive: true, force: true }); });
    const rootUri = pathToFileURL(root).href;
    const { href: apiUri } = pathToFileURL(path.join(root, 'operations.p4i'));
    const { href: packageUri } = pathToFileURL(path.join(root, 'driver.p4i'));
    const { href: mainUri } = pathToFileURL(path.join(root, 'main' + specimen.suffix));
    const main = '#include "driver.p4i"\n' + specimen.program;
    fs.writeFileSync(path.join(root, 'main' + specimen.suffix), main);
    fs.writeFileSync(path.join(root, 'operations.p4i'), specimen.api);
    fs.writeFileSync(path.join(root, 'driver.p4i'), '#include "operations.p4i"\n');
    fs.writeFileSync(path.join(root, 'another.p4'), '// AuditMarker\n// AuditMarkerLong\n');
    const init = await client.request('initialize', {
      processId: process.pid, rootUri, capabilities: {},
      workspaceFolders: [{ uri: rootUri, name: 'scenario' }],
      initializationOptions: { p4: { compiler: { language: specimen.dialect } } }
    });
    assert.ok(init.capabilities.signatureHelpProvider, 'signature help must be advertised to the editor');
    client.notify('initialized', {});
    const open = (uri, text) => client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'p4', version: 1, text }
    });
    open(mainUri, main);
    const query = (method, needle) => client.request('textDocument/' + method, {
      textDocument: { uri: mainUri }, position: position(main, needle)
    });
    assert.ok(locations(await query('definition', 'driver.p4i')).some(loc => (loc.uri || loc.targetUri) === packageUri));
    assert.ok(locations(await query('definition', specimen.callee)).some(loc => at(loc, apiUri, position(specimen.api, specimen.callee))));
    const hover = JSON.stringify((await query('hover', specimen.callee))?.contents);
    assert.ok(hover?.includes(specimen.docs), hover);
    assert.ok(hover.includes(specimen.paramDocs), hover);
    const help = await query('signatureHelp', specimen.argument);
    assert.equal(help.activeParameter, 1);
    const signature = help.signatures[help.activeSignature ?? 0];
    assert.ok(signature.label.includes(specimen.callee));
    assert.ok(JSON.stringify(signature.parameters[1].documentation).includes(specimen.paramDocs));

    // Load and modify only the declaration buffer. The caller is untouched.
    open(apiUri, specimen.api);
    const changed = specimen.api.replace(specimen.docs, 'AuditMarker');
    client.notify('textDocument/didChange', {
      textDocument: { uri: apiUri, version: 2 }, contentChanges: [{ text: changed }]
    });
    const revised = JSON.stringify((await query('hover', specimen.callee))?.contents);
    assert.ok(revised?.includes('AuditMarker') && !revised.includes(specimen.docs), revised);
    const hits = await client.request('p4/searchText', { uri: mainUri, query: 'AuditMarker' });
    const hitUris = hits.map(hit => hit.location.uri).sort();
    assert.deepEqual(hitUris, [apiUri, pathToFileURL(path.join(root, 'another.p4')).href].sort());
    assert.equal(fs.readFileSync(path.join(root, 'operations.p4i'), 'utf8'), specimen.api);

    await client.request('shutdown', null);
    client.notify('exit');
  });
}

test('type definition, header path repair and indentation use ranges in the current buffer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4fix-'));
  fs.mkdirSync(path.join(root, 'sdk'));
  const headerPath = path.join(root, 'sdk/headers.p4');
  fs.writeFileSync(headerPath, 'struct Metadata { bit<8> port; }\n');
  const file = path.join(root, 'program.p4');
  const source = '#include "bad/headers.p4"\ncontrol C(inout Metadata meta) {\napply { meta.port = 0; }\n}\n';
  fs.writeFileSync(file, source);
  const document = {uri:pathToFileURL(file).href}, header = pathToFileURL(headerPath).href;
  const client = new Client();
  t.after(() => { client.proc.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  await client.request('initialize', { rootUri:pathToFileURL(root).href, capabilities:{} });
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', {textDocument:{...document, text:source, version:1, languageId:'p4'}});
  const atPath = {line:0,character:12};
  const actions = await client.request('textDocument/codeAction', {textDocument:document,
    range:{start:atPath,end:atPath}, context:{diagnostics:[]}});
  const edit = actions[0].edit.changes[document.uri][0];
  assert.equal(edit.newText, '"sdk/headers.p4"');
  assert.deepEqual([edit.range.start.character,edit.range.end.character], [9,25]);
  client.notify('textDocument/didChange',{textDocument:{...document,version:2},
    contentChanges:[{range:edit.range,text:edit.newText}]});
  const decl = await client.request('textDocument/typeDefinition', {textDocument:document,position:{line:2,character:9}});
  assert.equal(decl.uri,header);
  const fmt = await client.request('textDocument/formatting',{textDocument:document,options:{insertSpaces:true,tabSize:4}});
  assert.ok(fmt.some(e=>e.range.start.line===2 && e.newText==='    '));
  await client.request('shutdown', null);
  client.notify('exit');
});

test('editing a macro in an included header moves F12 and semantic tokens to the selected branch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-branch-'));
  const client = new Client();
  t.after(() => { client.proc.kill(); fs.rmSync(root, {recursive:true, force:true}); });
  const uri = pathToFileURL(path.join(root, 'main.p4')).href;
  const config = pathToFileURL(path.join(root, 'platform.p4i')).href;
  fs.writeFileSync(path.join(root,'platform.p4i'), '#define ASIC 1\n');
  const source = '#include "platform.p4i"\n#if ASIC\naction choose(bit<8> port) {}\n#else\naction choose(bit<8> port) {}\n#endif\ncontrol C() { apply { choose(3); } }\n';
  const init = await client.request('initialize',{rootUri:pathToFileURL(root).href,capabilities:{}});
  client.notify('initialized',{});
  client.notify('textDocument/didOpen',{textDocument:{uri,languageId:'p4',version:1,text:source}});
  const use = {textDocument:{uri},position:position(source,'choose',2)};
  async function check(branchLine) {
    const decl = await client.request('textDocument/definition', use);
    assert.equal(decl.range.start.line,branchLine);
    const {data} = await client.request('textDocument/semanticTokens/full',{textDocument:{uri}});
    const types = init.capabilities.semanticTokensProvider.legend.tokenTypes;
    let line = 0, column = 0;
    const matches = [];
    for (let i=0; i<data.length; i+=5) {
      column = data[i] ? data[i+1] : column+data[i+1]; line+=data[i];
      if (source.split('\n')[line].slice(column,column+data[i+2]) === 'choose')
        matches.push([line,types[data[i+3]]]);
    }
    assert.deepEqual(matches,[[branchLine,'function'],[6,'function']]);
    const range = {start:{line:6,character:0}, end:{line:7,character:0}};
    const hints = await client.request('textDocument/inlayHint',{textDocument:{uri},range});
    assert.ok(hints.some(h => h.label === 'port:'));
  }
  await check(2);
  client.notify('textDocument/didOpen',{textDocument:{uri:config,languageId:'p4',version:1,text:'#define ASIC 0\n'}});
  await check(4);
  client.notify('textDocument/didClose',{textDocument:{uri:config}});
  await check(2);
  client.notify('exit');
});

test('bundled SDK navigation and unsaved ANTLR diagnostics reach the client',async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-sdk-'));
  const client = new Client();
  t.after(()=>{client.proc.kill(); fs.rmSync(root,{recursive:true,force:true});});
  const uri = pathToFileURL(path.join(root,'main.p4')).href;
  const source = '#include <core.p4>\ncontrol C(in packet_in pkt) { apply {} }\n';
  await client.request('initialize',{rootUri:pathToFileURL(root).href,capabilities:{}});
  client.notify('initialized',{});
  client.notify('textDocument/didOpen',{textDocument:{uri,languageId:'p4',version:1,text:source}});
  const decl = await client.request('textDocument/definition',{textDocument:{uri},position:position(source,'packet_in')});
  assert.match(decl.uri,/\/p4include\/core\.p4$/);
  client.notify('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text:'header H { bit<8> field }'}]});
  const msg = await client.waitForNotification(n=>n.method==='textDocument/publishDiagnostics' &&
    n.params.uri===uri && n.params.diagnostics.some(d=>d.source==='P4 ANTLR'&&d.message.includes("';'")));
  assert.equal(msg.params.diagnostics[0].range.start.line,0);
  client.notify('exit');
});
