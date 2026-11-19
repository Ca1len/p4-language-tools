'use strict';

const { parentPort } = require('node:worker_threads');
const { syntaxDiagnostics } = require('./antlrCheck');

parentPort.on('message', ({id, text}) => {
  try {
    const diagnostics = syntaxDiagnostics(text);
    if (!Array.isArray(diagnostics)) throw new TypeError('Parser did not return diagnostics');
    parentPort.postMessage({id, diagnostics});
  } catch (error) {
    parentPort.postMessage({id, error:String(error.message || error)});
  }
});
