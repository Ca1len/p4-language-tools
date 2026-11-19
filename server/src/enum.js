'use strict';

// Called while building the normal token index. Offsets and scope IDs come
// from that index so enums, fields, F12 and references use identical objects.
function indexEnum(tokens, keyword, text, identifier, add) {
  let next = keyword.index + 1;
  if (tokens[next]?.text === 'bit' || tokens[next]?.text === 'int') {
    if (tokens[++next]?.text !== '<') return;
    while (++next < tokens.length && tokens[next].text !== '>') {
      const token = tokens[next];
      if (['{', '}', ';'].includes(token.text)) return;
      if (token.text === '(' && token.pair !== undefined) next = token.pair;
    }
    ++next;
  }
  const type = tokens[next], open = tokens[next + 1];
  if (!identifier(type) || open?.text !== '{') return;
  add(type, 10, 'enum', type.scope, {
    startOffset: keyword.start, display: text.slice(keyword.start, type.end),
    bodyScope: open.childScope, enumMembers: []
  });

  let entry = open.index + 1;
  for (let i = entry; i < tokens.length; i++) {
    const token = tokens[i];
    if (['(', '['].includes(token.text) && token.pair > i) {
      i = token.pair;
      continue;
    }
    if (token.scope !== open.childScope || ![',', '}'].includes(token.text)) continue;
    // P4 permits member annotations such as @name("red") before a name.
    let cursor = entry;
    while (tokens[cursor]?.text === '@' && identifier(tokens[cursor + 1])) {
      cursor += 2;
      if (['(', '['].includes(tokens[cursor]?.text) && tokens[cursor].pair !== undefined)
        cursor = tokens[cursor].pair + 1;
    }
    const member = tokens[cursor];
    if (cursor < i && identifier(member) && (cursor + 1 === i || tokens[cursor + 1].text === '=')) {
      let display = type.text + '.' + member.text;
      if (cursor + 2 < i) display += ' = ' + text.slice(tokens[cursor + 2].start, tokens[i - 1].end).trim();
      add(member, 22, 'enum member', open.childScope, {
        typeName: type.text, isMember: true, display, startOffset: member.start
      });
      if (member.declaration) type.declaration?.enumMembers?.push(member.declaration);
    }
    if (token.text === '}') break;
    entry = i + 1;
  }
}

function enumType(doc, owner, dependencies) {
  if (!owner || doc.index.tokens[owner.index - 1]?.text === '.') return;
  for (let scope = owner.scope; scope !== null; scope = doc.index.scopes[scope].parent) {
    const hits = doc.index.declarationsByScope.get(scope)?.get(owner.text);
    if (hits?.length) return hits.length === 1 && hits[0].enumMembers ? {doc,declaration:hits[0]} : undefined;
  }
  let result;
  for (const dependency of dependencies) {
    if (dependency === doc) continue;
    const hits = dependency.index.declarationsByScope.get(0)?.get(owner.text) || [];
    if (!hits.length) continue;
    if (result || hits.length !== 1 || !hits[0].enumMembers) return;
    result = {doc:dependency, declaration:hits[0]};
  }
  return result;
}

function enumMember(doc, token, dependencies = []) {
  if (!token) return;
  if (token.declaration?.kind === 22) return {doc, declaration:token.declaration, label:token.declaration.display};
  const tokens = doc.index.tokens;
  if (tokens[token.index - 1]?.text !== '.') return;
  const type = enumType(doc, tokens[token.index - 2], dependencies);
  const matches = type?.declaration.enumMembers.filter(m => m.name === token.text);
  if (matches?.length === 1) return {doc:type.doc, declaration:matches[0], label:matches[0].display};
}

// Return null when the receiver is not a known enum so other providers can run.
function enumCompletions(doc, offset, dependencies = []) {
  const tokens = doc.index.tokens;
  let lo = 0, hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tokens[mid].start < offset) lo = mid + 1; else hi = mid;
  }
  let dot = tokens[lo - 1];
  if (dot && offset <= dot.end && /^[A-Za-z_]\w*$/.test(dot.text)) dot = tokens[dot.index - 1];
  if (dot?.text !== '.' || !/^\s*(?:[A-Za-z_]\w*)?$/.test(doc.text.slice(dot.end, offset))) return null;
  const type = enumType(doc, tokens[dot.index - 1], dependencies);
  return type?.declaration.enumMembers.map(declaration => ({doc:type.doc, declaration, label:declaration.display})) ?? null;
}

module.exports = {indexEnum, enumMember, enumCompletions};
