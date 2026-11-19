'use strict';

const { resolve, identifier } = require('./indexer');
const { memberCandidates, builtinInfo } = require('./members');
const { indexMacros, macroTargets } = require('./macros');

const legend = {
  tokenTypes: ['type', 'class', 'struct', 'enum', 'enumMember', 'function', 'method', 'parameter',
    'property', 'variable', 'macro', 'decorator', 'label', 'typeParameter', 'p4Table', 'p4ParserState'],
  tokenModifiers: ['declaration', 'readonly', 'defaultLibrary']
};
const typeIndex = new Map(legend.tokenTypes.map((name, index) => [name, index]));
const declarationBit = 1, readonlyBit = 2, libraryBit = 4;

const indexedKinds = new Map([
  ['header', 'struct'], ['struct', 'struct'], ['header_type', 'struct'], ['header_union', 'struct'],
  ['enum', 'enum'], ['enum member', 'enumMember'], ['extern', 'class'], ['package', 'class'], ['parser', 'class'], ['control', 'class'],
  ['action', 'function'], ['primitive_action', 'function'], ['function', 'function'], ['method', 'method'],
  ['parser_exception', 'p4ParserState'], ['state', 'p4ParserState'], ['table', 'p4Table'],
  ['parameter', 'parameter'], ['field', 'property'], ['P4-14 field', 'property'],
  ['typedef', 'type'], ['type', 'type']
]);
const primitiveTypes = new Set(['bit','int','varbit','bool','string','void','tuple','list']);
const legacyPrimitives = new Set(['modify_field', 'add_header', 'remove_header', 'add_to_field',
  'subtract_from_field', 'drop', 'no_op', 'extract', 'set_metadata', 'verify_checksum', 'update_checksum']);
const word = value => /^[a-zA-Z_]\w*$/.test(value || '');
const combinedCache = new WeakMap();

function indexedRole(doc, declaration) {
  const tokens = doc.index.tokens, t = declaration.token;
  if (declaration.detail === 'parser' && tokens[t.index + 1]?.text === '{') return 'p4ParserState';
  return indexedKinds.get(declaration.detail) || 'variable';
}

function supplements(doc) {
  // Features missing from the navigation index can still be highlighted when
  // their declaration has an unambiguous syntactic shape.
  if (combinedCache.has(doc.index)) return combinedCache.get(doc.index);
  const { tokens, declarations } = doc.index;
  const offsets = new Map(tokens.map(t => [t.start, t.index]));
  const byToken = new Map(), enums = new Map(), matchKinds = new Set();
  const genericScopes = new Map(), readonly = new Set();
  for (const d of declarations) {
    const typePos = offsets.get(d.startOffset);
    if (tokens[typePos - 1]?.text === 'const') readonly.add(d);
    if (!['method', 'function', 'package', 'control', 'parser', 'extern'].includes(d.detail)) continue;
    let next = d.token.index + 1;
    if (tokens[next]?.text === '<') {
      const params = new Set();
      let i = next + 1;
      for (; i < tokens.length && identifier(tokens[i]); i += 2) {
        if (![',', '>'].includes(tokens[i + 1]?.text)) break;
        params.add(tokens[i].text);
        byToken.set(tokens[i], ['typeParameter', declarationBit]);
        if (tokens[i + 1].text === '>') { next = i + 2; break; }
      }
      if (d.bodyScope !== undefined && params.size) genericScopes.set(d.bodyScope, params);
    }
    // Parameters of a prototype lack a body scope in the navigation index.
    const open = tokens[next], close = open?.pair;
    if (open?.text !== '(' || close === undefined || tokens[close + 1]?.text !== ';') continue;
    let depth = 0, lastName;
    for (let i = next + 1; i <= close; ++i) {
      const t = tokens[i];
      if (!depth && (t.text === ',' || i === close)) {
        if (lastName) byToken.set(lastName, ['parameter', declarationBit]);
        lastName = undefined;
      } else if (['<','[','('].includes(t.text)) {
        ++depth;
      } else if (['>',']',')'].includes(t.text)) {
        if (depth > 0) --depth;
      } else if (!depth && t.text === '=') {
        while (i + 1 < close && tokens[i + 1].text !== ',') ++i;
      } else if (!depth && identifier(t)) {
        lastName = t;
      }
    }
  }
  for (let i = 0; i < tokens.length; ++i) {
    const kw = tokens[i].text;
    if (!['enum','error','match_kind'].includes(kw)) continue;
    let brace = i + 1;
    if (kw === 'enum') {
      while (brace < tokens.length && (brace - i < 16) && ![';', '{', '}'].includes(tokens[brace].text)) ++brace;
    }
    if (tokens[brace]?.text !== '{') continue;
    const name = kw === 'enum' ? tokens[brace - 1] : tokens[i];
    if (!word(name.text)) continue;
    if (kw === 'enum') byToken.set(name, ['enum', declarationBit]);
    const enumMembers = enums.get(name.text) || new Set();
    enums.set(name.text, enumMembers);
    const scope = tokens[brace].childScope;
    for (let j = brace + 1; j < tokens.length && tokens[j].scope === scope; ++j) {
      const t = tokens[j];
      if (!identifier(t) || !['{', ','].includes(tokens[j-1].text)) continue;
      byToken.set(t, ['enumMember', declarationBit | readonlyBit]);
      enumMembers.add(t.text);
      if (kw === 'match_kind') matchKinds.add(t.text);
    }
  }
  const supplemental = { byToken, enums, matchKinds, genericScopes, readonly };
  combinedCache.set(doc.index, supplemental);
  return supplemental;
}

