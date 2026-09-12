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

test('mobile add-to-chat action sits below the selection at the right edge', () => {
  const result = quote.actionPosition(
    { left: 120, top: 300, right: 210, bottom: 340, width: 90, height: 40 },
    { width: 104, height: 42 },
    { left: 0, top: 0, right: 412, bottom: 915 },
    { mobile: true, bottomLimit: 760 },
  );
  assert.deepEqual(result, { left: 300, top: 352 });
});

test('mobile add-to-chat action stays above the composer and inside visual viewport', () => {
  const result = quote.actionPosition(
    { left: 250, top: 680, right: 390, bottom: 735, width: 140, height: 55 },
    { width: 104, height: 42 },
    { left: 0, top: 96, right: 412, bottom: 604 },
    { mobile: true, bottomLimit: 560 },
  );
  assert.deepEqual(result, { left: 300, top: 510 });
});
