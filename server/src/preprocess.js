'use strict';

// Unknown is either an unspecified macro (the file may be included elsewhere)
// or an explicitly defined macro whose replacement is outside our evaluator.
const definedUnknown = Symbol('defined');
const unknown = null;
const identifier = /^[a-zA-Z_]\w*$/;
const maxInteger = (1n << 63n) - 1n;

function integer(token) {
  const match = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]*|[1-9]\d*)([uU]?[lL]{0,2}|[lL]{1,2}[uU])$/.exec(token);
  if (!match || match[1].length > 68) return unknown;
  const digits = match[1].replace(/^0([0-7]+)$/, '0o$1');
  const value = BigInt(digits);
  // Signed/unsigned conversions above INT64_MAX require target semantics.
  return value <= maxInteger ? value : unknown;
}

function lexicalValue(token, macros, depth = 0) {
  const literal = integer(token);
  if (literal !== unknown) return literal;
  if (!identifier.test(token) || depth > 24 || !macros.has(token)) return unknown;
  const value = macros.get(token);
  if (value === false) return 0n; // explicit #undef or -U
  if (typeof value !== 'string') return unknown;
  const simple = value.trim().replace(/^\(\s*([\w]+)\s*\)$/, '$1');
  return lexicalValue(simple, macros, depth + 1);
}

function truth(value) { return value === unknown ? unknown : value !== 0n; }
function evalCondition(source, macros) {
  // Each supported operator has C precedence. Reject unsupported syntax even
  // in a short-circuited branch. There is no eval() or host number coercion.
  const tokens = source.match(/&&|\|\||==|!=|<=|>=|\w+|[^\s]/g) || [];
  if (!tokens.length || tokens.length > 256) return unknown;
  let i = 0, invalid = false;
  function unary() {
    const token = tokens[i++];
    if (token === '!') {
      const value = unary();
      return value === unknown ? unknown : BigInt(!value);
    }
    if (token === '(') {
      const value = expression(1);
      if (tokens[i++] !== ')') invalid = true;
      return value;
    }
    if (token === 'defined') {
      const paren = tokens[i] === '(';
      if (paren) ++i;
      const name = tokens[i++];
      if (!name || !identifier.test(name) || (paren && tokens[i++] !== ')')) invalid = true;
      return macros.has(name) ? BigInt(macros.get(name) !== false) : unknown;
    }
    if (!token || !/^\w+$/.test(token)) { invalid = true; return unknown; }
    return lexicalValue(token, macros);
  }
  const ranks = { '||':1, '&&':2, '==':3, '!=':3, '<':4, '<=':4, '>':4, '>=':4 };
  function expression(min) {
    let left = unary();
    while (Object.hasOwn(ranks, tokens[i]) && ranks[tokens[i]] >= min) {
      const op = tokens[i++], right = expression(ranks[op] + 1);
      // An opaque macro might expand to multiple unparenthesized operators.
      // Even X && 0 cannot be folded if X could expand to "1 || 2".
      if (left === unknown || right === unknown) left = unknown;
      else {
        switch (op) {
          case '&&': left = BigInt(!!left && !!right); break;
          case '||': left = BigInt(!!left || !!right); break;
          case '==': left = BigInt(left === right); break;
          case '!=': left = BigInt(left !== right); break;
          case '<': left = BigInt(left < right); break;
          case '<=': left = BigInt(left <= right); break;
          case '>': left = BigInt(left > right); break;
          case '>=': left = BigInt(left >= right); break;
        }
      }
    }
    return left;
  }
  const result = expression(1);
  return invalid || i !== tokens.length ? unknown : truth(result);
}

function initialMacros(args) {
  const macros = new Map();
  for (let i=0; i<args.length; ++i) {
    const match = /^-([DU])(.*)$/.exec(args[i]);
    if (!match) continue;
    const argument = match[2] || args[++i] || '';
    const spec = /^([A-Za-z_]\w*)(?:=(.*))?$/.exec(argument);
    if (spec) macros.set(spec[1], match[1] === 'U' ? false : spec[2] ?? '1');
  }
  // A forced include runs after command-line definitions. Its effects are opaque.
  if (args.some(arg => /^-(?:include|imacros)/.test(arg))) macros.clear();
  return macros;
}

function merged(paths) {
  if (!paths.length) return new Map();
  if (paths.length === 1) return paths[0];
  const result = new Map();
  for (const [name, value] of paths[0]) {
    if (!paths.every(path => path.has(name))) continue;
    if (paths.every(path => path.get(name) === value)) result.set(name, value);
    else if (paths.every(path => path.get(name) !== false)) result.set(name, definedUnknown);
  }
  return result;
}

function stripComments(line, state) {
  let out = '', offset = 0;
  const scanner = /\/\*|\/\/|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/g;
  while (offset < line.length) {
    if (state.block) {
      const end = line.indexOf('*/', offset);
      if (end < 0) return out;
      out += ' '; offset = end + 2; state.block = false;
    }
    scanner.lastIndex = offset;
    const m = scanner.exec(line);
    if (!m) return out + line.slice(offset);
    out += line.slice(offset, m.index);
    if (m[0] === '//') return out;
    if (m[0] === '/*') { state.block = true; out += ' '; }
    else out += m[0];
    offset = scanner.lastIndex;
  }
  return out;
}

function addRange(ranges, start, end) {
  const previous = ranges.at(-1);
  if (previous?.end === start) previous.end = end;
  else ranges.push({start,end});
}

