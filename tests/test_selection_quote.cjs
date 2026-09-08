'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const quote = require('../static/selection-quote.js');

test('selected response text is normalized and carried as quoted prompt context', () => {
  const result = quote.buildPrompt('  Dòng một\r\nDòng hai  \n', 'Giải thích kỹ hơn');
  assert.equal(result,
    'Đoạn được chọn từ câu trả lời Codex trước đó:\n\n> Dòng một\n> Dòng hai\n\nGiải thích kỹ hơn');
});

test('selected response context is bounded before transport', () => {
  const result = quote.normalize('x'.repeat(quote.MAX_QUOTE_CHARS + 100));
  assert.equal(result.length, quote.MAX_QUOTE_CHARS);
  assert.ok(result.endsWith('…'));
});
