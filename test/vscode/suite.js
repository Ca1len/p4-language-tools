'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

function tokenAt(document, legend, encoded, position) {
  let line = 0;
  let start = 0;
  for (let i = 0; i < encoded.data.length; i += 5) {
    const [lineDelta, startDelta, length, type] = encoded.data.subarray(i, i + 5);
    line += lineDelta;
    start = lineDelta ? startDelta : start + startDelta;
    if (line === position.line && position.character >= start && position.character < start + length) {
      return legend.tokenTypes[type];
    }
  }
  throw new Error('No semantic token at ' + document.uri.fsPath + ':' + (position.line + 1) + ':' + (position.character + 1));
}

function occurrence(doc, text, inside = 0) {
  const index = doc.getText().indexOf(text);
  assert.ok(index >= 0, 'Missing fixture text ' + text);
  return doc.positionAt(index + inside);
}

async function scenario(root, folder, names) {
  const program = vscode.Uri.file(path.join(root, folder, 'main.p4'));
  const header = vscode.Uri.file(path.join(root, folder, 'library.p4i'));
  const doc = await vscode.workspace.openTextDocument(program);
  await vscode.window.showTextDocument(doc);
  assert.equal(doc.languageId, 'p4');
  assert.ok(!vscode.workspace.textDocuments.some(d => d.uri.toString() === header.toString()), 'Include must start unopened');

  const p4Extension = vscode.extensions.getExtension('local.p4-language-tools');
  assert.ok(p4Extension, 'Installed extension missing');
  await p4Extension.activate();
  const invoke = (command, ...args) => vscode.commands.executeCommand('vscode.' + command, doc.uri, ...args);

  const legend = await invoke('provideDocumentSemanticTokensLegend');
  const semantic = await invoke('provideDocumentSemanticTokens');
  assert.ok(legend && semantic?.data.length, 'Semantic token provider missing');
  for (const [text, inside, category] of names.tokens) {
    const actual = tokenAt(doc, legend, semantic, occurrence(doc, text, inside));
    assert.equal(actual, category, folder + ': ' + text + ' semantic category');
  }

  const actionPosition = occurrence(doc, names.call);
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  const hints = await invoke('executeInlayHintProvider', fullRange);
  const parameterHint = hints?.find(h => h.label === 'value:' && h.position.isEqual(occurrence(doc, names.argument)));
  assert.ok(parameterHint, folder + ': inlay for the literal second argument was missing');

  const [definition] = await invoke('executeDefinitionProvider', actionPosition);
  const targetUri = definition?.targetUri || definition?.uri;
  assert.equal(targetUri?.toString(), header.toString(), folder + ': F12 did not resolve the closed header');
  const targetRange = definition.targetSelectionRange || definition.range || definition.targetRange;
  const targetLine = fs.readFileSync(header.fsPath, 'utf8').split(/\r?\n/)[targetRange.start.line];
  assert.equal(targetLine.slice(targetRange.start.character, targetRange.end.character), names.call.split('(')[0]);

  const call = occurrence(doc, names.argument);
  const help = await invoke('executeSignatureHelpProvider', call);
  assert.equal(help?.activeParameter, 1, folder + ': wrong active parameter');
  assert.ok(help.signatures[help.activeSignature].label.includes(names.call.split('(')[0]));
  const hovers = await invoke('executeHoverProvider', actionPosition);
  const hoverText = (hovers || []).flatMap(h => h.contents).map(x => typeof x === 'string' ? x : x.value).join('\n');
  assert.ok(hoverText.includes('Set packet marker'), folder + ': unexpected hover ' + hoverText);
  return { dialect: folder, tokens: names.tokens.map(x => x[2]), f12: path.basename(header.fsPath), activeParameter: help.activeParameter, literalInlay: parameterHint.label };
}

async function checkCompiler(root) {
  const uri = vscode.Uri.file(path.join(root, 'invalid.p4'));
  const header = vscode.Uri.file(path.join(root, 'decl.p4'));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  assert.equal(doc.isDirty, false);
  await vscode.commands.executeCommand('p4.checkProject');
  const error = await waitFor(() => vscode.languages.getDiagnostics(uri).find(d =>
    d.source === path.basename(process.env.P4TEST_BINARY) && d.severity === vscode.DiagnosticSeverity.Error &&
    d.code === 'type-error'), 'Missing p4test type diagnostic after manual check');
  assert.match(error.message, /Cannot cast.*bool/);
  const related = error.relatedInformation?.find(info =>
    info.location.uri.toString() === header.toString() && info.message.includes("Function type 'takes_bool'"));
  assert.ok(related, 'The compiler diagnostic must link to the declaration in decl.p4');
  assert.ok(related.location.range.isEqual(new vscode.Range(0, 5, 0, 15)));
  const base = path.dirname(root);
  if (fs.existsSync(path.join(base, 'inspect-workbench'))) {
    await vscode.commands.executeCommand('workbench.panel.markers.view.focus');
    fs.writeFileSync(path.join(base, 'compiler-related-ready'), '');
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === header.toString(),
      'Clicking related information in Problems did not open decl.p4');
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor.selection.start.line, related.location.range.start.line);
    assert.equal(editor.selection.start.character, related.location.range.start.character);
  }
  return {message: error.message, relatedFile: 'decl.p4', relatedSymbol: 'takes_bool'};
}

