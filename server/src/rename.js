'use strict';

const { KEYWORDS, findTokenAt, resolve } = require('./indexer');

const scalar = /^(?:bool|(?:bit|int)\s*<\s*[1-9][0-9]*\s*>)$/;
const extraReserved = new Set(['_', 'exit', 'for', 'while', 'break', 'continue', 'switch', 'default', 'value_set', 'newtype', 'list', 'entries', 'priority', 'priority_delta', '__VA_ARGS__']);

function macrosIn(documents, args) {
  const names = new Set();
  for (const doc of documents) {
    for (const m of doc.text.matchAll(/^[ \t]*#[ \t]*(?:define|undef)[ \t]+([A-Za-z_]\w*)/gm)) names.add(m[1]);
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-include' || args[i] === '-imacros') return null;
    if (!args[i].startsWith('-D')) continue;
    const value = args[i].length === 2 ? args[++i] : args[i].slice(2);
    const name = value?.match(/^[A-Za-z_]\w*/)?.[0];
    if (name) names.add(name);
  }
  return names;
}

// The edit is restricted to a straight-line action body with scalar locals.
// Parameters can be referenced with named arguments at external call sites.
function eligible(doc, position, dependencies, compilerArgs) {
  if (!doc || !Number.isInteger(doc.version)) return null;
  const index = doc.index;
  const token = findTokenAt(index, position);
  const target = resolve(index, token);
  if (target?.detail !== 'variable or field' || target.scope === 0) return null;
  const prefix = doc.text.slice(target.startOffset, target.token.start).trim();
  if (!scalar.test(prefix)) return null;
  const tokens = index.tokens;
  const scope = index.scopes[target.scope];
  const open = tokens.find(t => t.start === scope.start && t.text === '{');
  const close = tokens.find(t => t.end === scope.end && t.text === '}');
  if (!open || close?.scope !== target.scope) return null;
  const paramEnd = tokens[open.index - 1];
  const paramStart = paramEnd?.text === ')' ? paramEnd.pair : undefined;
  if (tokens[paramStart - 2]?.text !== 'action') return null;
  const body = tokens.slice(open.index + 1, close.index);
  if (body.some(t => ['{', '}', '@', '#', '(', ')'].includes(t.text))) return null;
  // An unresolved spelling might be an object-like macro from a compiler
  // header. Its replacement list can use the local without spelling it here.
  for (const t of body) {
    if (!/^[A-Za-z_]\w*$/.test(t.text) || KEYWORDS.has(t.text)) continue;
    const binding = resolve(index, t);
    if (binding?.scope !== target.scope) return null;
  }
  if (/^[ \t]*#/m.test(doc.text.slice(open.end, close.start))) return null;
  const names = macrosIn([doc, ...dependencies], compilerArgs);
  if (!names || body.some(t => names.has(t.text))) return null;
  const sites = body.filter(t => t.text === target.name);
  if (sites.some(t => t.index < target.token.index || resolve(index, t) !== target)) return null;
  if (token.text !== target.name || !sites.includes(token)) return null;
  return { token, sites, names };
}

function prepareRename(doc, position, dependencies = [], compilerArgs = []) {
  const result = eligible(doc, position, dependencies, compilerArgs);
  return result ? { range: result.token.range, placeholder: result.token.text } : null;
}

function invalid(message) {
  return Object.assign(new Error(message), { code: -32602 });
}

function rename(doc, position, newName, dependencies = [], compilerArgs = []) {
  const result = eligible(doc, position, dependencies, compilerArgs);
  if (!result) throw invalid('Only scalar locals in a simple action body can be renamed.');
  if (typeof newName !== 'string' || !/^[A-Za-z_]\w*$/.test(newName) ||
      KEYWORDS.has(newName) || extraReserved.has(newName) || newName.startsWith('__')) {
    throw invalid('The new name must be a P4 identifier.');
  }
  // Refuse even an existing unbound spelling: changing its binding can alter
  // a use which would not appear among the edits.
  if (newName !== result.token.text &&
      (result.names.has(newName) || doc.index.tokens.some(t => t.text === newName))) {
    throw invalid('The new name already occurs in this document or its macro configuration.');
  }
  const edits = result.sites.map(t => ({ range: t.range, newText: newName }));
  return { documentChanges: [{ textDocument: { uri: doc.uri, version: doc.version }, edits }] };
}

module.exports = { prepareRename, rename };
