'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const selector = [{ language: 'p4', scheme: 'file' }, { language: 'p4', scheme: 'untitled' }];
// The server chooses the order of its resulting legend in initialize.
const semanticTypes = [
  'type', 'class', 'struct', 'enum', 'enumMember', 'function', 'method', 'parameter',
  'property', 'variable', 'macro', 'decorator', 'typeParameter', 'p4Table', 'p4ParserState'
];
const semanticModifiers = ['declaration', 'readonly', 'defaultLibrary'];
let current;
let output;
let compilerOutput;
let diagnostics;

const pos = p => new vscode.Position(p.line, p.character);
const range = r => new vscode.Range(pos(r.start), pos(r.end));
const point = p => ({ line: p.line, character: p.character });
const uri = u => vscode.Uri.parse(u);
const textDocument = document => ({ uri: document.uri.toString() });
const location = l => l.targetUri
  ? { targetUri: uri(l.targetUri), targetRange: range(l.targetRange), targetSelectionRange: range(l.targetSelectionRange), originSelectionRange: l.originSelectionRange && range(l.originSelectionRange) }
  : new vscode.Location(uri(l.uri), range(l.range));
const locations = xs => !xs ? [] : (Array.isArray(xs) ? xs : [xs]).map(location);

class Rpc {
  constructor(child) {
    this.child = child; this.buffer = Buffer.alloc(0); this.id = 0; this.pending = new Map(); this.disposed = false;
    child.stdout.on('data', chunk => this.read(chunk));
    child.stdin.on('error', error => this.fail(`Language server input error: ${error.message}`));
    child.stderr.on('data', chunk => output.append(chunk.toString()));
    child.on('error', error => this.fail(`Could not start language server: ${error.message}`));
    child.on('exit', (code, signal) => this.fail(`Language server stopped (code ${code}, signal ${signal || 'none'}).`));
  }
  fail(message) {
    if (this.disposed) return;
    this.disposed = true; output.appendLine(message);
    for (const p of this.pending.values()) { p.dispose?.(); p.reject(new Error(message)); }
    this.pending.clear();
  }
  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) { if (this.buffer.length > 65536) this.fail('Invalid language server response header'); return; }
      const header = this.buffer.subarray(0, end).toString('ascii');
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
      if (!match) { this.fail('Language server response missing Content-Length'); return; }
      const len = Number(match[1]);
      if (!Number.isSafeInteger(len) || len > 32 * 1024 * 1024) { this.fail('Invalid language server response size'); return; }
      if (this.buffer.length < end + 4 + len) return;
      const body = this.buffer.subarray(end + 4, end + 4 + len); this.buffer = this.buffer.subarray(end + 4 + len);
      try { this.receive(JSON.parse(body.toString('utf8'))); } catch (e) { output.appendLine(`Invalid server message: ${e.message}`); }
    }
  }
  send(message) {
    if (this.disposed || !this.child.stdin.writable) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); this.child.stdin.write(body);
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params, token) {
    if (this.disposed) return Promise.reject(new Error('Language server is not running'));
    if (token?.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const subscription = token?.onCancellationRequested(() => {
        this.notify('$/cancelRequest', { id });
        const p = this.pending.get(id); if (p) { this.pending.delete(id); p.dispose?.(); reject(new vscode.CancellationError()); }
      });
      this.pending.set(id, { resolve, reject, dispose: () => subscription?.dispose() });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  receive(m) {
    if (m.method && Object.prototype.hasOwnProperty.call(m, 'id')) {
      let result = null;
      if (m.method === 'workspace/configuration') result = (m.params?.items || []).map(item => {
        const config = vscode.workspace.getConfiguration(undefined, item.scopeUri ? uri(item.scopeUri) : undefined);
        if (item.section === 'p4') return settings(item.scopeUri ? uri(item.scopeUri) : undefined).p4;
        if (item.section === 'p4.compiler') return settings(item.scopeUri ? uri(item.scopeUri) : undefined).p4.compiler;
        if (item.section === 'p4.compiler.enabled') return settings(item.scopeUri ? uri(item.scopeUri) : undefined).p4.compiler.enabled;
        return item.section ? config.get(item.section, null) : null;
      });
      else if (m.method === 'workspace/semanticTokens/refresh') this.refreshTokens?.();
      else if (m.method === 'workspace/workspaceFolders') result = workspaceFolders();
      else if (m.method !== 'client/registerCapability' && m.method !== 'client/unregisterCapability' && m.method !== 'window/workDoneProgress/create') {
        this.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Unsupported client request: ${m.method}` } }); return;
      }
      this.send({ jsonrpc: '2.0', id: m.id, result }); return;
    }
    if (m.method === 'textDocument/publishDiagnostics') {
      diagnostics.set(uri(m.params.uri), (m.params.diagnostics || []).map(d => {
        const item = new vscode.Diagnostic(range(d.range), d.message, d.severity ? d.severity - 1 : vscode.DiagnosticSeverity.Error);
        item.source = d.source; item.code = d.code;
        if (d.tags) item.tags = d.tags;
        if (d.relatedInformation) item.relatedInformation = d.relatedInformation.map(i => new vscode.DiagnosticRelatedInformation(location(i.location), i.message));
        return item;
      }));
    } else if (m.method === 'p4/compilerOutput') {
      const run = m.params;
      compilerOutput.appendLine(`[${new Date().toLocaleTimeString()}] ${run.source} — ${run.entrypoint}`);
      if (run.output) {
        compilerOutput.append(run.output);
        if (!run.output.endsWith('\n')) compilerOutput.appendLine('');
      }
      if (run.error) compilerOutput.appendLine(run.error);
      compilerOutput.appendLine(`Exit code: ${run.exitCode ?? 'unavailable'}${run.superseded ? ' (superseded)' : ''}\n`);
    } else if (m.method === 'window/logMessage') output.appendLine(m.params.message);
    else if (m.method === 'window/showMessage') {
      const fn = m.params.type === 1 ? vscode.window.showErrorMessage : m.params.type === 2 ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      fn(m.params.message);
    } else if (Object.prototype.hasOwnProperty.call(m, 'id')) {
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); p.dispose?.();
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  }
  dispose() {
    if (!this.disposed) {
      this.notify('exit', null); this.child.kill();
      this.fail('Language server stopped.');
    }
  }
}

function workspaceFolders() {
  return vscode.workspace.workspaceFolders?.map(f => ({ uri: f.uri.toString(), name: f.name })) || null;
}
function serverPath(context) {
  const candidates = [path.join(context.extensionPath, 'server', 'src', 'server.js'), path.join(context.extensionPath, 'server', 'server.js'), path.join(context.extensionPath, '..', 'server', 'src', 'server.js'), path.join(context.extensionPath, '..', 'server', 'server.js')];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error(`P4 language server not found. Looked in: ${candidates.join(', ')}`);
  return found;
}
function markdown(value) {
  if (typeof value === 'string') return new vscode.MarkdownString(value);
  if (value?.language && typeof value.value === 'string') return new vscode.MarkdownString().appendCodeblock(value.value, value.language);
  if (value?.kind === 'plaintext') return new vscode.MarkdownString().appendText(value.value);
  return new vscode.MarkdownString(value?.value || '');
}
function symbol(s) {
  const result = new vscode.DocumentSymbol(s.name, s.detail || '', Math.max(0, (s.kind || 13) - 1), range(s.range), range(s.selectionRange));
  if (s.children) result.children = s.children.map(symbol);
  if (s.tags) result.tags = s.tags;
  return result;
}
function symbolInfo(s) {
  const result = new vscode.SymbolInformation(s.name, Math.max(0, (s.kind || 13) - 1), s.containerName || '', location(s.location));
  if (s.tags) result.tags = s.tags;
  return result;
}
function signatureHelp(result) {
  if (!result?.signatures?.length) return undefined;
  const help = new vscode.SignatureHelp();
  help.activeSignature = result.activeSignature ?? 0;
  help.activeParameter = result.activeParameter ?? 0;
  help.signatures = result.signatures.map(s => {
    const signature = new vscode.SignatureInformation(s.label, s.documentation && markdown(s.documentation));
    signature.parameters = (s.parameters || []).map(parameter =>
      new vscode.ParameterInformation(parameter.label, parameter.documentation && markdown(parameter.documentation)));
    if (s.activeParameter !== undefined) signature.activeParameter = s.activeParameter;
    return signature;
  });
  return help;
}

function checkOpenVersion(doc, requestedVersion) {
  if (doc.isClosed || !vscode.workspace.textDocuments.includes(doc)) {
    throw new Error('This P4 file was closed. Reopen it before renaming.');
  }
  if (doc.version !== requestedVersion) {
    throw new Error('This P4 file changed during rename. Retry on the current text.');
  }
}

function localRenameEdit(doc, version, edit) {
  checkOpenVersion(doc, version);
  if (!edit) throw new Error('The server could not rename this symbol.');
  const [change, ...others] = edit.documentChanges || [];
  if (others.length || !change?.textDocument || change.textDocument.uri !== doc.uri.toString()) {
    throw new Error('This rename requires edits outside the current document.');
  }
  if (change.textDocument.version !== version) {
    throw new Error('The P4 server returned edits for a different document version. Retry rename.');
  }
  const result = new vscode.WorkspaceEdit();
  for (const edit of change.edits) result.replace(doc.uri, range(edit.range), edit.newText);
  return result;
}

async function searchText(rpc) {
  const editor = vscode.window.activeTextEditor;
  let query;
  if (editor) {
    const selected = editor.selection.isEmpty
      ? editor.document.getWordRangeAtPosition(editor.selection.active)
      : editor.selection;
    if (selected) query = editor.document.getText(selected);
  }
  if (!query || !/^[A-Za-z_]\w*$/.test(query)) {
    query = await vscode.window.showInputBox({
      prompt: 'Find a P4 identifier in workspace files',
      validateInput: value => /^[A-Za-z_]\w*$/.test(value.trim()) ? undefined : 'Enter a P4 identifier'
    });
  }
  if (!query?.trim()) return;
  query = query.trim();
  const matches = await rpc.request('p4/searchText', { query, uri: editor?.document.uri.toString() });
  if (!matches?.length) {
    await vscode.window.showInformationMessage(`No P4 matches for “${query}”.`);
    return;
  }
  const items = matches.map(match => {
    const target = uri(match.location.uri);
    const selection = range(match.location.range);
    const file = vscode.workspace.asRelativePath(target, true);
    return {
      label: match.name,
      description: `${file}:${selection.start.line + 1}:${selection.start.character + 1}`,
      detail: match.containerName,
      target, selection
    };
  });
  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: `Go to a match for “${query}”`, matchOnDescription: true, matchOnDetail: true
  });
  if (choice) await vscode.window.showTextDocument(choice.target, { selection: choice.selection });
}
function completion(item) {
  const result = new vscode.CompletionItem(item.label, item.kind ? item.kind - 1 : undefined);
  result.detail = item.detail; result.documentation = item.documentation ? markdown(item.documentation) : undefined;
  result.sortText = item.sortText; result.filterText = item.filterText;
  if (item.insertText) result.insertText = item.insertTextFormat === 2 ? new vscode.SnippetString(item.insertText) : item.insertText;
  if (item.textEdit?.range) {
    result.range = range(item.textEdit.range);
    result.insertText = item.insertTextFormat === 2 ? new vscode.SnippetString(item.textEdit.newText) : item.textEdit.newText;
  }
  if (item.additionalTextEdits) result.additionalTextEdits = item.additionalTextEdits.map(e => vscode.TextEdit.replace(range(e.range), e.newText));
  if (item.commitCharacters) result.commitCharacters = item.commitCharacters;
  if (item.preselect !== undefined) result.preselect = item.preselect;
  return result;
}
function settings(scope) {
  const c = vscode.workspace.getConfiguration('p4', scope);
  return { p4: { syntaxDiagnostics: { enabled: c.get('syntaxDiagnostics.enabled', true) }, compiler: {
    enabled: vscode.workspace.isTrusted && c.get('compiler.enabled', false),
    path: c.get('compiler.path', 'p4test'), args: c.get('compiler.args', []),
    language: c.get('compiler.language', 'auto'), includePaths: c.get('compiler.includePaths', []),
    entrypoint: c.get('compiler.entrypoint', ''), timeoutMs: c.get('compiler.timeoutMs', 15000)
  } } };
}

async function checkProject(rpc, manualSaves) {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('P4: Checking with an external compiler requires a trusted workspace.');
    return;
  }
  const active = vscode.window.activeTextEditor?.document;
  let folder, target;
  if (active?.languageId === 'p4') {
    if (active.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('P4: Save the active P4 file to disk before checking it.');
      return;
    }
    target = active.uri;
    folder = vscode.workspace.getWorkspaceFolder(target);
  } else {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length !== 1 || !settings(folders[0].uri).p4.compiler.entrypoint) {
      void vscode.window.showInformationMessage('P4: Open a P4 file, or configure p4.compiler.entrypoint in a single-folder workspace.');
      return;
    }
    folder = folders[0];
    target = folder.uri;
  }
  if (!settings(target).p4.compiler.enabled) {
    void vscode.window.showWarningMessage('P4: Enable p4.compiler.enabled to check the project with your compiler.');
    return;
  }

  const dirtyFiles = () => vscode.workspace.textDocuments.filter(doc => {
    if (!doc.isDirty || doc.languageId !== 'p4' || doc.uri.scheme !== 'file') return false;
    if (!folder) return doc.uri.toString() === target.toString();
    return vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.toString() === folder.uri.toString();
  });
  const modified = dirtyFiles();
  if (modified.length) {
    const count = modified.length;
    const save = 'Save and Check';
    const action = await vscode.window.showWarningMessage(
      `Save ${count} modified P4 file${count === 1 ? '' : 's'} and check the project?`, {modal: true}, save);
    if (action !== save) return;
    for (const doc of modified) {
      if (!doc.isDirty) continue;
      const id = doc.uri.toString();
      manualSaves.add(id);
      try {
        if (!await doc.save()) throw new Error('The file was not saved.');
      } catch (error) {
        manualSaves.delete(id);
        void vscode.window.showErrorMessage(`P4: Could not save ${vscode.workspace.asRelativePath(doc.uri)}. ${error.message}`);
        return;
      }
    }
    if (dirtyFiles().length) {
      void vscode.window.showWarningMessage('P4: Project files changed while saving. Run Check Project again.');
      return;
    }
  }
  const result = await vscode.window.withProgress(
    {location: vscode.ProgressLocation.Window, title: 'P4: Checking project'},
    () => rpc.request('p4/checkProject', {uri: target.toString()}));
  if (result.status === 'failed') {
    const show = 'Show Compiler Output';
    void vscode.window.showErrorMessage('P4: Compiler check failed.', show).then(action => {
      if (action === show) compilerOutput.show(true);
    });
  } else {
    let message;
    if (result.status === 'diagnostics') {
      const {errors, warnings} = result;
      message = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}. See Problems.`;
    } else if (result.status === 'superseded') message = 'Check superseded by a change or newer check.';
    else if (result.status === 'disabled') message = 'Compiler checking is disabled.';
    else message = 'Compiler check passed.';
    vscode.window.setStatusBarMessage(`P4: ${message}`, 8000);
  }
  return result;
}

async function start(context) {
  const child = spawn(process.execPath, [serverPath(context)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const rpc = new Rpc(child);
  const disposables = [];
  const opened = new Set();
  const manualSaves = new Set();
  let ready = false;
  let refreshEmitter, refreshTimer, semanticRevision = 0;

  // VS Code invalidates an edited document automatically. Its includers can
  // change colour too when an SDK declaration is edited, opened or discarded.
  const refreshTokens = () => {
    if (!refreshEmitter) return;
    semanticRevision++;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refreshEmitter.fire();
    }, 150);
  };
  rpc.refreshTokens = refreshTokens;
  disposables.push({ dispose() { clearTimeout(refreshTimer); } });
  const open = document => {
    if (!ready || document.languageId !== 'p4' || !['file', 'untitled'].includes(document.uri.scheme) || opened.has(document.uri.toString())) return;
    opened.add(document.uri.toString());
    rpc.notify('textDocument/didOpen', { textDocument: { uri: document.uri.toString(), languageId: 'p4', version: document.version, text: document.getText() } });
    refreshTokens();
  };
  disposables.push(vscode.workspace.onDidOpenTextDocument(open));
  disposables.push(vscode.workspace.onDidCloseTextDocument(document => {
    manualSaves.delete(document.uri.toString());
    if (opened.delete(document.uri.toString())) {
      rpc.notify('textDocument/didClose', { textDocument: textDocument(document) });
      refreshTokens();
    }
  }));
  disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (opened.has(event.document.uri.toString()) && event.contentChanges?.length) {
      rpc.notify('textDocument/didChange', { textDocument: { ...textDocument(event.document), version: event.document.version }, contentChanges: [{ text: event.document.getText() }] });
      refreshTokens();
    }
  }));
  disposables.push(vscode.workspace.onDidSaveTextDocument(document => {
    // The manual command checks once after all its approved saves.
    if (manualSaves.delete(document.uri.toString())) return;
    if (opened.has(document.uri.toString())) rpc.notify('textDocument/didSave', { textDocument: textDocument(document), text: document.getText() });
  }));
  disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('p4') && ready) {
      rpc.notify('workspace/didChangeConfiguration', { settings: settings() });
      refreshTokens();
    }
  }));
  disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
    if (ready) rpc.notify('workspace/didChangeConfiguration', { settings: settings() });
  }));
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{p4,p4i,p4inc,p4_14,p4_16}');
  const watched = type => file => {
    // Open documents are already synchronized by didChange/didSave. Avoid
    // invalidating a compilation started by the save for the same file.
    if (ready && (type === 3 || !opened.has(file.toString()))) {
      rpc.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: file.toString(), type }] });
      refreshTokens();
    }
  };
  disposables.push(watcher, watcher.onDidCreate(watched(1)), watcher.onDidChange(watched(2)), watcher.onDidDelete(watched(3)));
  disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
    rpc.notify('workspace/didChangeWorkspaceFolders', {
      event: { added: event.added.map(f => ({ uri: f.uri.toString(), name: f.name })), removed: event.removed.map(f => ({ uri: f.uri.toString(), name: f.name })) }
    });
    refreshTokens();
  }));
  let capabilities;
  try {
    const folders = workspaceFolders();
    const init = await rpc.request('initialize', {
      processId: process.pid, clientInfo: { name: 'p4-language-tools', version: require('../package.json').version },
      rootUri: folders?.[0]?.uri || null, workspaceFolders: folders,
      capabilities: { workspace: { semanticTokens: { refreshSupport: true }, configuration: true, workspaceFolders: true, workspaceEdit: { documentChanges: true }, symbol: { dynamicRegistration: false } }, textDocument: {
        semanticTokens: {
          dynamicRegistration: false, requests: { full: true }, formats: ['relative'],
          tokenTypes: semanticTypes, tokenModifiers: semanticModifiers,
          overlappingTokenSupport: false, multilineTokenSupport: false
        },
        synchronization: { didSave: true, dynamicRegistration: false },
        inlayHint: { dynamicRegistration: false },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'],
          parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
        completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } },
        definition: { linkSupport: true }, typeDefinition: { linkSupport: true },
        rename: { prepareSupport: true }, publishDiagnostics: { relatedInformation: true }
      }, general: { positionEncodings: ['utf-16'] } }
    });
    capabilities = init?.capabilities || {}; rpc.notify('initialized', {}); ready = true;
    rpc.notify('workspace/didChangeConfiguration', { settings: settings() });
    vscode.workspace.textDocuments.forEach(open);
  } catch (e) { disposables.forEach(d => d.dispose()); rpc.dispose(); throw e; }
  const at = (method, doc, position, token, extra = {}) => rpc.request(method, { textDocument: textDocument(doc), position: point(position), ...extra }, token);
  disposables.push(vscode.commands.registerCommand('p4.searchText', () => searchText(rpc)));
  disposables.push(vscode.commands.registerCommand('p4.checkProject', () => checkProject(rpc, manualSaves)));
  const semantic = capabilities.semanticTokensProvider;
  if (semantic?.full && Array.isArray(semantic.legend?.tokenTypes) && Array.isArray(semantic.legend?.tokenModifiers)) {
    const legend = new vscode.SemanticTokensLegend(semantic.legend.tokenTypes, semantic.legend.tokenModifiers);
    refreshEmitter = new vscode.EventEmitter();
    disposables.push(refreshEmitter, vscode.languages.registerDocumentSemanticTokensProvider(selector, {
      onDidChangeSemanticTokens: refreshEmitter.event,
      async provideDocumentSemanticTokens(doc, token) {
        const version = doc.version, revision = semanticRevision;
        const result = await rpc.request('textDocument/semanticTokens/full', { textDocument: textDocument(doc) }, token);
        if (doc.isClosed || doc.version !== version || revision !== semanticRevision || !result) return;
        return new vscode.SemanticTokens(Uint32Array.from(result.data), result.resultId);
      }
    }, legend));
  }
  if (capabilities.inlayHintProvider) {
    disposables.push(vscode.languages.registerInlayHintsProvider(selector, {
      // Type or signature changes in another file can also invalidate parameter hints.
      onDidChangeInlayHints: refreshEmitter?.event,
      async provideInlayHints(doc, visibleRange, token) {
        const version = doc.version, revision = semanticRevision;
        const hints = await rpc.request('textDocument/inlayHint', {
          textDocument: textDocument(doc),
          range: { start: point(visibleRange.start), end: point(visibleRange.end) }
        }, token);
        if (doc.isClosed || doc.version !== version || revision !== semanticRevision) return;
        return (hints || []).map(h => {
          const hint = new vscode.InlayHint(pos(h.position), h.label, h.kind);
          hint.paddingLeft = h.paddingLeft;
          hint.paddingRight = h.paddingRight;
          return hint;
        });
      }
    }));
  }
  if (capabilities.signatureHelpProvider) {
    disposables.push(vscode.languages.registerSignatureHelpProvider(selector, {
      provideSignatureHelp: async (doc, position, token) =>
        signatureHelp(await at('textDocument/signatureHelp', doc, position, token))
    }, {
      triggerCharacters: capabilities.signatureHelpProvider.triggerCharacters || [],
      retriggerCharacters: capabilities.signatureHelpProvider.retriggerCharacters || []
    }));
  }
  if (capabilities.definitionProvider) disposables.push(vscode.languages.registerDefinitionProvider(selector, { provideDefinition: async (d, p, t) => locations(await at('textDocument/definition', d, p, t)) }));
  if (capabilities.typeDefinitionProvider) disposables.push(vscode.languages.registerTypeDefinitionProvider(selector, {
    provideTypeDefinition: async (doc, position, token) =>
      locations(await at('textDocument/typeDefinition', doc, position, token))
  }));
  if (capabilities.renameProvider) {
    const provider = {
      async provideRenameEdits(doc, position, newName, token) {
        const version = doc.version;
        const edit = await at('textDocument/rename', doc, position, token, { newName });
        return localRenameEdit(doc, version, edit);
      }
    };
    if (capabilities.renameProvider.prepareProvider) {
      provider.prepareRename = async (doc, position, token) => {
        const version = doc.version;
        const result = await at('textDocument/prepareRename', doc, position, token);
        checkOpenVersion(doc, version);
        if (!result) throw new Error('The P4 server cannot rename this symbol.');
        return result.range ? { range: range(result.range), placeholder: result.placeholder } : range(result);
      };
    }
    disposables.push(vscode.languages.registerRenameProvider(selector, provider));
  }
  if (capabilities.documentFormattingProvider) disposables.push(vscode.languages.registerDocumentFormattingEditProvider(selector, {
    async provideDocumentFormattingEdits(doc, options, token) {
      const version = doc.version;
      const edits = await rpc.request('textDocument/formatting', {
        textDocument: textDocument(doc), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces }
      }, token);
      if (doc.isClosed || doc.version !== version) return [];
      return (edits || []).map(edit => vscode.TextEdit.replace(range(edit.range), edit.newText));
    }
  }));
  if (capabilities.codeActionProvider) {
    const quickFix = vscode.CodeActionKind.QuickFix;
    disposables.push(vscode.languages.registerCodeActionsProvider(selector, {
      async provideCodeActions(doc, selection, context, token) {
        if (context.only && !context.only.contains(quickFix)) return [];
        const version = doc.version;
        const lspRange = item => ({ start: point(item.start), end: point(item.end) });
        const actions = await rpc.request('textDocument/codeAction', {
          textDocument: textDocument(doc), range: lspRange(selection),
          context: { only: ['quickfix'], diagnostics: context.diagnostics.map(d => ({
            range: lspRange(d.range), message: d.message, severity: d.severity + 1, source: d.source,
            code: typeof d.code === 'object' ? d.code?.value : d.code
          })) }
        }, token);
        if (doc.isClosed || version !== doc.version) return [];
        const result = [];
        for (const action of actions || []) {
          const changes = Object.entries(action.edit?.changes || {});
          if (action.kind !== 'quickfix' || changes.length !== 1 || changes[0][0] !== doc.uri.toString()) continue;
          const converted = new vscode.CodeAction(action.title, quickFix);
          converted.edit = new vscode.WorkspaceEdit();
          for (const change of changes[0][1]) converted.edit.replace(doc.uri, range(change.range), change.newText);
          result.push(converted);
        }
        return result;
      }
    }, { providedCodeActionKinds: [quickFix] }));
  }
  if (capabilities.referencesProvider) disposables.push(vscode.languages.registerReferenceProvider(selector, { provideReferences: async (d, p, c, t) => locations(await at('textDocument/references', d, p, t, { context: { includeDeclaration: c.includeDeclaration } })) }));
  if (capabilities.hoverProvider) disposables.push(vscode.languages.registerHoverProvider(selector, { provideHover: async (d, p, t) => {
    const r = await at('textDocument/hover', d, p, t); return r ? new vscode.Hover((Array.isArray(r.contents) ? r.contents : [r.contents]).map(markdown), r.range && range(r.range)) : null;
  } }));
  if (capabilities.completionProvider) disposables.push(vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems: async (d, p, t, c) => {
    const result = await at('textDocument/completion', d, p, t, { context: { triggerKind: c.triggerKind, triggerCharacter: c.triggerCharacter } });
    return new vscode.CompletionList((Array.isArray(result) ? result : result?.items || []).map(completion), result?.isIncomplete || false);
  } }, ...(capabilities.completionProvider.triggerCharacters || [])));
  if (capabilities.documentSymbolProvider) disposables.push(vscode.languages.registerDocumentSymbolProvider(selector, { provideDocumentSymbols: async (d, t) => (await rpc.request('textDocument/documentSymbol', { textDocument: textDocument(d) }, t) || []).map(s => s.location ? symbolInfo(s) : symbol(s)) }));
  if (capabilities.workspaceSymbolProvider) disposables.push(vscode.languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: async (query, t) => (await rpc.request('workspace/symbol', { query }, t) || []).filter(s => s.location?.range).map(symbolInfo) }));
  if (capabilities.documentHighlightProvider) disposables.push(vscode.languages.registerDocumentHighlightProvider(selector, { provideDocumentHighlights: async (d, p, t) => (await at('textDocument/documentHighlight', d, p, t) || []).map(h => new vscode.DocumentHighlight(range(h.range), h.kind ? h.kind - 1 : undefined)) }));
  if (capabilities.foldingRangeProvider) disposables.push(vscode.languages.registerFoldingRangeProvider(selector, { provideFoldingRanges: async (d, _context, t) => (await rpc.request('textDocument/foldingRange', { textDocument: textDocument(d) }, t) || []).map(f => new vscode.FoldingRange(f.startLine, f.endLine, f.kind === 'comment' ? vscode.FoldingRangeKind.Comment : f.kind === 'imports' ? vscode.FoldingRangeKind.Imports : f.kind === 'region' ? vscode.FoldingRangeKind.Region : undefined)) }));
  output.appendLine('P4 language server initialized.');
  return { dispose() { ready = false; disposables.forEach(d => d.dispose()); rpc.dispose(); diagnostics.clear(); } };
}

async function restart(context) {
  current?.dispose(); current = undefined;
  try { current = await start(context); } catch (error) { output.appendLine(error.stack || String(error)); vscode.window.showErrorMessage(`P4 language server: ${error.message}. See P4 output for details.`); }
}
async function activate(context) {
  output = vscode.window.createOutputChannel('P4'); diagnostics = vscode.languages.createDiagnosticCollection('p4');
  compilerOutput = vscode.window.createOutputChannel('P4 Compiler');
  context.subscriptions.push(compilerOutput, vscode.commands.registerCommand('p4.showCompilerOutput', () => compilerOutput.show()));
  context.subscriptions.push(output, diagnostics, vscode.commands.registerCommand('p4.restartServer', () => restart(context)), vscode.commands.registerCommand('p4.showOutput', () => output.show()));
  await restart(context);
}
function deactivate() { current?.dispose(); current = undefined; }
module.exports = { activate, deactivate };
