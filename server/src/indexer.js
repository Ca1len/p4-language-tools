'use strict';

const { indexEnum } = require('./enum');

// A deliberately conservative, syntax-oriented P4 index. This is not a P4
// compiler: ambiguous member lookups and unknown constructs are left unresolved.
const KEYWORDS = new Set(('abstract action actions apply bit bool const control default else entries enum error extern false header header_union if in inout int key list match_kind metadata out package parser select serializable_enum state string struct switch table this transition true tuple type typedef value_set varbit void header_type field_list field_list_calculation calculated_field counter direct_counter direct_meter meter register blackbox parser_value_set primitive_action action_profile action_selector control_flow parser_exception calculated_field parser parse_error return').split(' '));
const DECL_KEYWORDS = new Map(Object.entries({
  action: 12, primitive_action: 12, control: 5, parser: 5, state: 12, table: 5, header_type: 23,
  header_union: 23, struct: 23, enum: 10, extern: 5, package: 5,
  typedef: 26, type: 26, value_set: 13, parser_value_set: 13,
  field_list: 13, field_list_calculation: 13, counter: 13, direct_counter: 13,
  meter: 13, direct_meter: 13, register: 13, action_profile: 13,
  action_selector: 13, parser_exception: 12, control_flow: 12,
}));
const TYPE_KEYWORDS = new Set(['bit','int','varbit','bool','string','error']);

