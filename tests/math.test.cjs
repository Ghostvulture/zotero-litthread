"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const RCMath = require("../modules/math.js");
const katex = require("../vendor/katex/katex.min.js");
const MATH_NS = RCMath.MATH_NS;
const HTML_NS = "http://www.w3.org/1999/xhtml";

// A deliberately small DOM fixture tests the namespace/attribute copying
// boundary. Browser XML parsing itself is covered by native Zotero tests.
class MiniNode {
  constructor(doc, name, namespaceURI, nodeType = 1, value = "") {
    this.ownerDocument = doc; this.localName = name; this.namespaceURI = namespaceURI;
    this.nodeType = nodeType; this.nodeValue = value; this.childNodes = []; this.attributes = [];
  }
  appendChild(child) { this.childNodes.push(child); return child; }
  setAttribute(name, value) {
    const attr = this.attributes.find(entry => entry.name === name);
    if (attr) attr.value = String(value);
    else this.attributes.push({ name, value: String(value), namespaceURI: null });
  }
  getAttribute(name) { return this.attributes.find(attr => attr.name === name)?.value ?? null; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(node => node.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML is forbidden"); }
}
function docFixture() {
  const doc = {
    createElementNS(ns, name) { return new MiniNode(doc, name, ns); },
    createTextNode(value) { return new MiniNode(doc, "#text", null, 3, String(value)); },
  };
  return doc;
}
function element(doc, name, children = [], attrs = {}, ns = MATH_NS) {
  const node = doc.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.appendChild(typeof child === "string" ? doc.createTextNode(child) : child);
  return node;
}
function fixtureMath() {
  const doc = docFixture();
  return element(doc, "math", [element(doc, "semantics", [
    element(doc, "mrow", [element(doc, "msup", [element(doc, "mi", ["x"]), element(doc, "mn", ["2"])])]),
    element(doc, "annotation", ["x^2"], { encoding: "application/x-tex" }),
  ])]);
}
function docWithParser(source, { error = false, count = 1 } = {}) {
  const doc = docFixture();
  doc.defaultView = { DOMParser: class {
    parseFromString(markup, mime) {
      assert.equal(mime, "application/xml");
      doc.parsedMarkup = markup;
      return {
        getElementsByTagName(name) { assert.equal(name, "parsererror"); return error ? [{}] : []; },
        getElementsByTagNameNS(ns, name) { assert.equal(ns, MATH_NS); assert.equal(name, "math"); return Array(count).fill(source); },
      };
    }
  } };
  return doc;
}
function allNodes(node) { return [node, ...node.childNodes.flatMap(allNodes)]; }
function withEngine(engine, callback) {
  const previous = globalThis.katex;
  globalThis.katex = engine;
  try { return callback(); }
  finally { if (previous === undefined) delete globalThis.katex; else globalThis.katex = previous; }
}

test("pinned official KaTeX bundle and MIT license match recorded SHA256 hashes", () => {
  const vendor = path.join(__dirname, "../vendor/katex");
  const source = JSON.parse(fs.readFileSync(path.join(vendor, "SOURCE.json"), "utf8"));
  assert.equal(katex.version, "0.19.1"); assert.equal(source.version, katex.version);
  assert.equal(source.license, "MIT");
  assert.match(source.npmIntegrity, /^sha512-/);
  for (const [file, detail] of Object.entries(source.files)) {
    const bytes = fs.readFileSync(path.join(vendor, file));
    assert.equal(bytes.length, detail.bytes);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), detail.sha256);
  }
  assert.match(fs.readFileSync(path.join(vendor, "LICENSE"), "utf8"), /Permission is hereby granted/);
});

