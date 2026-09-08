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

  const api = { MAX_QUOTE_CHARS, normalize, buildPrompt };
  global.TunnelSelectionQuote = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
