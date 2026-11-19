'use strict';
const { offsetAt, findTokenAt } = require('./indexer');
const { declarationDocs } = require('./docs');

const cache = new WeakMap();
function withoutComments(text) {
  // Keep UTF-16 offsets and line breaks. C line splicing also continues // comments.
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?(?:\*\/|$)|\/\/(?:\\\r?\n|[^\r\n])*/g;
  return text.replace(tokens, s => s.startsWith('/') ? s.replace(/[^\r\n]/g,' ') : s);
}
function indexMacros(doc) {
  if (cache.has(doc.index)) return cache.get(doc.index);
  const text = withoutComments(doc.activeText ?? doc.text), events = new Map(), definitions = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  function position(offset) {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle] <= offset) low = middle; else high = middle;
    }
    return {line: low, character: offset - lineStarts[low]};
  }
  let depth = 0;
  for (let i = 0; i < lineStarts.length; ++i) {
    const start = lineStarts[i];
    // Consume complete logical lines, including ordinary continued source, to
    // avoid treating replacement-list text or multiline strings as directives.
    let end = lineStarts[i + 1] ?? text.length;
    while (i + 1 < lineStarts.length && /\\\r?\n$/.test(doc.text.slice(Math.max(start, end - 3), end)))
      end = lineStarts[++i + 1] ?? text.length;
    const line = text.slice(start, end).replace(/\\\r?\n/g, m => ' '.repeat(m.length));
    const directive = /^(\s*#\s*)([A-Za-z_]\w*)\b/.exec(line);
    if (!directive) continue;
    const action = directive[2];
    if (['if','ifdef','ifndef'].includes(action)) { ++depth; continue; }
    if (action === 'endif') { depth = Math.max(0, depth - 1); continue; }
    if (action !== 'define' && action !== 'undef') continue;
    const head = /^(\s+)([A-Za-z_]\w*)/.exec(line.slice(directive[0].length));
    if (!head) continue;
    const name = head[2], nameStart = start + directive[0].length + head[1].length;
    const token = { text: name, start: nameStart, end: nameStart + name.length,
      range: { start: position(nameStart), end: position(nameStart + name.length) } };
    const event = { name, action, conditional: depth > 0, token };
    if (!events.has(name)) events.set(name, []);
    events.get(name).push(event);
    if (action === 'undef') continue;
    const tail = line.slice(token.end - start).trimEnd();
    let parameters = null;
    if (tail.startsWith('(')) {
      const close = tail.indexOf(')');
      if (close < 0) continue;
      const inner = tail.slice(1, close).trim();
      parameters = inner ? inner.split(',').map(p => p.trim()) : [];
      if (!parameters.every(p => /^(?:[A-Za-z_]\w*(?:\.\.\.)?|\.\.\.)$/.test(p))) continue;
    }
    const signature = parameters === null ? name : name + '(' + parameters.join(', ') + ')';
    const value = parameters === null ? tail.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    const label = '#define ' + signature + (value ? ' ' + value : '');
    const hash = start + line.indexOf('#');
    event.definition = { doc, declaration: { name, token, startOffset: hash, detail: 'macro', display: label, scope: 0, kind: 14 }, parameters, label };
    definitions.push(event);
  }
  const index = { events, definitions };
  cache.set(doc.index, index);
  return index;
}
function annotated(event, uncertain) {
  const base = event.definition;
  if (!base.docs) {
    const hash = base.declaration.startOffset;
    const before = base.doc.text.slice(Math.max(0, hash - 16384), hash);
    base.docs = declarationDocs(before + 'macro_doc', before.length);
  }
  return { ...base, conditional: uncertain || event.conditional };
}
function candidates(file, name, offset) {
  let values = [], hidesEarlier = false, conditionalUndef = false;
  for (const event of indexMacros(file).events.get(name) || []) {
    if (event.token.start > offset) break;
    if (!event.conditional) { values = []; hidesEarlier = true; conditionalUndef = false; }
    if (event.action === 'define' && event.definition) values.push(event);
    if (event.action === 'undef' && event.conditional) conditionalUndef = true;
  }
  return { values, hidesEarlier, conditionalUndef };
}
// Include order and preprocessor expressions are not evaluated. Return text
// candidates from visible headers, preserving alternatives from conditional branches.
function macroTargets(doc, name, dependencies = [], offset = doc.text.length) {
  const local = candidates(doc, name, offset);
  const results = local.values.map(e => annotated(e, local.conditionalUndef));
  if (!local.hidesEarlier) {
    for (const dep of dependencies) {
      if (dep === doc) continue;
      const found = candidates(dep, name, dep.text.length);
      for (const event of found.values) results.push(annotated(event, local.conditionalUndef || found.conditionalUndef));
    }
  }
  return results;
}
function macroAt(doc, position, dependencies = []) {
  const offset = offsetAt(doc.text, position);
  const own = indexMacros(doc).definitions.find(({token}) => token.start <= offset && offset < token.end);
  if (own) return [annotated(own, false)];
  const token = findTokenAt(doc.index, position);
  return token && /^[A-Za-z_]\w*$/.test(token.text) ? macroTargets(doc, token.text, dependencies, offset) : [];
}
module.exports = { macroTargets, macroAt, indexMacros };
