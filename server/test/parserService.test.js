'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SyntaxService } = require('../src/parserService');

async function service(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'p4-parser-test-'));
  const workerFile = path.join(dir,'fixture.js');
  await writeFile(workerFile, `
    const {parentPort} = require('node:worker_threads');
    parentPort.on('message', ({id,text}) => {
      if (text === 'hang') return;
      if (text === 'reject') throw new Error('fixture failure');
      setTimeout(() => parentPort.postMessage({id,diagnostics:[{message:text}]}), text === 'slow' ? 100 : 0);
    });`);
  const instance = new SyntaxService({workerFile, debounceMs:1, ...options});
  t.after(async () => { instance.dispose(); await rm(dir,{recursive:true,force:true}); });
  return instance;
}
test('a newer snapshot suppresses the old result; cancel suppresses closed documents', async t => {
  const instance = await service(t);
  const called = [];
  instance.enqueue('a','slow', () => called.push('obsolete'));
  while (instance.current?.uri !== 'a') await new Promise(resolve => setTimeout(resolve,5));
  const result = new Promise(resolve => instance.enqueue('a','new',resolve));
  instance.enqueue('b','closed', () => called.push('closed'));
  instance.cancel('b');
  assert.deepEqual(await result,[{message:'new'}]);
  assert.deepEqual(called,[]);
});
test('a timed-out parser is replaced and a queued document still gets results', async t => {
  const errors = [];
  const instance = await service(t,{timeoutMs:1000,onError:e=>errors.push(e)});
  const results = await Promise.all(['hang','ok'].map((text,i) =>
    new Promise(resolve => instance.enqueue(String(i), text, resolve))
  ));
  assert.deepEqual(results,[[],[{message:'ok'}]]);
  assert.match(errors[0],/time limit/);
});
