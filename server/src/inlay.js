'use strict';

const { identifier, resolve } = require('./indexer');
const { signatureIndex, callableTargets, primitiveParams } = require('./signatures');
const { dialect } = require('./dialect');
const { macroTargets } = require('./macros');

const cache = new WeakMap();

function compare(a, b) {
  return a.line - b.line || a.character - b.character;
}

function argumentAt(doc, after, until, firstToken, lastToken, lineStarts) {
  // The P4 lexer omits comments and string literals. Read their original text
  // so that an argument starting with a string/cast/unary operator is labelled
  // at its real beginning, with UTF-16 columns even after comments with emoji.
  const trivia = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
  trivia.lastIndex = after;
  trivia.exec(doc.text);
  const start = trivia.lastIndex;
  if (start >= until) return null;
  let low = 0, high = lineStarts.length;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (lineStarts[mid] <= start) low = mid; else high = mid;
  }
  const tokens = doc.index.tokens;
  const first = tokens[firstToken], last = tokens[lastToken];
  const named = first?.start === start && firstToken < lastToken && identifier(first) &&
    tokens[firstToken+1]?.text === '=' && tokens[firstToken+2]?.text !== '=';
  let isSimple = first?.start === start && last && firstToken <= lastToken;
  for (let i = firstToken; isSimple && i <= lastToken; ++i) {
    isSimple = (i-firstToken) % 2 ? tokens[i].text === '.' : identifier(tokens[i]);
  }
  return {
    position: {line: low, character: start - lineStarts[low]},
    named,
    obviousName: isSimple && identifier(last) ? last.text : null
  };
}

function callsIn(doc) {
  if (cache.has(doc.index)) return cache.get(doc.index);
  const { tokens } = doc.index;
  const { pairs } = signatureIndex(doc);
  const lineStarts = [0];
  for (let i = 0; i < doc.text.length; i++) if (doc.text[i] === '\n') lineStarts.push(i+1);
  const calls = [];
  for (const token of tokens) {
    if ((!identifier(token) && token.text !== 'apply') || token.declaration ||
        tokens[token.index-1]?.text === '@') continue;
    let open = token.index + 1;
    if (tokens[open]?.text === '<') open = (pairs.get(open) ?? -2) + 1;
    const close = pairs.get(open);
    if (tokens[open]?.text !== '(' || close == null) continue;
    const args = [];
    let previous = open;
    for (let i = open+1; i <= close; ++i) {
      const t = tokens[i];
      if (i < close && t.text !== ',') {
        const end = pairs.get(i);
        if (end > i && (t.text !== '<' || tokens[end+1]?.text === '(')) i = end;
        continue;
      }
      const arg = argumentAt(doc, tokens[previous].end, t.start, previous+1, i-1, lineStarts);
      if (!arg) { args.length = 0; break; }  // empty call or incomplete argument
      args.push(arg);
      previous = i;
    }
    if (args.length && !args.every(arg=>arg.named)) calls.push({token, args});
  }
  cache.set(doc.index,calls);
  return calls;
}

function parameterNames(doc, token, count, deps, language) {
  // A variable which shadows an outer action/function must not inherit its names.
  const binding = resolve(doc.index,token);
  if (binding && ['parameter','variable or field','field'].includes(binding.detail)) return null;
  const targets = callableTargets(doc,token,deps);
  if (targets.length) {
    if (targets.some(t=>t.entry.token === token)) return null;  // extern constructor in a declaration
    const matches = targets.filter(({entry})=> entry.params.length >= count &&
      entry.params.slice(count).every(p=>p.label.includes('=')));
    return matches.length === 1 ? matches[0].entry.params.slice(0,count).map(p=>p.name) : null;
  }
  if (doc.index.tokens[token.index-1]?.text === '.') return null;
  const macros = macroTargets(doc,token.text,deps,token.start);
  if (macros.length) {
    if (macros.length !== 1 || macros[0].conditional || macros[0].parameters?.length !== count) return null;
    return macros[0].parameters;
  }
  if (language === 'p4-14') {
    const params = primitiveParams.get(token.text);
    if (params && (params.length === count || (token.text === 'modify_field' && count === 2)))
      return params.slice(0,count);
  }
  return null;
}

/** Parameter-name inlays for complete, unambiguous calls intersecting an LSP range. */
function inlayHints(doc, range, dependencies = [], language = 'auto') {
  const result = [], lang = dialect(doc,language);
  const afterEnd = p => range && compare(p,range.end)>=0;
  const beforeStart = p => range && compare(p,range.start)<0;
  for (const {token,args} of callsIn(doc)) {
    if (afterEnd(token.range.start)) break;
    if (beforeStart(args[args.length-1].position)) continue;
    const names = parameterNames(doc,token,args.length,dependencies,lang);
    if (!names) continue;
    for (const [i,arg] of args.entries()) {
      const name = names[i];
      if (!name || arg.named || name === '_' || name === arg.obviousName ||
          beforeStart(arg.position) || afterEnd(arg.position)) continue;
      result.push({position:arg.position,label:name+':',kind:2,paddingRight:true});
    }
  }
  return result.sort((a,b)=>compare(a.position,b.position));
}
module.exports = {inlayHints};
