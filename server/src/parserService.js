'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const maxFileChars = 512 * 1024;
const maxPendingChars = 2 * 1024 * 1024;
const maxPendingFiles = 32;

/**
 * One persistent parser worker; each URI has at most one queued snapshot.
 * enqueue(uri,text,callback) reports diagnostics for the latest snapshot only.
 * An oversized file, evicted job or parser failure yields an empty array.
 * cancel(uri) suppresses callbacks until the next enqueue for that URI.
 */
class SyntaxService {
  constructor({onError, debounceMs = 200, timeoutMs = 4000, workerFile = path.join(__dirname,'parserWorker.js')} = {}) {
    this.debounceMs = debounceMs;
    this.timeoutMs = timeoutMs;
    this.workerFile = workerFile;
    this.onError = onError;
    this.pending = new Map();
    this.pendingChars = 0;
    this.nextId = 1;
  }

  cancel(uri) {
    this.removePending(uri);
    if (this.current?.uri === uri) this.current.callback = undefined;
  }

  removePending(uri) {
    const job = this.pending.get(uri);
    if (job) {
      this.pendingChars -= job.text.length;
      this.pending.delete(uri);
    }
    return job;
  }

  enqueue(uri, text, callback) {
    if (this.disposed) return;
    this.cancel(uri);
    if (text.length > maxFileChars) { callback([]); return; }
    this.pending.set(uri, {uri, text, callback, id:this.nextId++, due:Date.now() + this.debounceMs});
    this.pendingChars += text.length;
    while (this.pending.size > maxPendingFiles || this.pendingChars > maxPendingChars) {
      const oldest = this.pending.keys().next().value;
      const excluded = this.removePending(oldest);
      excluded.callback([]);
    }
    this.schedule();
  }

  schedule() {
    clearTimeout(this.wake);
    if (this.disposed || this.current || this.retiring) return;
    // Entries are inserted by edit time; replacements move to the back.
    const first = this.pending.values().next().value;
    if (!first) { this.worker?.unref(); return; }
    this.wake = setTimeout(() => {
      const next = this.removePending(first.uri);
      if (next) this.start(next);
      else this.schedule();
    }, Math.max(0, first.due - Date.now()));
  }

  start(job) {
    this.current = job;
    try {
      if (!this.worker) this.makeWorker();
      this.worker.ref();
      this.deadline = setTimeout(() => this.failed('Parser time limit exceeded'),this.timeoutMs);
      this.worker.postMessage({id:job.id,text:job.text});
      job.text = ''; // Only the worker needs the active copy.
    } catch (error) {
      this.failed(String(error.message || error));
    }
  }

  makeWorker() {
    const worker = new Worker(this.workerFile, {
      resourceLimits:{maxOldGenerationSizeMb:128, maxYoungGenerationSizeMb:16, stackSizeMb:4}
    });
    this.worker = worker;
    worker.on('message', (reply) => {
      if (worker !== this.worker || reply.id !== this.current?.id) return;
      if (reply.error || !Array.isArray(reply.diagnostics)) {
        this.failed(reply.error || 'Invalid parser worker reply');
        return;
      }
      const job = this.current;
      this.current = undefined;
      clearTimeout(this.deadline);
      try { job.callback?.(reply.diagnostics); }
      finally { this.schedule(); }
    });
    worker.on('error', error => {
      if (worker === this.worker) this.failed(String(error.message || error));
    });
    worker.on('exit', code => {
      if (worker === this.worker) this.failed('Parser worker exited with status ' + code);
    });
  }

  failed(message) {
    const job = this.current;
    this.current = undefined;
    clearTimeout(this.deadline);
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      this.retiring = true;
      worker.terminate().catch(() => {}).finally(() => {
        this.retiring = false;
        this.schedule();
      });
    }
    try { this.onError?.(message); job?.callback?.([]); }
    finally { if (!worker) this.schedule(); }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.wake);
    clearTimeout(this.deadline);
    this.current = undefined;
    this.pending.clear();
    this.pendingChars = 0;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) worker.terminate().catch(() => {});
  }
}
module.exports = { SyntaxService };