test("real KaTeX emits semantic fractions, roots, scripts, relations and TeX annotation", () => {
  const tex = String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}`;
  const result = RCMath.toMathML(tex);
  for (const tag of ["math", "mfrac", "msqrt", "msup", "annotation"]) assert.match(result, new RegExp("<" + tag + "(?: |>)"));
  assert.match(result, /encoding="application\/x-tex"/);
  assert.ok(result.includes(tex));
  assert.doesNotMatch(result, /class="katex-html"|<svg|<img|<script/);
});

test("display integrals and sums use MathML limits and block display", () => {
  const result = RCMath.toMathML(String.raw`\int_0^\infty e^{-x}\,dx=\sum_{n=1}^{\infty}\frac1{n^2}`, { displayMode: true });
  assert.match(result, /display="block"/); assert.match(result, /<msubsup>/);
  assert.match(result, /<munderover>/); assert.ok(result.includes("∫") && result.includes("∑"));
});

test("aligned equations, matrices and piecewise cases keep MathML table structure", () => {
  for (const tex of [String.raw`\begin{aligned}a&=b+c\\d&=e\end{aligned}`,
    String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    String.raw`f(x)=\begin{cases}x^2&x>0\\0&x\leq0\end{cases}`]) {
    const result = RCMath.toMathML(tex, { displayMode: true });
    assert.match(result, /<mtable /); assert.equal((result.match(/<mtr>/g) || []).length, 2);
    assert.equal((result.match(/<mtd>/g) || []).length, 4);
  }
});

test("invalid and unknown commands throw only at string boundary; render returns null", () => {
  for (const tex of [String.raw`\unknownResearchCommand{x}`, String.raw`\frac{x}{`, String.raw`\begin{matrix}a\end{cases}`]) {
    assert.throws(() => RCMath.toMathML(tex));
    assert.equal(RCMath.render(docFixture(), tex), null);
  }
});

test("HTML and network commands fall back without generating remote resources", () => {
  for (const tex of [String.raw`\href{https://example.test}{x}`, String.raw`\url{file:///secret}`,
    String.raw`\includegraphics{https://example.test/track.png}`, String.raw`\htmlStyle{color:red}{x}`,
    String.raw`\htmlClass{someClass}{x}`, String.raw`\htmlId{target}{x}`, String.raw`\htmlData{url=x}{x}`]) {
    assert.throws(() => RCMath.toMathML(tex), /disabled/);
    assert.equal(RCMath.render(docFixture(), tex), null);
  }
});

test("self-recursive macros stop at the finite expansion limit", () => {
  assert.throws(() => RCMath.toMathML(String.raw`\def\recurse{\recurse}\recurse`), /Too many expansions|infinite loop|maxExpand/i);
});

test("global macro definitions cannot leak into the next formula", () => {
  assert.match(RCMath.toMathML(String.raw`\gdef\personalMacro{a+b}\personalMacro`), /<mi>a<\/mi>/);
  assert.throws(() => RCMath.toMathML(String.raw`\personalMacro`), /Undefined control sequence/);
});

test("large dimensions are clamped by real KaTeX maxSize", () => {
  const result = RCMath.toMathML(String.raw`\rule{99999em}{99999em}`);
  assert.match(result, /width="20em"/); assert.match(result, /height="20em"/);
});

test("input and rendered markup budgets fail before DOM parsing", () => {
  for (const tex of [null, "", " \n ", "x".repeat(RCMath.LIMITS.characters + 1)]) assert.throws(() => RCMath.toMathML(tex), /budget/);
  withEngine({ renderToString() { return "x".repeat(RCMath.LIMITS.markup + 1); } }, () => {
    assert.throws(() => RCMath.toMathML("x"), /output budget/);
    assert.equal(RCMath.render(docFixture(), "x"), null);
  });
});

test("every render forces safe options and a fresh macro object", () => {
  const calls = [];
  withEngine({ renderToString(tex, options) { calls.push(options); return "<math/>"; } }, () => {
    RCMath.toMathML("x", { displayMode: true, trust: true, output: "html", maxExpand: Infinity });
    RCMath.toMathML("x");
  });
  assert.equal(calls[0].trust, false); assert.equal(calls[0].output, "mathml");
  assert.equal(calls[0].throwOnError, true); assert.equal(calls[0].strict, "ignore");
  assert.equal(calls[0].maxExpand, 1000); assert.equal(calls[0].maxSize, 20);
  assert.equal(calls[0].globalGroup, false);
  assert.notEqual(calls[0].macros, calls[1].macros); assert.equal(Object.getPrototypeOf(calls[0].macros), null);
});

test("sanitizer rebuilds only MathML and plain TeX annotations in the target document", () => {
  const source = fixtureMath(), doc = docFixture();
  const result = RCMath.sanitizeTree(doc, source);
  assert.notEqual(result, source); assert.equal(result.ownerDocument, doc);
  assert.ok(allNodes(result).every(node => node.ownerDocument === doc && (node.nodeType === 3 || node.namespaceURI === MATH_NS)));
  assert.equal(result.textContent, "x2x^2");
  assert.equal(allNodes(result).find(node => node.localName === "annotation").getAttribute("encoding"), "application/x-tex");
});

test("style, event, link, resource, IDs and namespace-qualified attributes are never imported", () => {
  const source = fixtureMath();
  for (const [name, value] of Object.entries({ style: "background:url(https://example.test)", onclick: "bad()", onload: "bad()",
    href: "javascript:bad()", src: "file:///secret", id: "zotero-pane", class: "evil", mathcolor: "url(https://example.test)",
    mathbackground: "var(--arbitrary)", width: "99999em" })) source.setAttribute(name, value);
  source.attributes.push({ name: "xlink:href", value: "https://example.test", namespaceURI: "http://www.w3.org/1999/xlink" });
  const result = RCMath.sanitizeTree(docFixture(), source);
  assert.equal(result.attributes.length, 0);
});

