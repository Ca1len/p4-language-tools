'use strict';

const { resolve, identifier } = require('./indexer');

function visibleDeclaration(doc, token, visible) {
  const local = resolve(doc.index, token);
  if (local) return { doc, declaration: local };
  // A same-name overload set in the nearest scope also hides outer names.
  for (let scope = token.scope; scope !== null; scope = doc.index.scopes[scope].parent) {
    if (doc.index.declarationsByScope.get(scope)?.has(token.text)) return undefined;
  }
  const candidates = [];
  for (const other of visible) {
    if (other === doc) continue;
    for (const declaration of other.index.declarationsByScope.get(0)?.get(token.text) || [])
      candidates.push({ doc: other, declaration });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Resolve a value's declared type, retaining a user-defined alias for F12. */
function typeTarget(doc, declaration, visible) {
  const name = declaration?.typeName || declaration?.aliasOf;
  if (!name) return undefined;
  const matches = [];
  for (const candidate of visible) {
    for (const item of candidate.index.declarationsByScope.get(0)?.get(name) || []) {
      if (item.bodyScope !== undefined || item.aliasOf) matches.push({ doc:candidate, declaration:item });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function memberType(target, visible) {
  const visited = new Set();
  while (target) {
    target = typeTarget(target.doc, target.declaration, visible);
    if (!target || visited.has(target.declaration)) return undefined;
    if (!target.declaration.aliasOf) return target;
    visited.add(target.declaration);
  }
}

function chainBefore(doc, dot) {
  const tokens = doc.index.tokens;
  const chain = [];
  let cursor = dot.index-1;
  while (cursor >= 0) {
    if (tokens[cursor].text === ']') {
      const open = tokens[cursor].pair;
      if (open === undefined) return [];
      cursor = open-1;
    }
    if (!identifier(tokens[cursor])) return [];
    chain.push(tokens[cursor]);
    if (tokens[cursor-1]?.text !== '.') return chain.reverse();
    cursor -= 2;
  }
  return [];
}

function receiverBefore(doc, dot, visible) {
  const chain = chainBefore(doc, dot);
  if (!chain.length) return;
  let target = visibleDeclaration(doc, chain[0], visible);
  for (let i=0; target && i<chain.length; ++i) {
    const declarationTokens = target.doc.index.tokens;
    const nameIndex = target.declaration.token.index;
    const stack = declarationTokens[nameIndex-1]?.text === ']' || declarationTokens[nameIndex+1]?.text === '[';
    if (stack && doc.index.tokens[chain[i].index+1]?.text !== '[') return;
    if (i+1 === chain.length) return target;
    const type = memberType(target, visible);
    const matching = type?.declaration.members?.filter(member => member.name === chain[i+1].text) || [];
    if (matching.length !== 1) return;
    target = {doc:type.doc, declaration:matching[0]};
  }
}

function membersAfter(doc, dot, visible) {
  const type = memberType(receiverBefore(doc, dot, visible), visible);
  return (type?.declaration.members || []).map(declaration => ({doc:type.doc, declaration}));
}

const headerMethods = [
  {name:'isValid', label:'bool isValid()', summary:'Returns the validity bit of this header.'},
  {name:'setValid', label:'void setValid()', summary:'Marks this header as valid.'},
  {name:'setInvalid', label:'void setInvalid()', summary:'Marks this header as invalid.'}
];
const tableMethods = [
  {name:'apply', label:'apply()', summary:'Looks up the table key and executes the selected action. The result exposes hit, miss and action_run.'}
];
function builtinsAfter(doc, dot, visible, language) {
  if (language === 'p4-14') return [];
  const receiver = receiverBefore(doc, dot, visible);
  if (!receiver) return [];
  if (memberType(receiver, visible)?.declaration.detail === 'header') return headerMethods;
  if (receiver.declaration.detail !== 'table') return [];
  const legacy = language !== 'p4-16' && (doc.uri.endsWith('.p4_14') || visible.some(
    file => file.index.declarations.some(d => d.detail === 'header_type')));
  return legacy ? [] : tableMethods;
}

function memberCandidates(doc, token, visible) {
  if (!token) return [];
  const dot = doc.index.tokens[token.index-1];
  if (dot?.text !== '.') return [];
  return membersAfter(doc, dot, visible).filter(target => target.declaration.name === token.text);
}

function memberTarget(doc, token, visible) {
  const matches = memberCandidates(doc, token, visible);
  return matches.length === 1 ? matches[0] : undefined;
}

function completionDot(doc, offset) {
  const tokens = doc.index.tokens;
  let low = 0, high = tokens.length;
  while (low < high) {
    const mid = (low+high) >>> 1;
    if (tokens[mid].start < offset) low = mid + 1;
    else high = mid;
  }
  let token = tokens[low-1];
  if ((identifier(token) || token?.text === 'apply') && offset <= token.end) token = tokens[token.index-1];
  if (token?.text !== '.') return null;
  // A string/comment following a dot is not an incomplete member access.
  if (!/^\s*(?:[A-Za-z_]\w*)?$/.test(doc.text.slice(token.end,offset))) return null;
  return token;
}

function memberCompletions(doc, offset, visible) {
  const dot = completionDot(doc, offset);
  return dot ? membersAfter(doc, dot, visible) : null;
}

function builtinMembers(doc, offset, visible, language = 'auto') {
  const dot = completionDot(doc, offset);
  return dot ? builtinsAfter(doc, dot, visible, language) : [];
}

function builtinInfo(doc, token, visible, language = 'auto') {
  const dot = token && doc.index.tokens[token.index-1];
  if (dot?.text !== '.') return;
  return builtinsAfter(doc, dot, visible, language).find(method => method.name === token.text);
}

module.exports = {builtinMembers, builtinInfo, typeTarget, memberCandidates, memberTarget, memberCompletions};
