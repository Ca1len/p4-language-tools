'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { StringDecoder } = require('node:string_decoder');

const MAX_RESULTS = 250;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_TIME_MS = 5000;
const EXTENSIONS = new Set(['.p4', '.p4inc', '.p4i', '.p4_14', '.p4_16']);
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist']);
const identifierChar = char => char !== undefined && /[a-zA-Z_0-9]/.test(char);

function addLine(results, uri, line, lineNumber, query) {
  let start = line.indexOf(query);
  while (start >= 0 && results.length < MAX_RESULTS) {
    const end = start + query.length;
    if (!identifierChar(line[start - 1]) && !identifierChar(line[end])) {
      // String indices in JS are UTF-16, the position encoding used by VS Code.
      const snippet = line.slice(Math.max(0, start - 50), end + 80).trim();
      results.push({ name: query, kind: 13, containerName: snippet, location: {
        uri, range: { start: { line: lineNumber, character: start }, end: { line: lineNumber, character: end } }
      } });
    }
    start = line.indexOf(query, end);
  }
}

function searchBuffer(results, uri, text, query) {
  if (text.includes('\0')) return;
  let line = 0, offset = 0;
  while (offset < text.length && results.length < MAX_RESULTS) {
    const next = text.indexOf('\n', offset);
    const end = next < 0 ? text.length : next;
    addLine(results, uri, text.slice(offset, end), line++, query);
    offset = end + 1;
  }
}

function searchWithRg(roots, openFiles, query, results, deadline) {
  return new Promise(resolve => {
    const args = ['--no-config', '--json', '--fixed-strings', '--max-filesize', '2M'];
    for (const ext of EXTENSIONS) args.push('--iglob', '*' + ext);
    for (const dir of SKIP_DIRS) args.push('--glob', '!**/' + dir + '/**');
    args.push('--', query, ...roots);
    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
    let partial = '', done = false;
    const decoder = new StringDecoder('utf8');
    function stop() {
      done = true;
      child.kill();
    }
    child.stdout.on('data', chunk => {
      if (done) return;
      const lines = (partial + decoder.write(chunk)).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== 'match') continue;
        const { path: filename, lines: source, line_number: number } = event.data;
        if (!filename?.text || !source?.text || openFiles.has(path.resolve(filename.text))) continue;
        addLine(results, pathToFileURL(filename.text).href, source.text, number - 1, query);
        if (results.length >= MAX_RESULTS) { stop(); break; }
      }
      // A large line can expand to many megabytes of JSON submatch metadata.
      if (partial.length > 4 * MAX_FILE_BYTES) stop();
    });
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', code => { clearTimeout(timer); resolve(done || code === 0 || code === 1); });
  });
}

async function searchWithNode(roots, openFiles, query, results, deadline) {
  const pending = [...roots];
  let inspected = 0;
  while (pending.length && results.length < MAX_RESULTS && inspected < 100000 && Date.now() < deadline) {
    const dir = pending.pop();
    let handle;
    try {
      handle = await fs.opendir(dir);
      for await (const entry of handle) {
        if (++inspected >= 100000 || results.length >= MAX_RESULTS || Date.now() >= deadline) break;
        if (entry.name.startsWith('.')) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) pending.push(file);
          continue;
        }
        if (!entry.isFile() || openFiles.has(file) || !EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
        try {
          if ((await fs.stat(file)).size > MAX_FILE_BYTES) continue;
          searchBuffer(results, pathToFileURL(file).href, await fs.readFile(file, 'utf8'), query);
        } catch { /* Files can disappear during a workspace search. */ }
      }
    } catch { /* Skip unreadable directories. */ }
  }
}

/** Search P4 source for complete identifiers, including comments and directives. */
async function searchText(query, roots, openDocs) {
  if (typeof query !== 'string' || query.length > 256 || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(query)) return [];
  const deadline = Date.now() + SEARCH_TIME_MS;
  const results = [], openFiles = new Set();
  for (const doc of openDocs) {
    if (!doc.open || !doc.uri || typeof doc.text !== 'string') continue;
    try { openFiles.add(fileURLToPath(doc.uri)); } catch { /* Untitled buffer. */ }
    if (doc.text.length <= MAX_FILE_BYTES) searchBuffer(results, doc.uri, doc.text, query);
    if (results.length === MAX_RESULTS || Date.now() >= deadline) return results;
  }
  // Nested workspace roots must not cause duplicate hits.
  const dirs = [...new Set(Array.from(roots, dir => path.resolve(dir)))].sort((a,b) => a.length - b.length);
  const uniqueRoots = dirs.filter((dir, i) => !dirs.slice(0, i).some(parent => {
    const rel = path.relative(parent, dir);
    return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
  }));
  if (uniqueRoots.length) {
    const diskStart = results.length;
    if (!await searchWithRg(uniqueRoots, openFiles, query, results, deadline)) {
      results.length = diskStart;
      await searchWithNode(uniqueRoots, openFiles, query, results, deadline);
    }
  }
  return results;
}
module.exports = { searchText };