test("safe MathML layout attributes remain, unsafe or extreme values are dropped", () => {
  const doc = docFixture();
  const table = element(doc, "mtable", [], { columnalign: "right left", rowspacing: "0.25em", columnspacing: "0em" });
  const styled = element(doc, "mstyle", [], { mathvariant: "double-struck", mathcolor: "#123456", displaystyle: "true", scriptlevel: "2", width: "21em" });
  const result = RCMath.sanitizeTree(doc, element(doc, "math", [table, styled], { display: "block" }));
  assert.equal(result.getAttribute("display"), "block");
  assert.equal(result.childNodes[0].getAttribute("columnalign"), "right left");
  assert.equal(result.childNodes[0].getAttribute("rowspacing"), "0.25em");
  assert.equal(result.childNodes[1].getAttribute("mathvariant"), "double-struck");
  assert.equal(result.childNodes[1].getAttribute("mathcolor"), "#123456");
  assert.equal(result.childNodes[1].getAttribute("width"), null);
});

test("foreign HTML, scripts, annotation-xml and active MathML are rejected", () => {
  const doc = docFixture();
  for (const [tag, ns] of [["script", MATH_NS], ["annotation-xml", MATH_NS], ["maction", MATH_NS], ["img", HTML_NS], ["mi", HTML_NS]]) {
    assert.throws(() => RCMath.sanitizeTree(doc, element(doc, "math", [element(doc, tag, [], {}, ns)])), /Unsupported/);
  }
  const badAnnotation = element(doc, "annotation", [element(doc, "mi", ["x"])], { encoding: "application/x-tex" });
  assert.throws(() => RCMath.sanitizeTree(doc, element(doc, "math", [badAnnotation])), /annotation/);
  assert.throws(() => RCMath.sanitizeTree(doc, element(doc, "math", [], {}, HTML_NS)), /root/);
});

test("MathML subtree node, depth and text budgets apply independently", () => {
  const doc = docFixture();
  const wide = element(doc, "math", Array.from({ length: RCMath.LIMITS.nodes }, () => element(doc, "mi", ["x"])));
  assert.throws(() => RCMath.sanitizeTree(doc, wide), /budget/);
  let deep = element(doc, "mi", ["x"]);
  for (let i = 0; i <= RCMath.LIMITS.depth; i++) deep = element(doc, "mrow", [deep]);
  assert.throws(() => RCMath.sanitizeTree(doc, element(doc, "math", [deep])), /budget/);
  const long = element(doc, "math", [element(doc, "mtext", ["x".repeat(RCMath.LIMITS.text + 1)])]);
  assert.throws(() => RCMath.sanitizeTree(doc, long), /budget/);
});

test("render returns XHTML wrappers around sanitized MathML with the requested display mode", () => {
  for (const displayMode of [false, true]) {
    const source = fixtureMath(), doc = docWithParser(source);
    const node = RCMath.render(doc, "x^2", { displayMode });
    assert.equal(node.namespaceURI, HTML_NS); assert.equal(node.localName, displayMode ? "div" : "span");
    assert.equal(node.getAttribute("class"), displayMode ? "rc-math-display" : "rc-math-inline");
    assert.equal(node.childNodes[0].namespaceURI, MATH_NS);
    assert.equal(node.childNodes[0].getAttribute("display"), displayMode ? "block" : "inline");
    assert.match(doc.parsedMarkup, /<msup><mi>x<\/mi><mn>2<\/mn><\/msup>/);
  }
});

test("missing parser, XML parse errors and ambiguous roots preserve caller fallback", () => {
  assert.equal(RCMath.render(docFixture(), "x^2"), null);
  for (const settings of [{ error: true }, { count: 0 }, { count: 2 }]) {
    assert.equal(RCMath.render(docWithParser(fixtureMath(), settings), "x^2"), null);
  }
});

test("formula text and error-like HTML remain escaped data, never attached HTML", () => {
  const result = RCMath.toMathML(String.raw`\text{<img src=x onerror=bad()>}`);
  assert.doesNotMatch(result, /<img|onerror="/); assert.match(result, /&lt;img/);
  const source = fixtureMath();
  source.childNodes[0].childNodes[1].childNodes[0].nodeValue = '<img src="https://example.test" onerror="bad()">';
  const node = RCMath.render(docWithParser(source), "x^2");
  assert.ok(node.textContent.includes("<img"));
  assert.ok(allNodes(node).every(child => child.localName !== "img"));
});
