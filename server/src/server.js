#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { Rpc } = require('./rpc');
const { identifier, positionAt, KEYWORDS, indexDocument, findTokenAt, resolve, offsetAt } = require('./indexer');
const { directives, pathsFor } = require('./includes');
const { signatureHelp, callableTargets, declarationSignatures } = require('./signatures');
const { declarationDocs, docsMarkdown } = require('./docs');
const { memberTarget, memberCompletions, typeTarget, builtinInfo, builtinMembers } = require('./members');
const { prepareRename, rename } = require('./rename');
const { formatDocument } = require('./format');
const { searchText } = require('./search');
const { macroAt } = require('./macros');
const { enumMember, enumCompletions } = require('./enum');
const { inlayHints } = require('./inlay');
const { legend, semanticTokens } = require('./semantic');
const { preprocess } = require('./preprocess');
const { liveDiagnostics } = require('./liveDiagnostics');
const { SyntaxService } = require('./parserService');
const { dialect } = require('./dialect');
const { runCompiler } = require('../compiler');
const { applyTypoFix } = require('./compilerFix');

// The client terminates this process on restart; make normal termination run
// exit hooks so detached compiler process groups are stopped as well.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

const documents = new Map();
const roots = new Set();
const compiledByUnit = new Map();
const liveByUri = new Map();
const parsedByUri = new Map();
const parser = new SyntaxService({onError: message => process.stderr.write('p4 syntax: ' + message + '\n')});
const bundledIncludes = path.resolve(__dirname, '../p4include');
const fallbackHeaders = new Set(['core.p4', 'v1model.p4', 'psa.p4', 'pna.p4']);
let settings = { compiler: { enabled: false, path: 'p4test', args: [], includePaths: [], language: 'auto' } };
let shutdown = false;
let clientCanConfigure = false;
let workspaceScanned = false;

