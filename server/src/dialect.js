'use strict';

function dialect(doc, language = 'auto') {
  if (language === 'p4-14' || language === 'p4-16') return language;
  if (/\.p4_14$/i.test(doc?.uri || '')) return 'p4-14';
  if (/\.p4_16$/i.test(doc?.uri || '')) return 'p4-16';
  const tokens = doc?.index?.tokens || [];
  const oldDeclarations = new Set(['header_type', 'parser', 'control', 'parser_exception']);
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (oldDeclarations.has(tokens[i].text) && tokens[i + 2].text === '{') return 'p4-14';
  }
  return 'p4-16';
}
module.exports = { dialect };