function positionAt(text, offset) {
  offset = Math.max(0, Math.min(offset, text.length));
  let line = 0, last = -1;
  for (let i = 0; i < offset; ++i) if (text.charCodeAt(i) === 10) { ++line; last = i; }
  return { line, character: offset - last - 1 };
}
function offsetAt(text, position) {
  let line = 0, i = 0;
  while (line < position.line && i < text.length) if (text.charCodeAt(i++) === 10) ++line;
  let end = text.indexOf('\n', i); if (end < 0) end = text.length;
  return Math.max(i, Math.min(end, i + Math.max(0, position.character)));
}
function lex(text) {
  const tokens = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const position = offset => {
    let lo = 0, hi = lineStarts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid; }
    return {line: lo, character: offset - lineStarts[lo]};
  };
  // Strings and comments are consumed, not indexed. JS offsets use UTF-16,
  // matching the default LSP position encoding.
  const re = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|^[ \t]*\#[^\r\n]*|[A-Za-z_][A-Za-z_0-9]*|(?:0[xX][\da-fA-F_]+|\d[\w]*)|[^\s]/gm;
  let match;
  while ((match = re.exec(text))) {
    const value = match[0];
    if (/^(?:\/\/|\/\*|"|'|[ \t]*#)/.test(value)) continue;
    tokens.push({ text: value, start: match.index, end: re.lastIndex,
      range: { start: position(match.index), end: position(re.lastIndex) } });
  }
  return tokens;
}
// Several P4_14 keywords are valid identifiers and extern type names in P4_16.
const LEGACY_NAMES = new Set(['metadata', 'register', 'counter', 'meter', 'direct_counter', 'direct_meter', 'action_profile', 'action_selector', 'field_list', 'blackbox']);
function identifier(t) {
  return !!t && /^[A-Za-z_]\w*$/.test(t.text) && (!KEYWORDS.has(t.text) || LEGACY_NAMES.has(t.text));
}
function indexDocument(text, uri = '') {
  const tokens = lex(text);
  const scopes = [{id:0, parent:null, start:0, end:text.length}];
  const stack = [0];
  const delimiters = new Map([['(', []], ['[', []]]);
  const closes = { ')': '(', ']': '[' };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]; t.index = i; t.scope = stack[stack.length - 1];
    if (delimiters.has(t.text)) delimiters.get(t.text).push(i);
    if (Object.hasOwn(closes, t.text)) {
      const open = delimiters.get(closes[t.text]).pop();
      if (open !== undefined) { t.pair = open; tokens[open].pair = i; }
    }
    if (t.text === '{') {
      const s = {id:scopes.length, parent:t.scope, start:t.start, end:text.length};
      scopes.push(s); t.childScope = s.id; stack.push(s.id);
    } else if (t.text === '}' && stack.length > 1) {
      scopes[stack.pop()].end = t.end;
    }
  }
  const declarations = [];
  function add(t, kind, detail, scope = t?.scope, props = {}) {
    if (!identifier(t) || t.declaration) return;
    const d = {name:t.text, kind, token:t, scope, detail, startOffset:t.start, ...props};
    t.declaration = d; declarations.push(d);
  }
  function nextBody(start) {
    let paren = 0, square = 0;
    for (let j = start; j < tokens.length; j++) {
      const v = tokens[j].text;
      if (v === '(') ++paren; else if (v === ')') --paren;
      else if (v === '[') ++square; else if (v === ']') --square;
      if (paren === 0 && square === 0 && v === '{') return tokens[j];
      if (paren === 0 && square === 0 && (v === ';' || v === '}')) break;
    }
  }
  // Find the base of T, T<...>, or a header stack T[N] before a name.
  function typeBefore(i) {
    let cursor = i - 1;
    if (tokens[cursor]?.text === ']') cursor = (tokens[cursor].pair ?? 0) - 1;
    if (tokens[cursor]?.text === '>') {
      let depth = 1;
      --cursor;
      while (cursor >= 0 && depth > 0) {
        const word = tokens[cursor--].text;
        if (word === '<') --depth;
        else if (word === '>') ++depth;
        else if ([';', '{', '}'].includes(word)) return;
      }
      if (depth) return;
    }
    const t = tokens[cursor];
    if (t && (identifier(t) || TYPE_KEYWORDS.has(t.text) || t.text === 'void')) return t;
  }
  function typeProps(type, name) {
    return {
      startOffset: type.start, typeName: type.text,
      display: text.slice(type.start, name.end).replace(/\s+/g, ' ').trim()
    };
  }
  const bodyTypes = new Map();
  const headerFields = new Map();
  function typeBody(name, body, kind, keyword) {
    add(name, kind, keyword.text, name.scope, {startOffset: keyword.start, bodyScope: body.childScope});
    bodyTypes.set(body.childScope, name.declaration);
  }
  function recordParameters(first, body, allowUntyped = false) {
    for (let j = first; j < body.index; ++j) {
      const t = tokens[j];
      if (!identifier(t) || ![',', ')', '='].includes(tokens[j + 1]?.text)) continue;
      if (allowUntyped && ['(', ','].includes(tokens[j-1]?.text)) {
        add(t, 13, 'parameter', body.childScope);
        continue;
      }
      const type = typeBefore(j);
      if (!type) continue;
      const before = tokens[type.index-1]?.text;
      if (!['(', ',', 'in', 'out', 'inout'].includes(before)) continue;
      add(t, 13, 'parameter', body.childScope, typeProps(type, t));
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], n = tokens[i + 1];
    if ((t.text === 'header' || t.text === 'metadata') && identifier(n)) {
      if (tokens[i + 2]?.text === '{') typeBody(n, tokens[i+2], 23, t);
      else if (identifier(tokens[i + 2])) {
        const name = tokens[i+2];
        add(name, 13, t.text + ' ' + n.text, name.scope, {...typeProps(n, name), startOffset:t.start});
      }
      continue;
    }
    if (t.text === 'enum') {
      indexEnum(tokens, t, text, identifier, add);
      continue;
    }
    if (!DECL_KEYWORDS.has(t.text)) continue;
    if (t.text === 'typedef' || t.text === 'type') {
      let j = i + 1;
      while (j < tokens.length && tokens[j].text !== ';' && tokens[j].text !== '{') ++j;
      if (tokens[j]?.text === ';' && identifier(tokens[j - 1]) && j > i + 2)
        add(tokens[j - 1], 26, t.text, t.scope, { startOffset:t.start, aliasOf:n.text });
      continue;
    }
    if (!identifier(n)) continue;
    if (['header_type','struct','header_union','extern'].includes(t.text)) {
      // extern R f(...) is a free function, whereas extern X<T> { ... } is a type.
      if (t.text === 'extern' && !['{','<'].includes(tokens[i+2]?.text)) continue;
      const body = nextBody(i+2);
      if (body) typeBody(n, body, DECL_KEYWORDS.get(t.text), t);
      continue;
    }
    // A legacy keyword may be the type in "extern register" or "counter c;".
    if (LEGACY_NAMES.has(t.text) && tokens[i+2]?.text !== '{') continue;
    add(n, DECL_KEYWORDS.get(t.text), t.text, n.scope, { startOffset:t.start });
    if (['action','control','parser','package'].includes(t.text)) {
      const body = nextBody(i + 2);
      if (body) recordParameters(i + 2, body, t.text === 'action');
    }
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].text !== 'fields' || tokens[i + 1].text !== '{') continue;
    const container = bodyTypes.get(tokens[i].scope);
    if (container?.detail !== 'header_type') continue;
    const fieldScope = tokens[i + 1].childScope;
    headerFields.set(fieldScope, container);
    for (let j = i + 2; j < tokens.length && tokens[j].scope === fieldScope; j++) {
      if (identifier(tokens[j]) && tokens[j + 1]?.text === ':') {
        let end = j+2;
        while (tokens[end] && ![';', '}'].includes(tokens[end].text)) ++end;
        add(tokens[j], 8, 'P4-14 field', fieldScope, {
          display:text.slice(tokens[j].start,tokens[end-1].end)
        });
      }
    }
  }
  // Return-type-led function declarations, fields, locals, and extern instances.
  for (let i = 1; i < tokens.length - 1; ++i) {
    const t = tokens[i], prev = tokens[i - 1], next = tokens[i + 1];
    if (!identifier(t) || t.declaration) continue;
    const isInstance = prev.text === ')' && prev.pair !== undefined && next.text === ';';
    const type = typeBefore(isInstance ? prev.pair : i);
    if (!type) continue;
    const before = tokens[type.index - 1]?.text;
    if (before && !['{','}',';',',','(',')','in','out','inout','const','extern','abstract'].includes(before)
        && tokens[type.index-1].range.end.line === type.range.start.line) continue;
    const container = bodyTypes.get(t.scope);
    let call = next;
    if (call.text === '<') {
      let depth = 1, j=i+2;
      while (j < tokens.length && depth && ![';', '{', '}'].includes(tokens[j].text)) {
        if (tokens[j].text === '<') ++depth;
        if (tokens[j].text === '>') --depth;
        ++j;
      }
      call = tokens[j] || next;
    }
    if (call.text === '(' && call.pair !== undefined) {
      const after = tokens[call.pair+1];
      if (after && [';', '{'].includes(after.text)) {
        const detail = container?.detail === 'extern' ? 'method' : 'function';
        const props = typeProps(type,t);
        if (before === 'extern' || before === 'abstract') props.startOffset = tokens[type.index-1].start;
        props.display = text.slice(props.startOffset,tokens[call.pair].end).replace(/\s+/g,' ');
        add(t, detail === 'method' ? 6 : 12, detail, t.scope, props);
        if (after.text === '{') recordParameters(call.index+1, after);
      }
      continue;
    }
    if (![';', '=', ',', '['].includes(next.text)) continue;
    const field = container && ['header','header_union','struct'].includes(container.detail);
    add(t, field ? 8 : 13, field ? 'field' : (isInstance ? 'instance' : 'variable or field'), t.scope, typeProps(type,t));
  }
  for (const d of declarations) {
    const container = headerFields.get(d.scope) || bodyTypes.get(d.scope);
    if (!container || !['field','P4-14 field','method'].includes(d.detail)) continue;
    d.isMember = true;
    (container.members ||= []).push(d);
  }
  const declarationsByScope = new Map();
  for (const declaration of declarations) {
    let names = declarationsByScope.get(declaration.scope);
    if (!names) declarationsByScope.set(declaration.scope, names = new Map());
    let sameName = names.get(declaration.name);
    if (!sameName) names.set(declaration.name, sameName = []);
    sameName.push(declaration);
  }
  return {text, uri, tokens, declarations, scopes, declarationsByScope};
}
function findTokenAt(index, pos) {
  const offset = offsetAt(index.text, pos);
  let lo = 0, hi = index.tokens.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (index.tokens[mid].end <= offset) lo = mid + 1; else hi = mid; }
  const tok = index.tokens[lo];
  if (tok && tok.start <= offset && offset < tok.end) return tok;
  // Cursor at the end of a token is common in editors.
  const before = index.tokens[lo - 1];
  return before && before.end === offset ? before : undefined;
}
function resolve(index, token) {
  if (!token || !identifier(token)) return undefined;
  if (token.declaration) return token.declaration;
  // Struct members require type information, which this syntax index lacks.
  if (index.tokens[token.index - 1]?.text === '.') return undefined;
  let scope = token.scope;
  while (scope !== null) {
    const candidates = index.declarationsByScope.get(scope)?.get(token.text) || [];
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return undefined;
    scope = index.scopes[scope].parent;
  }
  return undefined;
}
module.exports = { identifier, KEYWORDS, indexDocument, findTokenAt, resolve, positionAt, offsetAt };