function filePath(uri) { try { return fileURLToPath(uri); } catch { return null; } }
function toUri(filename) { return pathToFileURL(filename).href; }
function readSource(uri) {
  const cached = documents.get(uri);
  if (cached) return cached.text;
  const file = filePath(uri);
  if (!file) return undefined;
  try {
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.size <= 2 * 1024 * 1024) return fs.readFileSync(file, 'utf8');
  } catch { /* Missing and unreadable includes are diagnosed by the caller. */ }
}
function rebuildIndex(doc) {
  const paths = new Set();
  const dirs = includeDirectories(doc);
  const contents = new Map();
  doc.cpp = preprocess(doc.text, settings.compiler.args, {source: doc.uri, readInclude(include) {
    const parent = filePath(include.source);
    if (!parent) return;
    for (const candidate of includeCandidates(include, parent, dirs, doc)) {
      const uri = toUri(candidate);
      paths.add(uri);
      if (!contents.has(uri)) contents.set(uri, readSource(uri));
      const text = contents.get(uri);
      if (typeof text === 'string') return {id: uri, text};
    }
  }});
  doc.headerPaths = paths;
  doc.activeText = doc.cpp.text;
  doc.index = indexDocument(doc.activeText, doc.uri);
}
function document(uri) {
  if (documents.has(uri)) return documents.get(uri);
  const text = readSource(uri);
  if (text === undefined) return undefined;
  const doc = {uri, text, version: null, open: false};
  rebuildIndex(doc);
  documents.set(uri, doc);
  return doc;
}
function refreshEditor(doc) {
  if (!doc.open) return;
  const dirs = includeDirectories(doc);
  const diagnostics = liveDiagnostics(doc, {text:doc.activeText, uncertainRanges:doc.cpp.uncertainRanges,
    includePathsConfigured: dirs.length > 0, resolveInclude: d => !!loadInclude(doc, d, dirs)});
  liveByUri.set(doc.uri, [...doc.cpp.diagnostics, ...diagnostics]);
  parsedByUri.delete(doc.uri);
  const enabled = settings.syntaxDiagnostics?.enabled !== false;
  if (enabled && !doc.cpp.diagnostics.length && dialect(doc, settings.compiler.language) === 'p4-16' &&
      !doc.cpp.uncertainRanges.length && !diagnostics.some(d => d.severity === 1)) {
    const snapshot = doc.index;
    // Conditions have a single known branch here. Blank only their physical
    // directive lines before ANTLR; includes/other macros keep their own policy.
    const parts = [];
    let start = 0;
    for (const range of doc.cpp.conditionals) {
      parts.push(doc.activeText.slice(start, range.start),
        doc.activeText.slice(range.start, range.end).replace(/[^\r\n]/g, ' '));
      start = range.end;
    }
    const text = parts.length ? parts.join('') + doc.activeText.slice(start) : doc.activeText;
    parser.enqueue(doc.uri, text, errors => {
      if (documents.get(doc.uri)?.index !== snapshot) return;
      parsedByUri.set(doc.uri, errors);
      publishAllDiagnostics();
    });
  } else parser.cancel(doc.uri);
}
function refreshDependents(uris) {
  for (const other of documents.values()) {
    if (!uris.some(uri => other.uri !== uri && other.headerPaths.has(uri))) continue;
    rebuildIndex(other);
    refreshEditor(other);
  }
}
function changeDocument(doc, changes) {
  for (const change of changes || []) {
    if (!change.range) doc.text = change.text;
    else {
      const start = offsetAt(doc.text, change.range.start), end = offsetAt(doc.text, change.range.end);
      doc.text = doc.text.slice(0, start) + change.text + doc.text.slice(end);
    }
  }
  rebuildIndex(doc);
}
function scanWorkspace() {
  if (workspaceScanned) return;
  workspaceScanned = true;
  let remaining = 5000;
  const excluded = new Set(['.git', 'node_modules', 'build', 'dist', '.cache', '.vscode-test']);
  function walk(dir) {
    if (remaining <= 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (remaining <= 0) break;
      if (entry.name.startsWith('.') || excluded.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(?:p4|p4_14|p4_16|p4inc|p4i)$/i.test(entry.name)) {
        --remaining;
        document(toUri(full));
      }
    }
  }
  for (const root of roots) walk(root);
}
function workspaceRoot(filename, fallback = roots.values().next().value) {
  return [...roots].filter(root => root === filename || filename?.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
    .sort((left, right) => right.length - left.length)[0] || fallback;
}
function includeDirectories(doc) {
  const root = workspaceRoot(filePath(doc.uri)) || process.cwd();
  const configured = settings.compiler?.includePaths || [];
  return configured.filter(p => typeof p === 'string').map(p => path.resolve(root, p));
}
function includeCandidates(directive, parent, dirs, doc) {
  const candidates = pathsFor(directive, parent, dirs);
  const legacy = settings.compiler.language === 'p4-14' || /\.p4_14$/i.test(doc.uri) ||
    (doc.index && dialect(doc, settings.compiler.language) === 'p4-14');
  if (!legacy && fallbackHeaders.has(directive.name)) candidates.push(path.join(bundledIncludes, directive.name));
  return candidates;
}
function loadInclude(doc, directive, dirs) {
  const sourcePath = filePath(doc.uri);
  if (!sourcePath) return undefined;
  for (const candidate of includeCandidates(directive, sourcePath, dirs, doc)) {
    const dep = document(toUri(candidate));
    if (dep) return dep;
  }
}
function includedDocuments(doc) {
  if (requestGraph.has(doc)) return requestGraph.get(doc);
  const dirs = includeDirectories(doc), seen = new Set([doc.uri]), pending = [doc], found = [];
  while (pending.length && found.length < 5000) {
    const current = pending.pop();
    for (const directive of directives(current)) {
      const child = loadInclude(current, directive, dirs);
      if (!child || seen.has(child.uri)) continue;
      seen.add(child.uri);
      found.push(child);
      pending.push(child);
    }
  }
  requestGraph.set(doc, found);
  return found;
}
let requestGraph = new Map();
function globalCandidates(name, doc) {
  const result = [];
  for (const dependency of includedDocuments(doc)) for (const declaration of dependency.index.declarations)
    if (declaration.name === name && declaration.scope === 0) result.push({ doc: dependency, declaration });
  return result;
}
function resolveTarget(doc, token) {
  if (!token) return undefined;
  if (doc.index.tokens[token.index - 1]?.text === '.') {
    const deps = includedDocuments(doc);
    return enumMember(doc, token, deps) || memberTarget(doc, token, [doc, ...deps]);
  }
  if (!identifier(token)) return undefined;
  const found = resolve(doc.index, token);
  if (found) return { doc, declaration: found };
  // Multiple declarations, even in different scopes, must not fall through to
  // a workspace-wide guess when the local resolver reported ambiguity.
  let scope = token.scope;
  while (scope !== null) {
    if (doc.index.declarations.some(d => d.name === token.text && d.scope === scope)) return undefined;
    scope = doc.index.scopes[scope].parent;
  }
  const candidates = globalCandidates(token.text, doc);
  return candidates.length === 1 ? candidates[0] : undefined;
}
function location(target) { return { uri: target.doc.uri, range: target.declaration.token.range }; }
function resultsFor(target, includeDeclaration) {
  const out = [];
  const workspace = target.declaration.scope === 0 || target.declaration.isMember;
  for (const doc of documents.values()) {
    if (!workspace && doc !== target.doc) continue;
    for (const tok of doc.index.tokens) {
      if (tok.text !== target.declaration.name) continue;
      const actual = resolveTarget(doc, tok);
      if (actual?.doc === target.doc && actual.declaration === target.declaration) {
        if (!includeDeclaration && tok === target.declaration.token) continue;
        out.push({ uri: doc.uri, range: tok.range });
      }
    }
  }
  return out;
}
function publishAllDiagnostics() {
  const grouped = new Map();
  for (const [uri, items] of liveByUri) {
    const current = [...items, ...(parsedByUri.get(uri) || [])];
    if (current.length) grouped.set(uri, current);
  }
  // Separate entrypoints can report the same diagnostic in a shared header.
  const publishedCompilerDiagnostics = new Set();
  for (const {diagnostics} of compiledByUnit.values()) for (const diagnostic of diagnostics) {
    const key = JSON.stringify(diagnostic);
    if (publishedCompilerDiagnostics.has(key)) continue;
    publishedCompilerDiagnostics.add(key);
    const { uri, ...item } = diagnostic;
    if (!grouped.has(uri)) grouped.set(uri, []);
    grouped.get(uri).push(item);
  }
  for (const uri of publishedUris) if (!grouped.has(uri)) rpc.notify('textDocument/publishDiagnostics', { uri, diagnostics: [] });
  for (const [uri, diagnostics] of grouped) rpc.notify('textDocument/publishDiagnostics', { uri, diagnostics });
  publishedUris = new Set(grouped.keys());
}
let publishedUris = new Set();
function invalidateCompilations(changedUris) {
  const changed = new Set(changedUris);
  for (const [unit, build] of compiledByUnit) {
    if (changedUris.some(uri => build.inputs.has(uri)) || build.diagnostics.some(d => changed.has(d.uri))) {
      compiledByUnit.delete(unit);
    }
  }
}
async function compile(uri, manual = false) {
  const config = settings.compiler || {};
  if (!config.enabled) return {status: 'disabled'};
  const savedFile = filePath(uri);
  if (!savedFile) return {status: 'failed', error: 'The compiler needs a local P4 file.'};
  const folder = workspaceRoot(savedFile, manual ? null : roots.values().next().value);
  const root = folder || path.dirname(savedFile);
  const configuredEntry = (folder || !roots.size) && typeof config.entrypoint === 'string' && config.entrypoint;
  if (roots.has(savedFile) && !configuredEntry) return {status: 'failed', error: 'Select a P4 file or configure p4.compiler.entrypoint.'};
  const file = configuredEntry ? path.resolve(root, configuredEntry) : savedFile;
  const unit = toUri(file);
  const entrypoint = document(unit);
  const build = {
    inputs: new Set([unit, ...(entrypoint?.headerPaths || [])]),
    diagnostics: compiledByUnit.get(unit)?.diagnostics || [],
  };
  compiledByUnit.set(unit, build);
  const standard = dialect(entrypoint || {uri: unit}, config.language);
  const executable = config.path || 'p4test';
  const result = await runCompiler({ entrypoint: file, cwd: root, executable, standard,
    includePaths: Array.isArray(config.includePaths) ? config.includePaths : [], args: Array.isArray(config.args) ? config.args : [], timeoutMs: config.timeoutMs || 15000 });
  // Never publish diagnostics from an older save or for an edited buffer.
  const superseded = compiledByUnit.get(unit) !== build;
  rpc.notify('p4/compilerOutput', {entrypoint: file, source: executable, output: result.output,
    exitCode: result.exitCode, error: result.error, superseded});
  if (superseded) return {status: 'superseded'};
  // p4test reads disk; avoid showing a disk diagnostic against a dirty buffer.
  build.diagnostics = result.diagnostics.filter(d => {
    const doc = documents.get(d.uri);
    if (!doc?.open) return true;
    try { return fs.readFileSync(filePath(d.uri), 'utf8') === doc.text; } catch { return false; }
  });
  if (!build.diagnostics.length) compiledByUnit.delete(unit);
  publishAllDiagnostics();
  if (result.error && !manual) rpc.notify('window/showMessage', { type: 2, message: `P4 compiler: ${result.error}` });
  const errors = result.diagnostics.filter(d => d.severity === 1).length;
  const warnings = result.diagnostics.filter(d => d.severity === 2).length;
  const status = result.error ? 'failed' : errors || warnings ? 'diagnostics' : 'ok';
  return {status, errors, warnings, error: result.error, exitCode: result.exitCode};
}
function applySettings(value) {
  const config = value?.p4 || value;
  if (!config || typeof config !== 'object') return;
  const previous = JSON.stringify(settings);
  settings = { ...settings, ...config, compiler: { ...settings.compiler, ...(config.compiler || {}) } };
  if (JSON.stringify(settings) === previous) return;
  for (const doc of documents.values()) rebuildIndex(doc);
  for (const doc of documents.values()) refreshEditor(doc);
  compiledByUnit.clear();
  publishAllDiagnostics();
}
async function handle(method, params) {
  requestGraph = new Map();
  switch (method) {
    case 'initialize': {
      clientCanConfigure = !!params.capabilities?.workspace?.configuration;
      for (const folder of params.workspaceFolders || []) { const root = filePath(folder.uri); if (root) roots.add(root); }
      if (!roots.size && params.rootUri) { const root = filePath(params.rootUri); if (root) roots.add(root); }
      if (params.initializationOptions?.p4) applySettings(params.initializationOptions.p4);
      return { capabilities: {
        positionEncoding: 'utf-16', textDocumentSync: { openClose: true, change: 2, save: { includeText: false } },
        semanticTokensProvider: { legend, full: true }, inlayHintProvider: true,
        signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
        renameProvider: { prepareProvider: true }, documentFormattingProvider: true,
        typeDefinitionProvider: true, codeActionProvider: { codeActionKinds: ['quickfix'] },
        definitionProvider: true, referencesProvider: true, hoverProvider: true,
        completionProvider: { resolveProvider: false, triggerCharacters: ['.'] },
        documentSymbolProvider: true, workspaceSymbolProvider: true, documentHighlightProvider: true,
        foldingRangeProvider: true,
        workspace: { workspaceFolders: { supported: true, changeNotifications: true } }
      }, serverInfo: { name: 'p4-language-server', version: '0.3.2' } };
    }
    case 'initialized':
      if (clientCanConfigure) rpc.request('workspace/configuration', { items: [{ section: 'p4' }] }).then(result => applySettings(result?.[0])).catch(() => {});
      return;
    case 'shutdown': shutdown = true; parser.dispose(); return null;
    case 'exit': process.exit(shutdown ? 0 : 1); break;
    case '$/cancelRequest': return;
    case 'workspace/didChangeConfiguration': applySettings(params.settings); return;
    case 'workspace/didChangeWorkspaceFolders':
      workspaceScanned = false;
      for (const folder of params.event?.removed || []) { const root = filePath(folder.uri); if (root) roots.delete(root); }
      for (const folder of params.event?.added || []) { const root = filePath(folder.uri); if (root) roots.add(root); }
      return;
    case 'workspace/didChangeWatchedFiles': {
      const changedUris = (params.changes || []).map(change => change.uri);
      workspaceScanned = false;
      for (const uri of changedUris) if (!documents.get(uri)?.open) documents.delete(uri);
      invalidateCompilations(changedUris);
      refreshDependents(changedUris);
      publishAllDiagnostics();
      return;
    }
    case 'textDocument/didOpen': {
      const { uri, text, version } = params.textDocument;
      const doc = {uri, text, version, open: true};
      documents.set(uri, doc);
      rebuildIndex(doc);
      refreshEditor(doc);
      refreshDependents([uri]);
      publishAllDiagnostics();
      return;
    }
    case 'textDocument/didChange': {
      const doc = documents.get(params.textDocument.uri); if (!doc) return;
      changeDocument(doc, params.contentChanges); doc.version = params.textDocument.version;
      invalidateCompilations([doc.uri]);
      refreshEditor(doc);
      refreshDependents([doc.uri]);
      publishAllDiagnostics();
      return;
    }
    case 'textDocument/didSave': return compile(params.textDocument.uri);
    case 'p4/checkProject': return compile(params.uri, true);
    case 'textDocument/didClose': {
      const doc = documents.get(params.textDocument.uri);
      if (doc) {
        documents.delete(doc.uri); workspaceScanned = false;
        parser.cancel(doc.uri); liveByUri.delete(doc.uri); parsedByUri.delete(doc.uri);
        refreshDependents([doc.uri]); publishAllDiagnostics();
      }
      return;
    }
    case 'textDocument/inlayHint': {
      const doc = document(params.textDocument.uri);
      return doc ? inlayHints(doc, params.range, includedDocuments(doc), dialect(doc, settings.compiler.language)) : [];
    }
    case 'textDocument/semanticTokens/full': {
      const doc = document(params.textDocument.uri);
      if (!doc) return {data: []};
      return semanticTokens(doc, {dependencies: includedDocuments(doc), language: dialect(doc, settings.compiler.language)});
    }
    case 'textDocument/formatting': {
      const doc = document(params.textDocument.uri);
      return doc ? formatDocument(doc.text, params.options) : [];
    }
    case 'textDocument/prepareRename':
    case 'textDocument/rename': {
      const doc = documents.get(params.textDocument.uri);
      if (!doc?.open) return null;
      const deps = includedDocuments(doc);
      const args = settings.compiler.args || [];
      return method === 'textDocument/prepareRename'
        ? prepareRename(doc, params.position, deps, args)
        : rename(doc, params.position, params.newName, deps, args);
    }
    case 'textDocument/typeDefinition': {
      const doc = document(params.textDocument.uri);
      if (!doc) return null;
      const target = resolveTarget(doc, findTokenAt(doc.index, params.position));
      if (!target) return null;
      const type = typeTarget(target.doc, target.declaration, [doc, ...includedDocuments(doc)]);
      return type ? location(type) : null;
    }
    case 'textDocument/codeAction': {
      if (params.context?.only && !params.context.only.includes('quickfix')) return [];
      const doc = documents.get(params.textDocument.uri);
      const source = doc && filePath(doc.uri);
      if (!doc?.open || !source) return [];
      const typo = applyTypoFix(doc, params.range, compiledByUnit.values(), source);
      if (typo) return [typo];
      const line = params.range.start.line;
      const inc = directives(doc).find(d => positionAt(doc.text, d.start).line === line);
      if (!inc || loadInclude(doc, inc, includeDirectories(doc))) return [];
      scanWorkspace();
      const root = workspaceRoot(source), actions = [];
      const range = { start: positionAt(doc.text, inc.start), end: positionAt(doc.text, inc.end) };
      for (const other of documents.values()) {
        const filename = filePath(other.uri);
        if (!filename || !root || !filename.startsWith(root + path.sep) || filename === source ||
            path.basename(filename) !== path.basename(inc.name)) continue;
        const relative = path.relative(path.dirname(source), filename).split(path.sep).join('/');
        if (/["\r\n]/.test(relative)) continue;
        actions.push({title: 'Include "' + relative + '"', kind: 'quickfix', edit: {
          changes: { [doc.uri]: [{ range, newText: '"' + relative + '"' }] }
        }});
      }
      return actions;
    }
    case 'p4/searchText':
      return searchText(params.query, roots, documents.values());
    case 'textDocument/signatureHelp': {
      const doc = document(params.textDocument.uri);
      return doc ? signatureHelp(doc, params.position, includedDocuments(doc), dialect(doc, settings.compiler.language)) : null;
    }
    case 'textDocument/definition': {
      const doc = document(params.textDocument.uri); if (!doc) return null;
      const offset = offsetAt(doc.text, params.position);
      const directive = directives(doc).find(d => offset >= d.start && offset < d.end);
      if (directive) {
        const dependency = loadInclude(doc, directive, includeDirectories(doc));
        const origin = { line: 0, character: 0 };
        return dependency ? { uri: dependency.uri, range: { start: origin, end: origin } } : null;
      }
      const tok = findTokenAt(doc.index, params.position);
      const target = resolveTarget(doc, tok);
      if (target) return location(target);
      const deps = includedDocuments(doc);
      const callables = callableTargets(doc, tok, deps);
      const targets = callables.length ? callables : macroAt(doc, params.position, deps);
      return targets.length ? targets.map(location) : null;
    }
    case 'textDocument/references': {
      const doc = document(params.textDocument.uri); if (!doc) return [];
      scanWorkspace(); const target = resolveTarget(doc, findTokenAt(doc.index, params.position));
      return target ? resultsFor(target, !!params.context?.includeDeclaration) : [];
    }
    case 'textDocument/documentHighlight': {
      const doc = document(params.textDocument.uri); if (!doc) return [];
      scanWorkspace(); const target = resolveTarget(doc, findTokenAt(doc.index, params.position));
      return target ? resultsFor(target, true).filter(x => x.uri === doc.uri).map(x => ({ range: x.range, kind: 1 })) : [];
    }
    case 'textDocument/hover': {
      const doc = document(params.textDocument.uri); if (!doc) return null;
      const tok = findTokenAt(doc.index, params.position);
      const deps = includedDocuments(doc);
      const target = resolveTarget(doc, tok);
      let targets = target ? [target] : callableTargets(doc, tok, deps);
      if (!targets.length) targets = macroAt(doc, params.position, deps);
      if (!targets.length) {
        const builtin = builtinInfo(doc, tok, [doc, ...deps], dialect(doc, settings.compiler.language));
        return builtin ? { contents: {kind: 'plaintext', value: builtin.label + '\n\n' + builtin.summary}, range: tok.range } : null;
      }
      const blocks = new Set();
      for (const item of targets) {
        const decl = item.declaration;
        const signatures = item.docs ? [] : declarationSignatures(item.doc, decl);
        const sections = signatures.length ? signatures : [{
          label: item.label || decl.display || (decl.detail + ' ' + decl.name),
          docs: item.docs || declarationDocs(item.doc.text, decl.startOffset ?? decl.token.start)
        }];
        for (const section of sections) {
          // Use a fence longer than any backtick run in the original declaration.
          const runs = section.label.match(/`+/g) || [];
          const fence = '`'.repeat(runs.reduce((max, r) => Math.max(max, r.length + 1), 3));
          blocks.add([fence + 'p4', section.label, fence, '', docsMarkdown(section.docs), item.conditional ? 'Conditional macro definition.' : ''].join('\n').trimEnd());
        }
      }
      return { contents: { kind: 'markdown', value: [...blocks].join('\n\n') }, range: tok?.range ?? targets[0].declaration.token.range };
    }
    case 'textDocument/completion': {
      const doc = document(params.textDocument.uri); if (!doc) return [];
      const offset = offsetAt(doc.text, params.position);
      const visible = [doc, ...includedDocuments(doc)];
      const variants = enumCompletions(doc, offset, visible.slice(1));
      if (variants) return variants.map(({declaration, label}) => ({label: declaration.name, kind: 20, detail: label}));
      const members = memberCompletions(doc, offset, visible);
      if (members !== null) {
        const builtins = builtinMembers(doc, offset, visible, dialect(doc, settings.compiler.language));
        return [...members.map(({declaration: d}) => ({label: d.name, kind: d.kind === 6 ? 2 : 5, detail: d.display || d.detail})),
          ...builtins.map(method => ({label: method.name, kind: 2, detail: method.label, documentation: {kind:'plaintext', value:method.summary}}))];
      }
      const items = [], seen = new Set();
      const scopes = new Set([0]);
      for (const scope of doc.index.scopes)
        if (scope.start < offset && offset <= scope.end) scopes.add(scope.id);
      for (const word of KEYWORDS) { seen.add(word); items.push({ label: word, kind: 14 }); }
      for (const candidate of [doc, ...includedDocuments(doc)]) for (const d of candidate.index.declarations) {
        if (candidate === doc ? !scopes.has(d.scope) : d.scope !== 0) continue;
        if (!seen.has(d.name)) { seen.add(d.name); items.push({ label: d.name, kind: 6, detail: d.detail }); }
      }
      return { isIncomplete: false, items };
    }
    case 'textDocument/documentSymbol': {
      const doc = document(params.textDocument.uri); if (!doc) return [];
      return doc.index.declarations.map(d => ({ name: d.name, kind: d.kind, range: d.token.range, selectionRange: d.token.range, detail: d.detail }));
    }
    case 'workspace/symbol': {
      scanWorkspace(); const query = (params.query || '').toLowerCase(), out = [];
      for (const doc of documents.values()) for (const d of doc.index.declarations)
        if (d.name.toLowerCase().includes(query)) out.push({ name: d.name, kind: d.kind, location: { uri: doc.uri, range: d.token.range } });
      return out.slice(0, 1000);
    }
    case 'textDocument/foldingRange': {
      const doc = document(params.textDocument.uri); if (!doc) return [];
      return doc.index.scopes.slice(1).map(scope => {
        const start = doc.index.tokens.find(t => t.start === scope.start)?.range.start.line;
        const end = doc.index.tokens.find(t => t.end === scope.end)?.range.end.line;
        return { startLine: start, endLine: end };
      }).filter(r => r.startLine !== undefined && r.endLine !== undefined && r.endLine > r.startLine);
    }
    default:
      if (method.startsWith('textDocument/') || method.startsWith('workspace/')) return null;
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}
const rpc = new Rpc(process.stdin, process.stdout, handle);
