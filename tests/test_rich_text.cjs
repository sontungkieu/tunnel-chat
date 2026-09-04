const assert = require("node:assert/strict");
const test = require("node:test");

global.markdownit = require("markdown-it");
global.katex = require("katex");
require("katex/contrib/mhchem");
global.texmath = require("markdown-it-texmath");
require("../static/rich-text.js");

const render = global.TunnelRichText.renderMarkdown;

test("rich text renders headings, tables, lists and fenced code", () => {
  const html = render("# Kết quả\n\n| A | B |\n|---|---|\n| 1 | **2** |\n\n- một\n- hai\n\n```python\nprint('ok')\n```");
  assert.match(html, /<h1>Kết quả<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<strong>2<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /class="language-python"/);
});

test("complex bracketed and AMS math includes accessible MathML", () => {
  const source = String.raw`Inline \(x_i=\sum_{j=1}^n A_{ij}v_j\).

\[
\begin{aligned}
\mathcal L(\theta) &= \mathbb E_{x\sim p}\!\left[\log q_\theta(x)\right] \\
\nabla_\theta \mathcal L &= \sum_{i=1}^n w_i\nabla_\theta \ell_i
\end{aligned}
\]`;
  const html = render(source);
  assert.equal((html.match(/class="katex"/g) || []).length, 2);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/);
  assert.doesNotMatch(html, /katex-error/);
});

test("cases, matrices, equation tags and chemistry render", () => {
  const source = String.raw`$$
f(x)=\begin{cases}x^2,&x\ge0\\-x,&x<0\end{cases}
\qquad A=\begin{pmatrix}1&2\\3&4\end{pmatrix}\tag{1}
$$

Chemistry: $\ce{CO2 + C -> 2CO}$.`;
  const html = render(source);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /class="katex-tag"/);
  assert.doesNotMatch(html, /katex-error/);
});

test("raw HTML and unsafe links stay inert while invalid TeX stays visible", () => {
  const html = render('<img src=x onerror=alert(1)> [bad](javascript:alert(1)) $\\notacommand{x}$');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /mathcolor="#cc0000"/);
  assert.match(html, /\\notacommand/);
});
