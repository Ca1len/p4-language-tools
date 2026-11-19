'use strict';

// Minimal Content-Length framed JSON-RPC transport used by the language server.
class Rpc {
  constructor(input, output, handler) {
    this.input = input;
    this.output = output;
    this.handler = handler;
    this.buffer = Buffer.alloc(0);
    this.length = null;
    this.nextId = 1;
    this.pending = new Map();
    input.on('data', data => this.read(data));
  }

  send(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.output.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.output.write(body);
  }

  notify(method, params) { this.send({ method, params }); }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  read(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (true) {
      if (this.length === null) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (this.buffer.length > 8192) throw new Error('LSP header too large');
          return;
        }
        const header = this.buffer.subarray(0, end).toString('ascii');
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
        if (!match) throw new Error('Missing Content-Length');
        this.length = Number(match[1]);
        if (!Number.isSafeInteger(this.length) || this.length > 32 * 1024 * 1024) throw new Error('LSP message too large');
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.length) return;
      const body = this.buffer.subarray(0, this.length).toString('utf8');
      this.buffer = this.buffer.subarray(this.length);
      this.length = null;
      let message;
      try { message = JSON.parse(body); } catch { continue; }
      if (!message.method && message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          message.error ? pending.reject(message.error) : pending.resolve(message.result);
        }
      } else if (message.method) {
        Promise.resolve().then(() => this.handler(message.method, message.params ?? {}, message.id)).then(result => {
          if (message.id !== undefined) this.send({ id: message.id, result: result === undefined ? null : result });
        }).catch(error => {
          if (message.id !== undefined) this.send({ id: message.id, error: { code: error.code ?? -32603, message: error.message || String(error) } });
          else process.stderr.write(`p4-lsp: ${error.stack || error}\n`);
        });
      }
    }
  }
}

module.exports = { Rpc };