function directiveCondition(name, tail, macros) {
  if (name === 'if' || name === 'elif') return evalCondition(tail, macros);
  if (!identifier.test(tail) || !macros.has(tail)) return unknown;
  const exists = macros.get(tail) !== false;
  return name === 'ifdef' ? exists : !exists;
}

/**
 * Produce a position-preserving P4 view for the editor index. Offset units
 * are UTF-16; physical newlines remain unmodified. Retain every possible
 * branch if a condition is unknown. With optional readInclude({source,name,
 * quoted}) -> {id,text} | undefined the caller can process literal headers in
 * source order to propagate their macro state. An opaque include invalidates
 * all previous known values, because it may define or undefine any name.
 */
function preprocess(source, compilerArgs = [], options = {}) {
  const diagnostics = [], inactiveRanges = [], uncertainRanges = [], conditionals = [];
  const visiting = new Set();
  let budget = 4 * 1024 * 1024;
  function run(text, macros, origin, main) {
    if (!text.includes('#')) return macros;
    const stack = [], comments = {block:false};
    let enabled = true, certain = true, malformed = false;
    const report = (line, message) => {
      malformed = true;
      if (main) diagnostics.push({source:'p4-preprocessor', severity:1, message, range:{
        start:{line, character:0}, end:{line,character:1}
      }});
    };
    const lines = /([^\r\n]*)(\r\n|\n|\r|$)/g;
    let lineNo = 0, line;
    while (lines.lastIndex < text.length && (line = lines.exec(text))) {
      const start = line.index, lineStart = lineNo;
      let logical = line[1];
      while (logical.endsWith('\\') && line[2] && lines.lastIndex < text.length) {
        line = lines.exec(text); ++lineNo;
        logical = logical.slice(0,-1) + line[1];
      }
      ++lineNo;
      const clean = stripComments(logical, comments);
      const directive = /^\s*#\s*([A-Za-z_]\w*)(.*)$/.exec(clean);
      const name = directive?.[1], tail = directive?.[2].trim() || '';
      const control = ['if','ifdef','ifndef','elif','else','endif'].includes(name);
      if (main && control) addRange(conditionals, start, lines.lastIndex);
      if (main && !control) {
        if (!enabled) addRange(inactiveRanges,start,lines.lastIndex);
        else if (!certain) addRange(uncertainRanges,start,lines.lastIndex);
      }
      if (['if','ifdef','ifndef'].includes(name)) {
        const test = directiveCondition(name,tail,macros);
        stack.push({before: macros, enabled, certain, remaining:test !== true, branched:test === unknown, ends:[], line:lineStart, seenElse:false});
        macros = new Map(macros);
        enabled = enabled && test !== false;
        certain = certain && test === true;
      } else if (name === 'elif' || name === 'else') {
        const frame = stack.at(-1);
        if (!frame || frame.seenElse) { report(lineStart, 'Unexpected #' + name); continue; }
        if (enabled) frame.ends.push(macros);
        macros = new Map(frame.before);
        const test = name === 'else' ? true : directiveCondition(name,tail,macros);
        enabled = frame.enabled && frame.remaining && test !== false;
        certain = enabled && frame.certain && !frame.branched && test === true;
        if (test === unknown) frame.branched = true;
        if (test === true) frame.remaining = false;
        frame.seenElse = name === 'else';
      } else if (name === 'endif') {
        const frame = stack.pop();
        if (!frame) { report(lineStart,'Unexpected #endif'); continue; }
        if (enabled) frame.ends.push(macros);
        if (frame.remaining) frame.ends.push(frame.before);
        macros = frame.enabled ? merged(frame.ends) : frame.before;
        enabled = frame.enabled; certain = frame.certain;
      } else if (enabled && name === 'define') {
        const def = /^([A-Za-z_]\w*)(.*)$/.exec(tail);
        if (def) macros.set(def[1], def[2].startsWith('(') ? definedUnknown : def[2].trim());
      } else if (enabled && name === 'undef' && identifier.test(tail)) {
        macros.set(tail,false);
      } else if (enabled && (name === 'include' || name === 'include_next' || name === 'import')) {
        const m = /^(?:"([^"]+)"|<([^>]+)>)$/.exec(tail);
        const header = name === 'include' && m && options.readInclude?.({source:origin,name:m[1] ?? m[2],quoted:m[1] !== undefined});
        if (!header || visiting.has(header.id) || visiting.size >= 48 || budget < header.text.length) {
          macros = new Map(); continue;
        }
        budget -= header.text.length;
        visiting.add(header.id);
        macros = run(header.text,macros,header.id,false);
        visiting.delete(header.id);
      }
    }
    for (const frame of stack) report(frame.line,'Expected #endif');
    if (malformed && main) { inactiveRanges.length = 0; uncertainRanges.length = 0; }
    return malformed ? new Map() : macros;
  }
  run(source,initialMacros(compilerArgs),options.source || '',true);
  if (!inactiveRanges.length) return {text:source, diagnostics, inactiveRanges, uncertainRanges, conditionals};
  const chunks = [];
  let last = 0;
  for (const {start,end} of inactiveRanges) {
    chunks.push(source.slice(last,start), source.slice(start,end).replace(/[^\r\n]/g,' '));
    last = end;
  }
  chunks.push(source.slice(last));
  return {text:chunks.join(''), diagnostics, inactiveRanges, uncertainRanges, conditionals};
}
module.exports = { preprocess };
