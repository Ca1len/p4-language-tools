'use strict';

const { offsetAt, identifier: isName } = require('./indexer');
const { memberCandidates, builtinInfo } = require('./members');
const { declarationDocs } = require('./docs');
const { macroTargets } = require('./macros');

const identifier = token => !!token && /^[A-Za-z_]\w*$/.test(token.text);
const typeWords = new Set(['void', 'int', 'bit', 'bool', 'varbit', 'string', 'error', 'tuple', 'list']);
const isType = token => isName(token) || typeWords.has(token?.text);
const constructs = new Set(['action', 'primitive_action', 'control', 'parser', 'package']);
const cached = new WeakMap();
const openFor = new Map([[')', '('], [']', '['], ['}', '{']]);

// Match structural delimiters even in unfinished files. Only classify '<...>'
// as specialization when its content and closing context resemble a type list.
function structure(tokens) {
  const pairs = new Map();
  const nested = [];
  const angles = [];
  for (const token of tokens) {
    const i = token.index;
    if (['(', '[', '{'].includes(token.text)) nested.push(token);
    if (openFor.has(token.text) && nested.at(-1)?.text === openFor.get(token.text)) {
      const open = nested.pop().index;
      pairs.set(open, i); pairs.set(i, open);
    }
    if (token.text === '<' && identifier(tokens[i - 1])) angles.push(i);
    else if (token.text === '>' && angles.length) {
      const open = angles.pop();
      pairs.set(open, i); pairs.set(i, open);
    } else if (!identifier(token) && !/^(?:\d|[,<>])/.test(token.text)) angles.length = 0;
  }
  return pairs;
}
function raw(doc, first, last) {
  return doc.text.slice(first.start, last.end).trim().replace(/\s+/g, ' ');
}
function parameterList(doc, pairs, open, close) {
  const tokens = doc.index.tokens, params = [];
  let start = open + 1;
  for (let i = start; i <= close; i++) {
    const token = tokens[i];
    if (i !== close && token.text !== ',') {
      if (pairs.get(i) > i && pairs.get(i) < close) i = pairs.get(i);
      continue;
    }
    if (start < i) {
      const label = raw(doc, tokens[start], tokens[i - 1]);
      let end = i;
      for (let j = start; j < i; ++j) {
        if (tokens[j].text === '=') { end = j; break; }
        if (pairs.get(j) > j && pairs.get(j) < i) j = pairs.get(j);
      }
      const name = tokens[end - 1];
      params.push({ label, name: isName(name) ? name.text : undefined });
    }
    start = i + 1;
  }
  return params;
}
function typeBefore(tokens, pairs, index) {
  let start = index - 1;
  if (tokens[start]?.text === '>') start = (pairs.get(start) ?? 0) - 1;
  return isType(tokens[start]) ? start : -1;
}
function signatureIndex(doc) {
  if (cached.has(doc.index)) return cached.get(doc.index);
  const tokens = doc.index.tokens;
  const pairs = structure(tokens);
  const byName = new Map(), owners = new Map(), instances = new Map();
  const add = (map, name, value) => {
    const items = map.get(name);
    if (items) items.push(value); else map.set(name, [value]);
  };
  function register(token, start, open, close, kind, owner, method, customLabel) {
    const signature = {
      token, owner, method, start: tokens[start].start, kind,
      label: customLabel ?? raw(doc, tokens[start], tokens[close]),
      params: parameterList(doc, pairs, open, close),
    };
    add(byName, method || token.text, signature);
  }
  for (let i = 0; i < tokens.length; ++i) {
    const token = tokens[i];
    if (token.text === 'extern' && isName(tokens[i + 1])) {
      let body = i + 2;
      if (tokens[body]?.text === '<') body = (pairs.get(body) ?? -2) + 1;
      if (tokens[body]?.text === '{') owners.set(tokens[body].childScope, tokens[i + 1].text);
    }
    if (!isName(token)) continue;
    let open = i + 1;
    if (tokens[open]?.text === '<') open = (pairs.get(open) ?? -2) + 1;
    if (tokens[open]?.text !== '(') continue;
    const close = pairs.get(open);
    if (close === undefined) continue;
    const next = tokens[close + 1]?.text, prev = tokens[i - 1]?.text;
    const owner = owners.get(token.scope);
    // A P4_16 instance has the form T<TArgs>(constructorArgs) instance;
    if (isName(tokens[close + 1]) && tokens[close + 2]?.text === ';') {
      const name = tokens[close + 1];
      add(instances, name.text, { type: token.text, scope: name.scope, start: name.start });
      continue;
    }
    if (constructs.has(prev)) {
      if (prev === 'control' || prev === 'parser') {
        register(token, i - 1, open, close, prev, token.text, 'apply', token.text + '.apply' + raw(doc, tokens[open], tokens[close]));
        const ctorOpen = close + 1, ctorClose = pairs.get(ctorOpen);
        if (next === '(' && ctorClose !== undefined)
          register(token, i - 1, ctorOpen, ctorClose, prev, undefined, undefined, token.text + raw(doc, tokens[ctorOpen], tokens[ctorClose]));
        else
          add(byName, token.text, { token, start: tokens[i - 1].start, kind: prev, label: token.text + '()', params: [] });
      } else register(token, i - 1, open, close, prev);
      continue;
    }
    if (![';', '{'].includes(next)) continue;
    const typeStart = typeBefore(tokens, pairs, i);
    if (typeStart < 0) {
      if (owner === token.text && next === ';') register(token, i, open, close, 'constructor');
      continue;
    }
    const prefix = tokens[typeStart - 1]?.text;
    if ((next === ';' && !owner && prefix !== 'extern') || tokens[i - 1]?.text === '.') continue;
    const start = ['extern', 'abstract'].includes(prefix) ? typeStart - 1 : typeStart;
    register(token, start, open, close, owner ? 'method' : 'function', owner);
  }
  const result = { byName, pairs, instances };
  cached.set(doc.index, result);
  return result;
}
function lexicalScopes(doc, token) {
  const scopes = [];
  for (let s = token.scope; s != null; s = doc.index.scopes[s].parent) scopes.push(s);
  return scopes;
}
function receiverType(doc, receiver, dependencies) {
  if (!isName(receiver) || doc.index.tokens[receiver.index - 1]?.text === '.') return null;
  // A local parameter can hide an instance of the same name. Search both
  // declaration forms together before moving to the enclosing scope.
  for (const file of [doc, ...dependencies]) {
    const { instances, pairs } = signatureIndex(file);
    for (const scope of (file === doc ? lexicalScopes(doc, receiver) : [0])) {
      const known = instances.get(receiver.text)?.find(x => x.scope === scope && (file !== doc || x.start < receiver.start));
      if (known) return known.type;
      const declared = file.index.declarationsByScope.get(scope)?.get(receiver.text);
      if (!declared?.length) continue;
      if (declared.length !== 1) return null;
      const typeStart = typeBefore(file.index.tokens, pairs, declared[0].token.index);
      return file.index.tokens[typeStart]?.text || null;
    }
  }
  return null;
}
function callableTargets(doc, token, dependencies = []) {
  if (!token || (!isName(token) && token.text !== 'apply')) return [];
  const tokens = doc.index.tokens;
  const member = tokens[token.index - 1]?.text === '.';
  if (member && token.text !== 'apply') {
    const typedMembers = memberCandidates(doc, token, [doc, ...dependencies]);
    return typedMembers.flatMap(({doc: source, declaration}) =>
      (signatureIndex(source).byName.get(token.text) || []).filter(entry => entry.token === declaration.token)
        .map(entry => ({doc: source, declaration, label: entry.label, entry})));
  }
  const owner = member && receiverType(doc, tokens[token.index - 2], dependencies);
  if (member && !owner) return [];
  const allowed = lexicalScopes(doc, token);
  const found = [];
  for (const file of [doc, ...dependencies]) {
    const matches = signatureIndex(file).byName.get(token.text) || [];
    for (const entry of matches) {
      if (member ? entry.owner !== owner : entry.owner) continue;
      if (!member && entry.kind !== 'constructor' && !(file === doc ? allowed.includes(entry.token.scope) : entry.token.scope === 0)) continue;
      const value = entry.token.declaration || { token: entry.token, name: entry.token.text, scope: entry.token.scope, kind: 12, detail: entry.kind };
      found.push({ doc: file, declaration: value, label: entry.label, entry });
    }
  }
  if (!member && found.length) {
    const localScope = allowed.find(s => found.some(x => x.doc === doc && x.entry.token.scope === s));
    if (localScope != null && localScope !== 0) return found.filter(x => x.doc === doc && x.entry.token.scope === localScope);
  }
  return found;
}
function callAt(doc, offset) {
  const tokens = doc.index.tokens, { pairs } = signatureIndex(doc);
  // Work back from the caret, skipping balanced argument expressions.
  let lo = 0, hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tokens[mid].start < offset) lo = mid + 1; else hi = mid;
  }
  let commas = 0, lastComma;
  for (let i = lo - 1; i >= 0; --i) {
    const value = tokens[i].text;
    if ((openFor.has(value) || (value === '>' && tokens[i + 1]?.text === '(')) && pairs.has(i)) { i = pairs.get(i); continue; }
    if (value === '[' || (value === '{' && ['(', ',', '=', '{'].includes(tokens[i - 1]?.text))) {
      // Inside an unfinished tuple/list literal or an array index, commas
      // consumed so far belong to that expression, not the enclosing call.
      commas = 0; lastComma = undefined; continue;
    }
    if ([';', '{', '}'].includes(value)) return null;
    if (value === ',') { commas++; lastComma ??= i; }
    if (value !== '(') continue;
    let name = i - 1;
    if (tokens[name]?.text === '>') name = (pairs.get(name) ?? 0) - 1;
    if (!isName(tokens[name]) && tokens[name]?.text !== 'apply') {
      commas = 0; lastComma = undefined; continue;
    }
    const first = tokens[(lastComma ?? i) + 1];
    const named = first && isName(first) && tokens[first.index + 1]?.text === '=' &&
      tokens[first.index + 1].end <= offset && tokens[first.index + 2]?.text !== '=';
    return { token: tokens[name], argument: commas, named: named ? first.text : undefined };
  }
  return null;
}
const primitiveParams = new Map([
  ['modify_field', ['dest', 'value', 'mask']], ['add_to_field', ['dest', 'value']],
  ['subtract_from_field', ['dest', 'value']], ['add_header', ['header_instance']],
  ['remove_header', ['header_instance']], ['drop', []], ['no_op', []],
]);
function signatureHelp(doc, position, dependencies = [], language = 'auto') {
  const call = callAt(doc, offsetAt(doc.text, position));
  if (!call) return null;
  const matches = callableTargets(doc, call.token, dependencies);
  const signatures = matches.map(({doc: source, entry}) => {
    const docs = declarationDocs(source.text, entry.start);
    const result = { label: entry.label, parameters: entry.params.map(p => {
      const value = docs.params[p.name];
      return value ? { label: p.label, documentation: {kind:'plaintext', value} } : { label: p.label };
    }) };
    if (docs.summary) result.documentation = { kind: 'plaintext', value: docs.summary };
    if (call.named) {
      const namedIndex = entry.params.findIndex(p => p.name === call.named);
      if (namedIndex >= 0) result.activeParameter = namedIndex;
    }
    return result;
  });
  if (!signatures.length) {
    for (const macro of macroTargets(doc, call.token.text, dependencies, call.token.start)) {
      if (macro.parameters === null) continue;
      const note = macro.conditional ? 'Conditional macro candidate (preprocessor condition unevaluated).' : 'Macro declaration from source.';
      signatures.push({
        label: macro.label,
        documentation: { kind: 'plaintext', value: [macro.docs.summary, note].filter(Boolean).join('\n\n') },
        parameters: macro.parameters.map(label => {
          const value = macro.docs.params[label];
          return value ? {label, documentation: {kind: 'plaintext', value}} : {label};
        }),
      });
    }
  }
  if (!signatures.length && doc.index.tokens[call.token.index - 1]?.text === '.') {
    const info = builtinInfo(doc, call.token, [doc, ...dependencies], language);
    if (info) signatures.push({label: info.label, documentation: {kind: 'plaintext', value: info.summary}, parameters: []});
  }
  const legacy = language === 'p4-14' || (language === 'auto' && (/\.p4_14$/i.test(doc.uri) || doc.index.tokens.some(t => t.text === 'header_type')));
  if (!signatures.length && legacy && doc.index.tokens[call.token.index - 1]?.text !== '.') {
    const names = primitiveParams.get(call.token.text);
    if (names) {
      const variants = call.token.text === 'modify_field' ? [names.slice(0, 2), names] : [names];
      for (const args of variants) signatures.push({
        label: call.token.text + '(' + args.join(', ') + ')', parameters: args.map(label => ({ label })),
        documentation: { kind: 'plaintext', value: 'P4_14 standard primitive (section 9.1).' }
      });
    }
  }
  if (!signatures.length) return null;
  const activeSignature = Math.max(0, signatures.findIndex(s => call.named ? s.activeParameter !== undefined : s.parameters.length > call.argument));
  const active = signatures[activeSignature];
  return { signatures, activeSignature, ...(active.parameters.length ? {activeParameter: active.activeParameter ?? Math.min(call.argument, active.parameters.length - 1)} : {}) };
}
// Multiple synthetic signatures can refer to the same control/parser name
// (its constructor and instance.apply). Overloads with different name tokens
// retain their own source comments.
function declarationSignatures(doc, declarationOrToken) {
  const token = declarationOrToken?.token || declarationOrToken;
  if (!token) return [];
  const {byName} = signatureIndex(doc);
  const entries = byName.get(token.text) || [];
  const apply = ['control','parser'].includes(doc.index.tokens[token.index-1]?.text) ? byName.get('apply') || [] : [];
  return [...entries, ...apply].filter(entry => entry.token === token)
    .map(entry => ({ label: entry.label, docs: declarationDocs(doc.text, entry.start) }));
}

module.exports = { signatureHelp, callableTargets, declarationSignatures, signatureIndex, primitiveParams };
