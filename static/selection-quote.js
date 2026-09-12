(function (global) {
  "use strict";

  const MAX_QUOTE_CHARS = 12000;

  function normalize(text) {
    const cleaned = String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    if (cleaned.length <= MAX_QUOTE_CHARS) return cleaned;
    return `${cleaned.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…`;
  }

  function buildPrompt(quote, body) {
    const selected = normalize(quote);
    const message = String(body || "").trim();
    if (!selected) return message;
    const block = selected.split("\n").map(line => `> ${line}`).join("\n");
    return `Đoạn được chọn từ câu trả lời Codex trước đó:\n\n${block}${message ? `\n\n${message}` : ""}`;
  }

  function actionPosition(selectionRect, buttonRect, viewport, options = {}) {
    const padding = 8;
    const gap = options.mobile ? 12 : 10;
    const leftEdge = Number(viewport?.left) || 0;
    const topEdge = Number(viewport?.top) || 0;
    const rightEdge = Number(viewport?.right) || Number(viewport?.width) || 0;
    const viewportBottom = Number(viewport?.bottom) || Number(viewport?.height) || 0;
    const bottomLimit = Number.isFinite(options.bottomLimit)
      ? Math.min(viewportBottom, options.bottomLimit) : viewportBottom;
    const maxLeft = Math.max(leftEdge + padding, rightEdge - buttonRect.width - padding);
    const maxTop = Math.max(topEdge + padding, bottomLimit - buttonRect.height - padding);
    let left = options.mobile ? maxLeft
      : selectionRect.left + (selectionRect.width - buttonRect.width) / 2;
    let top = options.mobile ? selectionRect.bottom + gap
      : selectionRect.top - buttonRect.height - gap;
    if (top < topEdge + padding || top > maxTop) {
      top = options.mobile ? maxTop : selectionRect.bottom + gap;
    }
    left = Math.max(leftEdge + padding, Math.min(left, maxLeft));
    top = Math.max(topEdge + padding, Math.min(top, maxTop));
    return { left, top };
  }

  const api = { MAX_QUOTE_CHARS, normalize, buildPrompt, actionPosition };
  global.TunnelSelectionQuote = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