function externals(files) {
  const names = new Map(), enums = new Map(), matchKinds = new Set(), macros = new Set();
  for (const file of files) {
    const supplemental = supplements(file);
    for (const [name, members] of supplemental.enums) {
      if (!enums.has(name)) enums.set(name, new Set());
      for (const member of members) enums.get(name).add(member);
    }
    for (const name of supplemental.matchKinds) matchKinds.add(name);
    for (const name of indexMacros(file).events.keys()) macros.add(name);
    if (file === files[0]) continue;
    for (const [name, declarations] of file.index.declarationsByScope.get(0) || []) {
      if (!names.has(name)) names.set(name, []);
      for (const d of declarations) names.get(name).push({ doc:file, declaration:d });
    }
  }
  return {names, enums, matchKinds, macros};
}

function skipDirectiveLines(text) {
  const skip = new Set();
  let continued = false;
  for (const [i, line] of text.split('\n').entries()) {
    if (continued || /^[ \t]*#/.test(line)) {
      skip.add(i);
      continued = /\\\r?$/.test(line);
    }
  }
  return skip;
}

function semanticTokens(doc, {dependencies = [], language = 'auto', isInactiveLine = () => false} = {}) {
  const visible = [doc, ...dependencies.filter(dep => dep !== doc)];
  const { tokens } = doc.index, extra = supplements(doc), globals = externals(visible);
  const skip = skipDirectiveLines(doc.text);
  const records = [];
  function emit(token, role, flags = 0) {
    if (!isInactiveLine(token.range.start.line)) records.push({ token, role, flags });
  }
  for (const event of indexMacros(doc).definitions) emit(event.token, 'macro', declarationBit);
  for (const t of tokens) {
    if (!word(t.text) || skip.has(t.range.start.line) || isInactiveLine(t.range.start.line)) continue;
    const prev = tokens[t.index-1]?.text, next = tokens[t.index+1]?.text;
    if (prev === '@') { emit(t, 'decorator'); continue; }
    const special = extra.byToken.get(t);
    if (special) { emit(t, ...special); continue; }
    if (globals.macros.has(t.text) && macroTargets(doc,t.text,dependencies,t.start).length) {
      emit(t, 'macro'); continue;
    }
    let d = t.declaration;
    let owner = doc;
    if (prev === '.' && !d) {
      if (globals.enums.get(tokens[t.index-2]?.text)?.has(t.text)) {
        emit(t, 'enumMember', readonlyBit); continue;
      }
      const members = memberCandidates(doc, t, visible);
      if (members.length) { emit(t, indexedRole(members[0].doc, members[0].declaration)); continue; }
      if (builtinInfo(doc, t, visible, language)) emit(t, 'method', libraryBit);
      continue;
    }
    // Reserved keywords (other than declarations) belong to TextMate. A proven
    // semantic declaration takes precedence e.g. register is a P4_16 extern.
    if (primitiveTypes.has(t.text)) { emit(t, 'type', libraryBit); continue; }
    if (!d) d = resolve(doc.index, t);
    if (!d) {
      const matches = globals.names.get(t.text);
      if (matches?.length && matches.every(m => indexedRole(m.doc,m.declaration) === indexedRole(matches[0].doc,matches[0].declaration))) {
        d = matches[0].declaration; owner = matches[0].doc;
      }
    }
    if (d) {
      const flags = (d === t.declaration ? declarationBit : 0) | (supplements(owner).readonly.has(d) ? readonlyBit : 0);
      emit(t, indexedRole(owner,d), flags);
    } else if (globals.enums.has(t.text)) {
      emit(t, 'enum');
    } else if (globals.matchKinds.has(t.text)) {
      emit(t, 'enumMember', readonlyBit);
    } else if (t.text === 'accept' || t.text === 'reject') {
      if (language !== 'p4-14') emit(t, 'p4ParserState', libraryBit);
    } else if (language === 'p4-14' && next === '(' && legacyPrimitives.has(t.text)) {
      emit(t, 'function', libraryBit);
    } else {
      for (let scope = t.scope; scope != null; scope = doc.index.scopes[scope].parent) {
        if (extra.genericScopes.get(scope)?.has(t.text)) { emit(t, 'typeParameter'); break; }
      }
    }
  }
  records.sort((left, right) => left.token.start - right.token.start);
  const data = [];
  let line = 0, column = 0;
  for (const {token, role, flags} of records) {
    const pos = token.range.start;
    data.push(pos.line-line, pos.line === line ? pos.character-column : pos.character,
      token.end-token.start, typeIndex.get(role), flags);
    line = pos.line;
    column = pos.character;
  }
  return { data };
}
module.exports = { legend, semanticTokens };
