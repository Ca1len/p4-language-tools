'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const activeCompilers = new Set();
process.once('exit', () => { for (const stop of activeCompilers) stop(); });

function readLocation(lines, i, cwd, indent) {
  const headline = lines[i].slice(indent.length).trimStart();
  const p4c = /^(.*?)\((\d+)(?:\s*[, :]\s*(\d+))?\)(?::\s*(.*))?$/.exec(headline);
  const match = p4c || /^(.*?):(\d+)(?::(\d+))?:\s*(.*)$/.exec(headline);
  if (!match) return;
  const [, filename, lineNumber, col, body] = match;
  if (!filename || filename.startsWith('<')) return;
  const line = Math.max(0, Number(lineNumber) - 1);
  let character = col ? Math.max(0, Number(col) - 1) : 0;
  let end = character + 1;
  // p4c prefixes every line of an explanation with the same indentation.
  // Strip it from the rendered source and marker, preserving source indentation.
  const sourceLine = lines[i + 1], markerLine = lines[i + 2];
  const caret = sourceLine?.startsWith(indent) && markerLine?.startsWith(indent) &&
    /^([ \t]*)(\^+~*)[ \t]*$/.exec(markerLine.slice(indent.length));
  let excerpt;
  if (caret) {
    excerpt = sourceLine.slice(indent.length);
    if (!col) character = caret[1].length;
    end = character + caret[2].length;
    if (p4c && /[^\x00-\x7f]/.test(excerpt)) {
      const bytes = Buffer.from(excerpt);
      character = bytes.toString('utf8', 0, character).length;
      end = bytes.toString('utf8', 0, end).length;
    }
  }
  const uri = pathToFileURL(path.resolve(cwd, filename)).href;
  const range = { start: { line, character }, end: { line, character: end } };
  return { location: { uri, range }, body, excerpt };
}

/**
 * Parse the P4 and GCC diagnostic formats. The primary message is published
 * at its own location. p4c's subordinate excerpts are navigable LSP related
 * information and do not inflate the number of errors in the editor.
 */
function parseDiagnostics(output, cwd, source = 'p4test') {
  const lines = output.replace(ANSI, '').split(/\r?\n/);
  const result = [];
  let primary, section, indent = '', related;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^([ \t]*)---- (Actual error|Originating from):\s*$/.exec(line);
    if (primary && heading) {
      [, indent, section] = heading;
      related = undefined;
      continue;
    }
    const inSection = section && line.startsWith(indent) && line.trim();
    const entry = readLocation(lines, i, cwd, inSection ? indent : '');
    const diagnosis = entry?.body && /^(?:\[([^\]]+)\]\s*)?(?:(fatal error|error|warning|note|info):\s*(.*)|(syntax error\b.*))$/i.exec(entry.body);
    if (diagnosis) {
      const [, option, kind = 'error', message, syntaxError] = diagnosis;
      const code = /^--W(?:error|warn|disable)=(.+)$/.exec(option || '')?.[1];
      primary = { ...entry.location, severity: /error/i.test(kind) ? 1 : /^warning$/i.test(kind) ? 2 : 3,
        source, message: syntaxError || message || kind };
      if (code) primary.code = code;
      result.push(primary);
      section = undefined;
      related = undefined;
    } else if (primary && entry && (inSection || (entry.body === undefined && entry.excerpt !== undefined))) {
      // P4 type errors can point both at an argument and its declaration.
      // The second location often contains only "header.p4(12)" and a caret.
      const detail = entry.body?.replace(/^:\s*/, '');
      if (section === 'Actual error' && detail) primary.message += '\n' + detail;
      related = { location: entry.location, message: detail || entry.excerpt?.trim() || 'Related location' };
      (primary.relatedInformation ??= []).push(related);
    } else if (inSection && /^[ \t]+\S/.test(line)) {
      const message = line.trim();
      if (section === 'Originating from' && related) related.message += '\n' + message;
      else primary.message += '\n' + message;
      continue;
    } else {
      // A summary, blank line or progress banner ends the diagnostic block.
      primary = undefined;
      related = undefined;
      section = undefined;
      continue;
    }
    if (entry.excerpt !== undefined) i += 2;
  }
  return result;
}