async function waitFor(probe, failure) {
  for (let n = 0; n < 200; n++) {
    const result = probe();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(failure);
}

async function checkVendorDiagnostic(root) {
  const base = path.dirname(root);
  const main = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'vendor-main.p4')));
  const uri = vscode.Uri.file(path.join(root, 'src', 'switch.p4'));
  assert.ok(!vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString()));
  await vscode.window.showTextDocument(main);
  assert.equal(main.isDirty, false);
  await vscode.commands.executeCommand('p4.checkProject');
  const vendorErrors = () => vscode.languages.getDiagnostics(uri).filter(d => d.source === 'p4c-vendor');
  const error = await waitFor(() => vendorErrors()[0], 'Missing compiler diagnostic for the closed include');
  assert.equal(vendorErrors().length, 1);
  assert.equal(error.message, 'syntax error, unexpected IDENTIFIER, expecting APPLY');
  assert.equal(error.severity, vscode.DiagnosticSeverity.Error);
  assert.ok(error.range.isEqual(new vscode.Range(56, 22, 56, 26)));

  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  assert.equal(doc.getText(error.range), 'aply');
  if (fs.existsSync(path.join(base, 'inspect-workbench'))) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    await vscode.commands.executeCommand('workbench.panel.markers.view.focus');
    editor.revealRange(error.range, vscode.TextEditorRevealType.InCenter);
    fs.writeFileSync(path.join(base, 'vendor-error-visible'), '');
    await waitFor(() => fs.existsSync(path.join(base, 'vendor-ui-checked')), 'Workbench diagnostics were not verified');
  }
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input?.uri?.toString() === uri.toString())));
  await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', main.uri);
  assert.ok(vendorErrors().some(d => d.range.isEqual(error.range)), 'Closing the tab lost the compiler diagnostic');
  const reopened = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(reopened);
  const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, error.range,
    vscode.CodeActionKind.QuickFix.value);
  const fix = actions?.find(action => action.title === "Replace 'aply' with 'apply'");
  assert.ok(fix?.edit, 'No compiler quick fix for the misspelled apply');
  const replacements = fix.edit.get(uri);
  assert.equal(replacements.length, 1);
  assert.ok(replacements[0].range.isEqual(error.range));
  assert.equal(replacements[0].newText, 'apply');
  assert.ok(await vscode.workspace.applyEdit(fix.edit));
  assert.ok(await reopened.save());
  await waitFor(() => fs.existsSync(path.join(base, 'vendor-compile-ok')) && vendorErrors().length === 0,
    'Correcting the include did not produce a successful build and clear its diagnostic');
  fs.writeFileSync(path.join(base, 'vendor-backend-failure'), '');
  assert.equal(reopened.isDirty, false);
  const failure = await vscode.commands.executeCommand('p4.checkProject');
  assert.equal(failure.status, 'failed');
  assert.equal(vendorErrors().length, 0, 'Locationless failure was pinned to the include');
  await vscode.commands.executeCommand('p4.showCompilerOutput');
  if (fs.existsSync(path.join(base, 'inspect-workbench'))) {
    fs.writeFileSync(path.join(base, 'compiler-output-ready'), '');
    await waitFor(() => fs.existsSync(path.join(base, 'compiler-output-checked')), 'Compiler Output panel was not verified');
  }
  return { source: error.source, message: error.message, file: 'src/switch.p4', line: 57, columns: [23, 26], cleared: true };
}

async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const runs = [];
  runs.push(await scenario(root, 'p4-16', {
    call: 'set_mark(', argument: '8w7',
    tokens: [['Frame frame', 0, 'struct'], ['set_mark(', 0, 'function'], ['frame.tag', 6, 'property']]
  }));
  runs.push(await scenario(root, 'p4-14', {
    call: 'stamp_pair(', argument: '17',
    tokens: [['Tag frame', 0, 'struct'], ['stamp_pair(', 0, 'function'], ['frame.tag', 6, 'property']]
  }));
  const compiler = process.env.P4TEST_BINARY ? await checkCompiler(root) :
    fs.existsSync(path.join(root, 'vendor-main.p4')) ? await checkVendorDiagnostic(root) : 'not requested';
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'p4-16', 'main.p4'))));
  fs.writeFileSync(path.join(root, 'host-result.json'), JSON.stringify({
    app: vscode.env.appName, version: vscode.version, tested: vscode.extensions.getExtension('local.p4-language-tools').packageJSON.version, runs,
    compiler
  }));
}
module.exports = { run };
