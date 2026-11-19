'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const grammarFile = path.resolve(process.env.P4_TEXTMATE_GRAMMAR ||
  path.join(__dirname, '../../extension/syntaxes/p4.tmLanguage.json'));
const ready = (async function load() {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new tm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: value => new oniguruma.OnigString(value)
    }),
    loadGrammar: async scope => scope === 'source.p4'
      ? tm.parseRawGrammar(fs.readFileSync(grammarFile, 'utf8'), grammarFile)
      : null
  });
  return registry.loadGrammar('source.p4');
})();

async function colorize(source) {
  const grammar = await ready;
  let stack = tm.INITIAL;
  return source.split('\n').map(text => {
    const { tokens, ruleStack } = grammar.tokenizeLine(text, stack);
    stack = ruleStack;
    return (needle, expectedScope, occurrence = 0) => {
      let offset = -1;
      for (let i = 0; i <= occurrence; i++) offset = text.indexOf(needle, offset + 1);
      assert.ok(offset >= 0, needle);
      const token = tokens.find(t => t.startIndex <= offset && t.endIndex > offset);
      assert.ok(token.scopes.includes(expectedScope), JSON.stringify({text,needle,expectedScope,actual:token.scopes}));
      assert.ok(token.endIndex >= offset + needle.length, JSON.stringify({text,needle,token}));
    };
  });
}

test('P4_16 source gets theme scopes before the language server starts', async () => {
  const [include, docs, header, width, action, invocation, testCall] = await colorize([
    '#include <v1model.p4>', '/// @brief Marks the packet.',
    'header ethernet_t {', '    bit<16> ether_type;', '@brief("mark") action set_port(bit<9> port) {',
    '    hdr.ethernet.ether_type = 16w0x86_DD;', '    if (hdr.ethernet.isValid()) { set_port(9w7); }'
  ].join('\n'));
  include('include','keyword.control.directive.include.p4'); include('v1model.p4','string.quoted.other.include.p4');
  docs('@brief','storage.type.class.documentation.p4'); header('ethernet_t','entity.name.type.header.p4');
  width('bit','storage.type.p4'); width('16','constant.numeric.p4');
  action('brief','storage.type.annotation.p4'); action('mark','string.quoted.double.p4');
  action('set_port','entity.name.function.action.p4');
  invocation('ether_type','variable.other.property.p4'); invocation('16w0x86_DD','constant.numeric.p4');
  testCall('if','keyword.control.p4'); testCall('isValid','entity.name.function.member.p4');
  testCall('set_port','entity.name.function.p4');
});

test('P4_14 resources, fields, primitives and table declarations get distinguishable scopes', async () => {
  const [type, field, instance, parser, table, action] = await colorize([
    'header_type wire_t { fields {', '  ether_type : 16;', '} } header wire_t eth;',
    'parser start { extract(eth); return ingress; }', 'table lookup { reads { eth.ether_type : exact; } }',
    'action stamp(x) { modify_field(eth.ether_type, x); }'
  ].join('\n'));
  type('header_type','storage.type.header.p4'); type('wire_t','entity.name.type.header.p4');
  field('ether_type','variable.other.property.field.p4'); instance('wire_t','entity.name.type.header.p4');
  parser('start','entity.name.type.parser.p4'); parser('extract','support.function.builtin.p4');
  table('lookup','variable.other.table.p4'); table('reads','keyword.control.p4');
  table('ether_type','variable.other.property.p4'); action('stamp','entity.name.function.action.p4');
  action('modify_field','support.function.builtin.p4');
});

test('macro continuations, comments, escaped strings and numeric formats preserve tokenizer state', async () => {
  const [macro, cont, regular, block, end, literal] = await colorize([
    '#define MASK(x) ((x) & \\', '  8w0b_1111)', 'control Ingress() {}',
    '/* action fake() {', '*/ action real() {}', 'const string msg = "foo\\"bar //"; // more'
  ].join('\n'));
  macro('MASK','entity.name.function.preprocessor.p4'); macro('MASK','meta.preprocessor.macro.p4');
  cont('8w0b_1111','meta.preprocessor.macro.p4'); cont('8w0b_1111','constant.numeric.p4');
  regular('Ingress','entity.name.type.control.p4');
  block('action','comment.block.p4'); end('real','entity.name.function.action.p4');
  literal('\\"','constant.character.escape.p4'); literal('bar //','string.quoted.double.p4');
  literal('more','comment.line.double-slash.p4');
});

test('multiline typed enums distinguish the enum type, tags and explicit values', async () => {
  const [decl, member, end, after] = await colorize([
    'enum bit<8> PortClass {', '    EDGE = 8w0xff,', '    CORE = 8w0x01 }', 'control Classify() { }'
  ].join('\n'));
  decl('PortClass','entity.name.type.enum.p4');
  member('EDGE','variable.other.enummember.p4');
  member('8w0xff','constant.numeric.p4');
  end('CORE','variable.other.enummember.p4');
  after('Classify','entity.name.type.control.p4');
});
