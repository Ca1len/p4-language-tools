'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { searchText } = require('../src/search');

for (const backend of ['auto', 'node']) {
  test(backend + ': searches saved and dirty files, skips stale text and unrelated identifiers', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p4 search '));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'my header.P4');
    const dirty = path.join(root, 'unsaved.p4');
    await fs.writeFile(dirty, 'hit hit hit');
    await fs.writeFile(source, '// 𐐷 hit; hit2; my_hit\r\nhit\n');
    if (backend === 'node') {
      const oldPath = process.env.PATH;
      process.env.PATH = root;
      t.after(() => { process.env.PATH = oldPath; });
    }
    const open = [{ uri: pathToFileURL(dirty).href, open: true, text: '#define hit\n' }];
    const result = await searchText('hit', [root], open);
    assert.equal(result.length, 3);
    assert.deepEqual(result.map(r => r.location.range.start.character), [8, 6, 0]);
    assert.deepEqual(result.map(r => r.location.range.start.line), [0, 0, 1]);
    assert.equal(result[1].location.uri, pathToFileURL(source).href);
  });
}
test('literal identifier constraint and result cap', async () => {
  assert.deepEqual(await searchText('any.*', [], []), []);
  const docs = [{uri:'untitled:Untitled-1', open:true, text:'hit '.repeat(15000)}];
  assert.equal((await searchText('hit', [], docs)).length, 250);
});
