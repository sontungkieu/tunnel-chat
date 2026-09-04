(function (global) {
  "use strict";

  const ready = typeof global.markdownit === "function" &&
    typeof global.texmath === "function" && global.katex;
  const renderer = ready ? global.markdownit({
    html: false,
    linkify: true,
    typographer: true,
    breaks: true,
  }).use(global.texmath, {
    engine: global.katex,
    delimiters: ["dollars", "brackets", "beg_end"],
    katexOptions: {
      throwOnError: false,
      strict: "warn",
      trust: false,
      maxSize: 20,
      maxExpand: 1000,
      output: "htmlAndMathml",
      macros: {
        "\\RR": "\\mathbb{R}",
        "\\NN": "\\mathbb{N}",
        "\\ZZ": "\\mathbb{Z}",
        "\\QQ": "\\mathbb{Q}",
        "\\CC": "\\mathbb{C}",
        "\\EE": "\\mathbb{E}",
        "\\PP": "\\mathbb{P}",
      },
    },
  }) : null;

  function renderMarkdown(source) {
    if (!renderer) return null;
    return renderer.render(String(source || ""));
  }

  global.TunnelRichText = {renderMarkdown, ready: Boolean(renderer)};
})(typeof window === "undefined" ? globalThis : window);
