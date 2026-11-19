'use strict';

const path = require('node:path');

// Cache directive locations for the current buffer, including unsaved edits.
// Keep offsets intact while blanking comments. Quoted text is consumed as a
// unit so comment markers inside a string cannot hide subsequent directives.
const byIndex = new WeakMap();
function directives(doc) {
  if (byIndex.has(doc.index)) return byIndex.get(doc.index);
  const cleaned = (doc.activeText ?? doc.text).replace(/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
    match => match.startsWith('"') ? match : match.replace(/[^\r\n]/g, ' '));
  const includes = [];
  const pattern = /^[ \t]*#[ \t]*include[ \t]*(?:"([^"\r\n]+)"|<([^>\r\n]+)>)/gm;
  for (const m of cleaned.matchAll(pattern)) {
    const name = m[1] ?? m[2];
    const end = m.index + m[0].length;
    includes.push({ name, quoted: m[1] !== undefined, start: end - name.length - 2, end });
  }
  byIndex.set(doc.index, includes);
  return includes;
}

function pathsFor(include, sourcePath, includePaths) {
  const dirs = include.quoted ? [path.dirname(sourcePath), ...includePaths] : includePaths;
  return dirs.map(dir => path.resolve(dir, include.name));
}
module.exports = { directives, pathsFor };
