'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const fakeServer = String.raw`
let buf = Buffer.alloc(0);
let saves = 0;
const send = x => { const s = Buffer.from(JSON.stringify(x)); process.stdout.write('Content-Length: '+s.length+'\r\n\r\n'); process.stdout.write(s); };
process.stdin.on('data', chunk => { buf = Buffer.concat([buf,chunk]); while (true) {
  const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
  const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0,i).toString()); const n = +m[1];
  if (buf.length < i+4+n) return; const msg = JSON.parse(buf.subarray(i+4,i+4+n)); buf = buf.subarray(i+4+n);
  const span = {start:{line:0,character:8},end:{line:0,character:9}};
  if (msg.method === 'textDocument/inlayHint') send({id:msg.id,result:[{position:msg.params.range.start,label:'port:',kind:2,paddingRight:true}]});
  if (msg.method === 'textDocument/semanticTokens/full') send({id:msg.id,result:{data:[0,8,1,1,1],resultId:'s1'}});
  if (msg.method === 'initialize' && msg.params.capabilities.textDocument.semanticTokens.tokenTypes.includes('p4ParserState')) send({jsonrpc:'2.0',id:msg.id,result:{capabilities:{semanticTokensProvider:{legend:{tokenTypes:['macro','class'],tokenModifiers:['declaration']},full:true},hoverProvider:true,inlayHintProvider:true,typeDefinitionProvider:true,documentFormattingProvider:true,codeActionProvider:true,renameProvider:{prepareProvider:true},signatureHelpProvider:{triggerCharacters:['(', ','],retriggerCharacters:[')']}}}});
  if (msg.method === 'textDocument/prepareRename') send({id:msg.id,result:{range:span,placeholder:'X'}});
  if (msg.method === 'textDocument/rename') send({id:msg.id,result:{documentChanges:[{textDocument:{uri:msg.params.textDocument.uri,version:1},edits:[{range:span,newText:msg.params.newName}]}]}});
  if (msg.method === 'textDocument/formatting') send({id:msg.id,result:[{range:span,newText:' '.repeat(msg.params.options.tabSize)}]});
  if (msg.method === 'textDocument/typeDefinition') send({id:msg.id,result:{uri:'file:///types.p4',range:span}});
  if (msg.method === 'textDocument/codeAction') send({id:msg.id,result:[{kind:'quickfix',title:'Use types.p4',edit:{changes:{[msg.params.textDocument.uri]:[{range:span,newText:'types.p4'}]}}}]});
  if (msg.method === 'initialized') send({jsonrpc:'2.0',id:900,method:'workspace/configuration',params:{items:[{section:'p4'}]}});
  if (msg.id === 900 && msg.result) send({jsonrpc:'2.0',method:'window/logMessage',params:{type:3,message:JSON.stringify(msg.result)}});
  if (msg.method === 'workspace/didChangeConfiguration' || msg.method === 'workspace/didChangeWatchedFiles') send({jsonrpc:'2.0',method:'window/logMessage',params:{type:3,message:JSON.stringify({method:msg.method,params:msg.params})}});
  if (msg.method === 'textDocument/hover') send({jsonrpc:'2.0',id:msg.id,result:{contents:{kind:'markdown',value:'**P4**'}}});
  if (msg.method === 'textDocument/signatureHelp') send({jsonrpc:'2.0',id:msg.id,result:{signatures:[{label:'set(x, y)',documentation:{kind:'plaintext',value:'Set fields.'},parameters:[{label:'x'},{label:[7,8],documentation:{kind:'markdown',value:'The **second** field.'}}]}],activeSignature:0,activeParameter:1}});
  if (msg.method === 'p4/searchText') send({jsonrpc:'2.0',id:msg.id,result:msg.params.query === 'X' && msg.params.uri === 'file:///main.p4' ? [{name:'X',containerName:'control X',location:{uri:'file:///include/controls.p4',range:{start:{line:2,character:8},end:{line:2,character:9}}}}] : []});
  if (msg.method === 'textDocument/didSave') ++saves;
  if (msg.method === 'p4/checkProject') {
    const name = msg.params.uri;
    const failed = name.endsWith('/broken.p4');
    send({method:'p4/compilerOutput',params:{entrypoint:name,source:'custom-p4test',output:'frontend stage\nbackend stage',exitCode:failed ? 1 : 0,error:failed ? 'unknown target' : null}});
    const warnings = !failed && name.endsWith('.p4') ? 1 : 0;
    send({id:msg.id,result:{status:failed ? 'failed' : warnings ? 'diagnostics' : 'ok',errors:0,warnings,saves}});
  }
  if (msg.method === 'textDocument/didOpen') send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:msg.params.textDocument.uri,diagnostics:[{message:'example',severity:2,range:{start:{line:0,character:0},end:{line:0,character:3}}}]}});
  if (msg.method === 'exit') process.exit(0);
}});
`;

test('client starts server, opens documents, provides hover, applies diagnostics and restricted settings', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-client-test-'));
  fs.mkdirSync(path.join(root, 'server', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'src', 'server.js'), fakeServer);
  const hooks = {}, providers = {}, commands = {}, logs = [], published = new Map(), opened = [];
  const messages = [], compilerLogs = [], shownChannels = [];
  let answer;
  const disposable = () => ({ dispose() {} });
  const on = name => f => { hooks[name] = f; return disposable(); };
  class Position { constructor(line,character) { this.line=line; this.character=character; } }
  class Range { constructor(start,end) { this.start=start; this.end=end; } }
  class MarkdownString { constructor(value='') { this.value=value; } appendText(v) {this.value+=v;return this;} appendCodeblock(v) {this.value+=v;return this;} }
  class Hover { constructor(contents, range) { this.contents=contents; this.range=range; } }
  class Diagnostic { constructor(range,message,severity) { Object.assign(this,{range,message,severity}); } }
  class Information { constructor(label,documentation) { Object.assign(this,{label,documentation}); } }
  const wordRange = new Range(new Position(0,8), new Position(0,9));
  const document = { languageId:'p4', uri:{scheme:'file',toString:()=> 'file:///main.p4'}, version:1,
    getText:r=>r === wordRange ? 'X' : 'control X {}', getWordRangeAtPosition:()=>wordRange };
  const settings = { 'compiler.enabled': true, 'compiler.path': 'custom-p4test', 'compiler.language':'p4-14', 'compiler.entrypoint':'main.p4' };
  const mock = {
    Position, Range, MarkdownString, Hover, Diagnostic, DiagnosticSeverity:{Error:0},
    ProgressLocation:{Window:10},
    EventEmitter:class {
      listeners = new Set();
      event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
      fire() { for (const fn of this.listeners) fn(); }
      dispose() { this.listeners.clear(); }
    },
    SemanticTokensLegend:class { constructor(tokenTypes,tokenModifiers){ Object.assign(this,{tokenTypes,tokenModifiers}); } },
    SemanticTokens:class { constructor(data,resultId){ Object.assign(this,{data,resultId}); } },
    InlayHint:class { constructor(position,label,kind){Object.assign(this,{position,label,kind});} },
    SignatureHelp:class {}, SignatureInformation:Information, ParameterInformation:Information,
    WorkspaceEdit:class { edits=[]; replace(uri,range,newText) { this.edits.push({uri,range,newText}); } },
    CodeAction:class { constructor(title,kind) { Object.assign(this,{title,kind}); } }, CodeActionKind:{QuickFix:'quickfix'},
    TextEdit:{replace:(range,newText)=>({range,newText})}, Location:class {constructor(uri,range){ Object.assign(this,{uri,range}); }},
    Uri:{parse:s=>({scheme:s.split(':')[0],toString:()=>s})},
    workspace:{isTrusted:false,workspaceFolders:[],textDocuments:[document],
      asRelativePath:u=>u.toString().replace('file:///', ''),
      getWorkspaceFolder:u=>mock.workspace.workspaceFolders.find(f => u.toString().startsWith(f.uri.toString() + '/')),
      getConfiguration: section => ({ get:(k,def)=>section==='p4' ? (settings[k] ?? def) : def }),
      onDidOpenTextDocument:on('open'),onDidCloseTextDocument:on('close'),onDidChangeTextDocument:on('change'),onDidSaveTextDocument:on('save'),
      onDidChangeConfiguration:on('config'),onDidGrantWorkspaceTrust:on('trust'),onDidChangeWorkspaceFolders:on('folders'),
      createFileSystemWatcher:()=>({dispose(){},onDidCreate:on('created'),onDidChange:on('changed'),onDidDelete:on('deleted')})},
    window:{createOutputChannel:name=>{
        const lines = name === 'P4 Compiler' ? compilerLogs : logs;
        return {append:s=>lines.push(s),appendLine:s=>lines.push(s),show:()=>shownChannels.push(name),dispose(){}};
      },
      showErrorMessage:async s=>{messages.push(s);return answer;},
      showWarningMessage:async s=>{messages.push(s);return answer;},
      showInformationMessage:async s=>{messages.push(s);},
      withProgress:(_,run)=>run(),setStatusBarMessage:s=>messages.push(s),
      activeTextEditor:{document,selection:{isEmpty:true,active:new Position(0,8)}},
      showQuickPick:async items=>{assert.equal(items[0].description,'include/controls.p4:3:9');return items[0];},
      showTextDocument:(u,opts)=>opened.push({uri:u.toString(),options:opts})},
    languages:{createDiagnosticCollection:()=>({set:(u,d)=>published.set(u.toString(),d),delete:u=>published.delete(u.toString()),clear:()=>published.clear(),dispose(){}}),
      registerDocumentSemanticTokensProvider:(_selector,provider,legend)=>{providers.semantic=provider;providers.legend=legend;return disposable();},
      registerInlayHintsProvider:(_selector,p)=>{providers.inlay=p;return disposable();},
      registerHoverProvider:(_selector,p)=>{providers.hover=p;return disposable();},
      registerRenameProvider:(_selector,p)=>{providers.rename=p;return disposable();},
      registerTypeDefinitionProvider:(_selector,p)=>{providers.type=p;return disposable();},
      registerDocumentFormattingEditProvider:(_selector,p)=>{providers.format=p;return disposable();},
      registerCodeActionsProvider:(_selector,p)=>{providers.actions=p;return disposable();},
      registerSignatureHelpProvider:(_selector,p,metadata)=>{providers.sig=p;providers.sigMetadata=metadata;return disposable();}},
    commands:{registerCommand:(name,cmd)=>{commands[name]=cmd;return disposable();}}
  };
  const load = Module._load;
  Module._load = function(request, parent, isMain) { if (request==='vscode') return mock; return load.call(this,request,parent,isMain); };
  let ext;
  try { ext = require('../src/extension'); } finally { Module._load = load; }
  try {
    await ext.activate({extensionPath:root,subscriptions:[]});
    assert.deepEqual(providers.legend.tokenTypes, ['macro','class']); // negotiated order
    const colors = await providers.semantic.provideDocumentSemanticTokens(document);
    assert.deepEqual(colors.data, new Uint32Array([0,8,1,1,1]));
    assert.equal(colors.resultId,'s1');
    // A change in a closed P4 header invalidates the visible document.
    const refreshed = new Promise((resolve,reject) => {
      const timeout=setTimeout(()=>reject(new Error('No semantic token refresh')),2000);
      const subscription=providers.semantic.onDidChangeSemanticTokens(()=>{
        clearTimeout(timeout); subscription.dispose(); resolve();
      });
    });
    hooks.changed({toString:()=> 'file:///include/types.p4'});
    await refreshed;
    const [hint] = await providers.inlay.provideInlayHints(document,wordRange);
    assert.equal(hint.label,'port:');
    assert.deepEqual(hint.position,wordRange.start);
    assert.equal(hint.kind,2);
    assert.equal(hint.paddingRight,true);
    assert.ok(providers.hover);
    const hover = await providers.hover.provideHover(document,new Position(0,2));
    assert.equal(hover.contents[0].value,'**P4**');
    assert.deepEqual(providers.sigMetadata,{triggerCharacters:['(', ','],retriggerCharacters:[')']});
    const help = await providers.sig.provideSignatureHelp(document,new Position(0,8));
    assert.equal(help.signatures[0].documentation.value,'Set fields.');
    assert.deepEqual(help.signatures[0].parameters[1].label,[7,8]);
    assert.equal(help.signatures[0].parameters[1].documentation.value,'The **second** field.');
    assert.equal(help.activeParameter,1);
    await commands['p4.searchText']();
    assert.equal(opened[0].uri,'file:///include/controls.p4');
    assert.deepEqual(opened[0].options.selection.start,new Position(2,8));
    const cursor = new Position(0,8);
    assert.equal((await providers.rename.prepareRename(document,cursor)).placeholder,'X');
    const edit = await providers.rename.provideRenameEdits(document,cursor,'Y');
    assert.equal(edit.edits[0].newText,'Y');
    assert.deepEqual(edit.edits[0].range.start,cursor);
    document.version = 2;
    await assert.rejects(providers.rename.provideRenameEdits(document,cursor,'Y'),/version/);
    document.version = 1;
    const [type] = await providers.type.provideTypeDefinition(document,cursor);
    assert.equal(type.uri.toString(),'file:///types.p4');
    const [format] = await providers.format.provideDocumentFormattingEdits(document,{tabSize:3,insertSpaces:true});
    assert.equal(format.newText,'   ');
    const [fix] = await providers.actions.provideCodeActions(document,wordRange,{diagnostics:[]});
    assert.equal(fix.title,'Use types.p4');
    assert.equal(fix.edit.edits[0].newText,'types.p4');
    const end = Date.now()+2000;
    while ((!published.size || !logs.some(s=>s.includes('custom-p4test'))) && Date.now()<end) await new Promise(r=>setTimeout(r,10));
    assert.equal(published.get('file:///main.p4')[0].severity,1);
    const result = JSON.parse(logs.find(s=>s.startsWith('[{')));
    assert.equal(result[0].compiler.enabled,false);
    assert.equal(result[0].compiler.path,'custom-p4test');
    assert.equal(result[0].compiler.entrypoint,'main.p4');
    assert.equal(result[0].compiler.timeoutMs,15000);
    assert.equal(await commands['p4.checkProject'](),undefined);
    assert.match(messages.at(-1), /trusted workspace/);
    mock.workspace.isTrusted = true;
    hooks.trust();
    hooks.created({toString:()=> 'file:///new.p4'});
    hooks.created(document.uri); // first save of an open file
    hooks.changed({toString:()=> 'file:///main.p4'}); // open document, skip duplicate watcher event
    const deadline = Date.now()+2000;
    while ((!logs.some(s=>s.includes('file:///new.p4')) || !logs.some(s=>s.includes('\"enabled\":true'))) && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
    assert.ok(logs.some(s=>s.includes('file:///new.p4')));
    assert.ok(logs.some(s=>s.includes('\"enabled\":true')));
    assert.ok(!logs.some(s=>s.includes('didChangeWatchedFiles') && s.includes('file:///main.p4')));
    await t.test('checks saved and modified P4 files once with a separate compiler log', async () => {
      const check = commands['p4.checkProject'];
      const root = {uri:mock.Uri.parse('file:///project'),name:'project'};
      mock.workspace.workspaceFolders = [root];
      const active = mock.window.activeTextEditor;
      mock.window.activeTextEditor = undefined;

      const include = {uri:mock.Uri.parse('file:///project/include.p4'),languageId:'p4',version:1,isDirty:true,getText:()=>''};
      const main = {...include, uri:mock.Uri.parse('file:///project/main.p4')};
      main.save = async () => { main.isDirty = false; hooks.save(main); return true; };
      const other = {uri:mock.Uri.parse('file:///other.p4'),languageId:'p4',isDirty:true,save:()=>assert.fail('saved unrelated document')};
      mock.workspace.textDocuments.push(include,main,other);
      hooks.open(include);
      hooks.open(main);
      let saveAttempts = 0;
      include.save = async () => { saveAttempts++; return false; };
      settings['compiler.enabled'] = false;
      assert.equal(await check(), undefined);
      assert.match(messages.at(-1), /p4.compiler.enabled/);
      settings['compiler.enabled'] = true;
      assert.equal(await check(), undefined);
      assert.match(messages.at(-1), /2 modified P4 files/);
      assert.equal(saveAttempts, 0);
      answer = 'Save and Check';
      assert.equal(await check(), undefined);
      assert.equal(saveAttempts, 1);
      assert.match(messages.at(-1), /Could not save project\/include.p4/);
      include.save = async () => { include.isDirty = false; hooks.save(include); return true; };
      assert.deepEqual(await check(), {status:'ok',errors:0,warnings:0,saves:0});
      assert.match(messages.at(-1), /passed/);
      assert.ok(compilerLogs[0].includes('file:///project'));
      assert.ok(compilerLogs.includes('frontend stage\nbackend stage'));
      assert.ok(compilerLogs.some(s => s.startsWith('Exit code: 0')));
      assert.ok(!logs.includes('frontend stage\nbackend stage'));
      commands['p4.showCompilerOutput']();
      assert.equal(shownChannels.at(-1),'P4 Compiler');

      // A later ordinary save of this document must reach the server.
      hooks.save(include);
      mock.window.activeTextEditor = active;
      assert.equal((await check()).saves,1);
      assert.match(messages.at(-1), /0 errors, 1 warning/);
      answer = 'Show Compiler Output';
      mock.window.activeTextEditor = {document:{languageId:'p4',uri:mock.Uri.parse('file:///broken.p4')}};
      assert.equal((await check()).status,'failed');
      assert.match(messages.at(-1), /Compiler check failed/);
      assert.ok(compilerLogs.includes('unknown target'));
      assert.ok(compilerLogs.some(s => s.startsWith('Exit code: 1')));
      assert.equal(shownChannels.length,2);
      mock.window.activeTextEditor = active;
    });
    hooks.close(document);
    assert.equal(published.get('file:///main.p4')[0].severity,1);
  } finally { ext.deactivate(); fs.rmSync(root,{recursive:true,force:true}); }
});
