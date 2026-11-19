'use strict';

// Only retain a small number of recently requested files. Every cache key is
// the actual buffer contents, so unsaved edits invalidate the lookup naturally.
const recent = new Map();
const EMPTY = { summary: '', params: Object.freeze(Object.create(null)), returns: '' };

function parseComment(lines) {
  const summary = [], params = Object.create(null), returns = [];
  let paragraph = summary;
  for (const line of lines) {
    const text = line.trim();
    const param = /^[@\\]param(?:\s*\[[^\]]*\])?\s+(\w+)\b\s*(?:[-:]\s*)?(.*)$/i.exec(text);
    const result = /^[@\\]returns?\b\s*(.*)$/i.exec(text);
    if (param) {
      paragraph = params[param[1]] ??= [];
      paragraph.push(param[2]);
    } else if (result) {
      paragraph = returns;
      paragraph.push(result[1]);
    } else if (/^[@\\](brief|details?|description)\b/i.test(text)) {
      paragraph = summary;
      paragraph.push(text.replace(/^[@\\]\w+\s*/i, ''));
    } else {
      paragraph.push(text);
    }
  }
  for (const name of Object.keys(params)) params[name] = params[name].join('\n').trim();
  return { summary: summary.join('\n').trim(), params, returns: returns.join('\n').trim() };
}

// Skip a whole annotation, including balanced nested arguments and quoted
// delimiters, so annotation identifiers do not steal the following doc comment.
function annotationEnd(text, end) {
  let i = end;
  while (/\s/.test(text[i] || '\0')) ++i;
  if (text[i] !== '(' && text[i] !== '[') return end;
  const stack = [];
  for (; i < text.length; ++i) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      while (++i < text.length && text[i] !== quote) if (text[i] === '\\') ++i;
    } else if (text.startsWith('/*', i)) {
      const closing = text.indexOf('*/', i + 2);
      if (closing < 0) return text.length;
      i = closing + 1;
    } else if (text.startsWith('//', i)) {
      const closing = text.indexOf('\n', i + 2);
      if (closing < 0) return text.length;
      i = closing;
    } else if (c === '(' || c === '[') {
      stack.push(c === '(' ? ')' : ']');
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return text.length;
}

function indexDocs(text) {
  const entries = new Map();
  const tokenPattern = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|@\w+|[A-Za-z_]\w*|[^\s]/g;
  let lines = [], annotations = [], docs = null;
  function reset() {
    lines = [];
    annotations = [];
    docs = null;
  }
  let token;
  while ((token = tokenPattern.exec(text))) {
    const value = token[0];
    if (/^\s/.test(value)) {
      if (/\n[^\S\n]*\n/.test(value)) reset();
      continue;
    }
    if (value.startsWith('//') || value.startsWith('/*')) {
      const beforeOnLine = text.slice(text.lastIndexOf('\n', token.index - 1) + 1, token.index).trimEnd();
      if (beforeOnLine && !beforeOnLine.endsWith('{')) { reset(); continue; }
      if (/^(?:\/\/[!/]?|\/\*[!*]?)</.test(value)) { reset(); continue; } // trailing doc
      if (value.startsWith('//')) {
        lines.push(value.replace(/^\/\/[!/]?\s?/, ''));
      } else {
        const body = value.slice(2, value.endsWith('*/') ? -2 : undefined).replace(/^[!*]/, '');
        for (const line of body.split(/\r?\n/)) lines.push(line.replace(/^\s*\*\s?/, ''));
      }
      docs = null;
      continue;
    }
    if (value.startsWith('@')) {
      const end = annotationEnd(text, tokenPattern.lastIndex);
      if (value === '@brief' || value === '@description') {
        const arg = /^\s*\(\s*("(?:\\[\s\S]|[^"\\])*")\s*\)$/.exec(text.slice(tokenPattern.lastIndex, end));
        if (arg) {
          let caption;
          try { caption = JSON.parse(arg[1]); } catch { caption = arg[1].slice(1, -1); }
          annotations.push(caption);
        }
      }
      tokenPattern.lastIndex = end;
      continue;
    }
    if (/[;{}()=#]/.test(value[0])) { reset(); continue; }
    if (!lines.length && !annotations.length) continue;
    // Keep the mapping through qualifiers/types up to the name, until the
    // opening parenthesis, semicolon or body. Either offset works for callers.
    if (!docs) {
      docs = parseComment(lines);
      docs.summary = [...new Set([docs.summary, ...annotations].filter(Boolean))].join('\n\n');
    }
    entries.set(token.index, docs);
  }
  return entries;
}

function declarationDocs(text, declarationStartOffset) {
  let entries = recent.get(text);
  if (!entries) {
    entries = indexDocs(text);
    if (recent.size >= 6) recent.delete(recent.keys().next().value);
    recent.set(text, entries);
  }
  return entries.get(declarationStartOffset) || EMPTY;
}

// Treat every punctuation character in source docs as literal Markdown. In
// particular, image links and raw HTML in an untrusted SDK cannot create UI.
function escapeMarkdown(value) { return value.replace(/[!-\/:-@\[-`{-~]/g, '\\$&'); }

function docsMarkdown(docs) {
  const parts = [];
  if (docs.summary) parts.push(escapeMarkdown(docs.summary));
  for (const [name, text] of Object.entries(docs.params)) {
    parts.push('**' + escapeMarkdown(name) + '** — ' + escapeMarkdown(text));
  }
  if (docs.returns) parts.push('**Returns** — ' + escapeMarkdown(docs.returns));
  return parts.join('\n\n');
}

module.exports = { declarationDocs, docsMarkdown };