/**
 * Check an on-disk translation unit with p4test. No shell, input rewriting,
 * temporary source copies or output paths are used. Unsaved editor buffers
 * are deliberately not included; save all related documents before calling.
 *
 * @param {object} options
 * @param {string} options.entrypoint Entry point, absolute or relative to cwd.
 * @param {string} [options.cwd] Working directory used to resolve paths.
 * @param {string} [options.executable='p4test'] Executable path or PATH name.
 * @param {'p4-14'|'p4-16'} [options.standard='p4-16'] P4 standard.
 * @param {string[]} [options.includePaths] Include dirs, absolute or relative to cwd.
 * @param {string[]} [options.args] Additional compiler arguments, passed verbatim.
 * @param {number} [options.timeoutMs=10000] Maximum runtime in milliseconds.
 * @returns {Promise<{diagnostics:Array, output:string, error:string|null, exitCode:number|null}>}
 */
async function runCompiler(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const executable = options.executable || 'p4test';
  const standard = options.standard || 'p4-16';
  if (!options.entrypoint || !['p4-14', 'p4-16'].includes(standard)) {
    return { diagnostics: [], output: '', error: 'Invalid entrypoint or P4 standard', exitCode: null };
  }
  const args = ['--std', standard];
  for (const inc of options.includePaths || []) args.push('-I', path.resolve(cwd, inc));
  args.push(...(options.args || []), path.resolve(cwd, options.entrypoint));
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 10000);

  return await new Promise((resolve) => {
    let child;
    const output = { stdout: '', stderr: '' };
    let combinedOutput = '';
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeCompilers.delete(kill);
      resolve({ ...result, output: combinedOutput });
    };
    const kill = () => {
      if (!child?.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
    };
    let timer;
    try {
      child = spawn(executable, args, {
        cwd, shell: false, windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      activeCompilers.add(kill);
    } catch (err) {
      finish({ diagnostics: [], error: `Cannot start ${executable}: ${err.message}`, exitCode: null });
      return;
    }
    const append = (stream, chunk) => {
      if (truncated) return;
      const remaining = OUTPUT_LIMIT - outputBytes;
      const bytes = Buffer.byteLength(chunk);
      if (bytes > remaining) {
        chunk = Buffer.from(chunk).toString('utf8', 0, remaining);
        truncated = true;
        kill();
      }
      outputBytes += Math.min(bytes, remaining);
      output[stream] += chunk;
      combinedOutput += chunk;
    };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8').on('data', chunk => append(stream, chunk));
    }
    child.on('error', err => finish({ diagnostics: [], error: `Cannot start ${executable}: ${err.message}`, exitCode: null }));
    child.on('close', (code, signal) => {
      // Drivers often print progress to stdout while p4c writes a multiline
      // diagnostic to stderr. Preserve each stream's line boundaries.
      const source = path.basename(executable);
      const diagnostics = [...parseDiagnostics(output.stderr, cwd, source), ...parseDiagnostics(output.stdout, cwd, source)];
      let error = null;
      if (timedOut) error = `${executable} timed out after ${timeoutMs} ms`;
      else if (truncated) error = `${executable} output exceeded ${OUTPUT_LIMIT} bytes`;
      else if (code !== 0 && !diagnostics.some(d => d.severity === 1)) {
        error = `${executable} failed (${signal || `exit ${code}`}): ${combinedOutput.trim().slice(0, 2000) || 'no diagnostic output'}`;
      }
      finish({ diagnostics, error, exitCode: code });
    });
    timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    timer.unref?.();
  });
}

module.exports = { parseDiagnostics, runCompiler };
