"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const RCMarkdown = require("../modules/markdown.js");

// Tests are dependency-free by default. Set RC_TEST_DOM_MODULE to a linkedom
// module path to run the same assertions against an actual DOM implementation.
let parseHTML;
try { ({ parseHTML } = require(process.env.RC_TEST_DOM_MODULE || "linkedom")); }
catch (error) { if (process.env.RC_TEST_DOM_MODULE) throw error; }

class MiniNode {
  constructor(doc, name, type = 1, value = "") {
    this.ownerDocument = doc; this.localName = name; this.nodeName = name;
    this.nodeType = type; this.namespaceURI = type === 1 ? "http://www.w3.org/1999/xhtml" : null;
    this.childNodes = []; this.attrs = new Map(); this.events = new Map(); this.value = value;
  }
  appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  get textContent() { return this.nodeType === 3 ? this.value : this.childNodes.map(child => child.textContent).join(""); }
  set textContent(value) { this.childNodes = [new MiniNode(this.ownerDocument, "#text", 3, String(value))]; }
  set innerHTML(_) { throw new Error("Unsafe innerHTML use"); }
  addEventListener(type, listener) { this.events.set(type, listener); }
  dispatchEvent(event) { this.events.get(event.type)?.(event); return !event.defaultPrevented; }
}
function documentFixture() {
  if (parseHTML) return parseHTML("<!doctype html><html><body></body></html>").document;
  const doc = {
    createElementNS(ns, name) { assert.equal(ns, "http://www.w3.org/1999/xhtml"); return new MiniNode(doc, name); },
    createTextNode(value) { return new MiniNode(doc, "#text", 3, String(value)); }
  };
  return doc;
}
function elements(node) {
  const result = [];
  const visit = current => {
    if (current.nodeType === 1) result.push(current);
    for (const child of current.childNodes || []) visit(child);
  };
  visit(node); return result;
}
const byTag = (node, tag) => elements(node).filter(element => element.localName === tag);
const byClass = (node, name) => elements(node).filter(element => (element.getAttribute("class") || "").split(" ").includes(name));
const render = value => RCMarkdown.render(documentFixture(), value);
function event(doc, type) {
  if (doc.defaultView?.Event) return new doc.defaultView.Event(type, { bubbles: true, cancelable: true });
  return { type, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
}

test("headings, paragraphs, rules and source IDs retain useful semantic structure", () => {
  const node = render("# Topic\n\n## Method\n\n### Result\n#### Four\n##### Five\n###### Six\n\nA claim [F001] and [S1].\n\n---\n\nNext paragraph.");
  assert.equal(node.getAttribute("class"), "rc-markdown");
  for (let level = 1; level <= 6; level++) assert.equal(byTag(node, "h" + level).length, 1);
  assert.equal(byTag(node, "p").length, 2);
  assert.equal(byTag(node, "hr").length, 1);
  assert.ok(node.textContent.includes("[F001] and [S1]"));
  assert.ok(elements(node).every(element => element.namespaceURI === "http://www.w3.org/1999/xhtml"));
});

test("emphasis, deletion, escapes and inline code avoid interpreting code as markup", () => {
  const node = render("**strong** and *emphasis* and ~~old~~ and ***both***, \\*literal\\*, variable_name. `a < b && **literal**`.");
  assert.equal(byTag(node, "strong").length, 2);
  assert.equal(byTag(node, "em").length, 2);
  assert.equal(byTag(node, "del")[0].textContent, "old");
  assert.equal(byTag(node, "code")[0].textContent, "a < b && **literal**");
  assert.ok(node.textContent.includes("*literal*, variable_name"));
});

test("fenced code preserves whitespace and raw HTML without creating executable nodes", () => {
  const source = "```js\n<script>bad()</script>\n  const x = '<img src=x onerror=bad()>';\n```\n\n~~~python\nprint('ok')\n~~~";
  const node = render(source);
  assert.equal(byTag(node, "pre").length, 2);
  const code = byTag(node, "code");
  assert.equal(code[0].getAttribute("data-language"), "js");
  assert.ok(code[0].textContent.includes("\n  const x"));
  assert.equal(code[1].getAttribute("data-language"), "python");
  assert.equal(byTag(node, "script").length, 0);
  assert.equal(byTag(node, "img").length, 0);
  const unfinished = render("```text\nunclosed **code**");
  assert.equal(byTag(unfinished, "code")[0].textContent, "unclosed **code**");
});

test("raw HTML and SVG are displayed as text and never become elements", () => {
  const source = '<script>alert(1)</script>\n<img src="https://tracker.test/i" onerror="bad()">\n<svg onload="bad()"><a href="javascript:bad()">x</a></svg>';
  const node = render(source);
  for (const tag of ["script", "img", "svg", "iframe", "a"]) assert.equal(byTag(node, tag).length, 0);
  assert.equal(node.textContent, source);
});

test("nested ordered and unordered lists keep siblings and item content", () => {
  const node = render("- First\n  - Child\n    3. Third\n    4. Fourth\n- Second\n\n7. Seven\n8. Eight");
  assert.equal(byTag(node, "ul").length, 2);
  assert.equal(byTag(node, "ol").length, 2);
  assert.equal(byTag(node, "ol")[0].getAttribute("start"), "3");
  assert.equal(byTag(node, "ol")[1].getAttribute("start"), "7");
  assert.equal(byTag(node, "li").length, 7);
  assert.ok(node.textContent.includes("Second"));
  assert.ok(node.textContent.includes("Eight"));
});

test("block quotes contain their own paragraphs, formatting and nested blocks", () => {
  const node = render("> **Author claim**\n>\n> - Evidence\n> - Limitation\n> > A nested quotation\n\nMy analysis.");
  assert.equal(byTag(node, "blockquote").length, 2);
  assert.equal(byTag(node, "strong")[0].textContent, "Author claim");
  assert.equal(byTag(node, "li").length, 2);
  assert.ok(node.textContent.endsWith("My analysis."));
});

test("GFM tables handle alignment, escaped pipes and inline formatting", () => {
  const node = render("| Method | Value | Detail |\n| :--- | ---: | :---: |\n| **A** | 42 | left\\|right |\n| B | 7 | `a|b` |");
  assert.equal(byTag(node, "table").length, 1);
  assert.equal(byClass(node, "rc-md-table-wrap").length, 1);
  assert.deepEqual(byTag(node, "th").map(cell => cell.getAttribute("data-align")), ["left", "right", "center"]);
  const values = byTag(node, "td").map(cell => cell.textContent);
  assert.deepEqual(values, ["A", "42", "left|right", "B", "7", "a|b"]);
  assert.equal(byTag(node, "strong")[0].textContent, "A");
  assert.equal(byTag(node, "code")[0].textContent, "a|b");
  assert.equal(byTag(render("| A | B |\n| - | - |\n| 1 | 2 |"), "table").length, 1);
});

test("HTTP links use the caller's opener and suppress native navigation", () => {
  const doc = documentFixture(), opened = [];
  const node = RCMarkdown.render(doc, '[**Docs**](https://example.test/a_(b) "Documentation") and <http://localhost:8080/help>', { onOpenLink: href => opened.push(href) });
  const links = byTag(node, "a");
  assert.equal(links.length, 2);
  assert.equal(links[0].getAttribute("href"), "https://example.test/a_(b)");
  assert.equal(links[0].getAttribute("title"), "Documentation");
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
  const click = event(doc, "click"); links[0].dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(opened, ["https://example.test/a_(b)"]);
  const auxiliary = event(doc, "auxclick"); links[1].dispatchEvent(auxiliary);
  assert.equal(auxiliary.defaultPrevented, true);
  assert.equal(opened.length, 1);
});

test("unsafe schemes, credentials and obfuscated destinations are inert", () => {
  const urls = ["javascript:alert(1)", "JaVaScRiPt:bad()", "data:text/html,<script>x</script>", "file:///etc/passwd", "chrome://zotero/content/", "resource://gre/modules/", "ftp://example.test", "//example.test", "/relative", "https://user:password@example.test/", "javascript&#58;alert(1)", "https://example.test/\u0009bad"];
  const node = render(urls.map(url => "[click](" + url + ")").join("\n\n"));
  assert.equal(byTag(node, "a").length, 0);
  assert.ok(elements(node).every(element => !element.getAttribute("href")));
  assert.equal(byTag(node, "script").length, 0);
});

test("Markdown images never fetch external resources", () => {
  const node = render("![A figure](https://tracker.test/pixel.png) ![data](data:image/svg+xml,evil) ![local](file:///private/figure.png)");
  assert.equal(byTag(node, "img").length, 0);
  assert.equal(byTag(node, "a").length, 0);
  assert.equal(byClass(node, "rc-md-image-placeholder").length, 3);
  assert.ok(node.textContent.includes("A figure"));
  assert.ok(elements(node).every(element => !element.getAttribute("src")));
});

test("hard line breaks work without turning ordinary wrapped prose into extra paragraphs", () => {
  const node = render("First  \nSecond\\\nThird\nSoft wrap.");
  assert.equal(byTag(node, "p").length, 1);
  assert.equal(byTag(node, "br").length, 2);
  assert.ok(node.textContent.includes("Third\nSoft wrap."));
});

test("oversized input receives an explicit rendering limit notice", () => {
  const node = render("x".repeat(RCMarkdown.LIMITS.characters + 1000));
  assert.equal(byClass(node, "rc-md-truncated").length, 1);
  assert.ok(node.textContent.length < RCMarkdown.LIMITS.characters + 200);
  const manyLines = render("paragraph\n\n".repeat(RCMarkdown.LIMITS.lines));
  assert.equal(byClass(manyLines, "rc-md-truncated").length, 1);
  assert.ok(elements(manyLines).length < RCMarkdown.LIMITS.nodes + 100);
});

test("pathological delimiters and excessive nesting terminate with a bounded tree", () => {
  const malformed = render("[".repeat(20000) + " **unterminated");
  assert.ok(malformed.textContent.includes("unterminated"));
  assert.ok(elements(malformed).length < 10);
  const nested = render("> ".repeat(100) + "deep content");
  assert.ok(byTag(nested, "blockquote").length <= RCMarkdown.LIMITS.depth);
  assert.ok(nested.textContent.includes("deep content"));
  const many = render("*x* ".repeat(20000));
  assert.ok(elements(many).length <= RCMarkdown.LIMITS.nodes + 30);
});

test("ordinary long formatted answers do not exhaust the malformed-input scan budget", () => {
  const node = render(Array.from({ length: 500 }, (_, i) => `**Claim ${i}** [F001] and [source](https://example.test/${i}).`).join("\n\n"));
  assert.equal(byTag(node, "strong").length, 500);
  assert.equal(byTag(node, "a").length, 500);
  assert.equal(byClass(node, "rc-md-truncated").length, 0);
});

test("render does not depend on innerHTML or an HTML parsing sink", () => {
  const doc = documentFixture(), create = doc.createElementNS.bind(doc);
  doc.createElementNS = (namespace, name) => {
    const node = create(namespace, name);
    Object.defineProperty(node, "innerHTML", { set() { throw new Error("HTML sink used"); } });
    return node;
  };
  const node = RCMarkdown.render(doc, "# Heading\n\n**safe** <b>literal</b> [link](https://example.test)");
  assert.ok(node.textContent.includes("<b>literal</b>"));
  assert.equal(byTag(node, "b").length, 0);
});

function withMath(action, renderer) {
  const previous = globalThis.RCMath, hadMath = Object.hasOwn(globalThis, "RCMath"), calls = [];
  globalThis.RCMath = { render(doc, tex, options) {
    calls.push({ tex, displayMode: options.displayMode });
    if (renderer) return renderer(doc, tex, options);
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    node.setAttribute("class", "math-stub"); node.textContent = tex;
    return node;
  } };
  try { action(calls); }
  finally { if (hadMath) globalThis.RCMath = previous; else delete globalThis.RCMath; }
}

test("inline dollar and parenthesis math pass exact TeX without Markdown interpretation", () => withMath(calls => {
  const node = render(String.raw`Before $x_1 * y_2$ and \(\alpha + \text{a_b}\), after [F001].`);
  assert.deepEqual(calls, [
    { tex: "x_1 * y_2", displayMode: false },
    { tex: String.raw`\alpha + \text{a_b}`, displayMode: false }
  ]);
  assert.equal(byClass(node, "math-stub").length, 2);
  assert.equal(byTag(node, "em").length, 0);
  assert.ok(node.textContent.endsWith("after [F001]."));
}));

test("multiline display math forms standalone blocks and protects TeX block syntax", () => withMath(calls => {
  const first = "\n\\begin{aligned}\nx_1 &= a * b \\\\\n# not a heading\n\\end{aligned}\n";
  const second = "\n\\sum_{i=1}^{n} x_i\n\n+ y\n";
  const node = render("Before\n$$" + first + "$$\nAfter\n\n\\[" + second + "\\]\n\nDone");
  assert.deepEqual(calls, [{ tex: first, displayMode: true }, { tex: second, displayMode: true }]);
  assert.equal(byTag(node, "h1").length, 0);
  assert.equal(byTag(node, "em").length, 0);
  assert.equal(byTag(node, "p").length, 3);
  assert.ok(byClass(node, "math-stub").every(math => math.parentNode === node));
}));

test("emphasis delimiters outside math cannot close inside TeX", () => withMath(calls => {
  const node = render(String.raw`**See $a*b$ and \(x**y\) then finish**; *use $z_i$ here*.`);
  assert.equal(byTag(node, "strong").length, 1);
  assert.equal(byTag(node, "em").length, 1);
  assert.ok(byTag(node, "strong")[0].textContent.endsWith("then finish"));
  assert.ok(byTag(node, "em")[0].textContent.endsWith("here"));
  assert.deepEqual(calls.map(call => call.tex), ["a*b", "x**y", "z_i"]);
}));

test("math-looking text stays literal in code spans and fenced blocks", () => withMath(calls => {
  const node = render("`$x$ \\(y\\)` and ``a` \\[z\\] $$w$$``\n\n```tex\n$$x_i$$\n\\[a*b\\]\n```\n\n~~~\n\\(z\\)\n~~~");
  assert.deepEqual(calls, []);
  assert.equal(byTag(node, "code").length, 4);
  assert.ok(byTag(node, "code")[2].textContent.includes("$$x_i$$"));
}));

test("escaped dollars, escaped delimiters and ordinary price text stay literal", () => withMath(calls => {
  const node = render(String.raw`Cost \$5; escaped \\(x\\); prices $5 and $10.`);
  assert.equal(calls.length, 0);
  assert.equal(node.textContent, String.raw`Cost $5; escaped \(x\); prices $5 and $10.`);
  const formula = render(String.raw`$\text{cost }\$5 + x$`);
  assert.equal(calls[0].tex, String.raw`\text{cost }\$5 + x`);
  assert.equal(byClass(formula, "math-stub").length, 1);
}));

test("unclosed formulas preserve their delimiters and internal Markdown characters", () => withMath(calls => {
  for (const source of [String.raw`\(x_1 * y`, "$x_1 * y", "$$\nx_1 ** y\n\n# still formula", "\\[\nx_1 ** y\n"]) {
    const node = render(source);
    assert.equal(node.textContent, source);
    assert.equal(byTag(node, "em").length + byTag(node, "strong").length + byTag(node, "h1").length, 0);
  }
  assert.equal(calls.length, 0);
}));

test("missing or failed math rendering preserves the exact source without HTML sinks", () => {
  const previous = globalThis.RCMath, hadMath = Object.hasOwn(globalThis, "RCMath");
  try {
    for (const math of [undefined, {}, { render() { return null; } }, { render() { throw new Error("bad TeX"); } }]) {
      globalThis.RCMath = math;
      const source = String.raw`Inline $x_1$ and \(\bad{<script>}\).`;
      const node = render(source);
      assert.equal(node.textContent, source);
      assert.equal(byTag(node, "script").length, 0);
      assert.equal(byClass(node, "rc-md-math-fallback").length, 2);
    }
    globalThis.RCMath = undefined;
    assert.equal(render("$$\nx_1\n$$").textContent, "$$\nx_1\n$$");
  } finally { if (hadMath) globalThis.RCMath = previous; else delete globalThis.RCMath; }
});

test("table cells protect formula pipes and multi-backtick code pipes", () => withMath(calls => {
  const node = render([
    "| $P(A|B)$ | Meaning |",
    "| --- | --- |",
    String.raw`| \(\left|x\right|\) | norm |`,
    String.raw`| $\begin{matrix}a|b\end{matrix}$ | ` + "``a`|b`` |",
    "| $$a|b$$ | display |"
  ].join("\n"));
  assert.equal(byTag(node, "table").length, 1);
  assert.equal(byTag(node, "th").length, 2);
  assert.equal(byTag(node, "td").length, 6);
  assert.deepEqual(calls.map(call => call.tex), ["P(A|B)", String.raw`\left|x\right|`, String.raw`\begin{matrix}a|b\end{matrix}`, "a|b"]);
  assert.equal(calls[3].displayMode, true);
  assert.equal(byTag(node, "td")[1].textContent, "norm");
}));

test("math survives headings, list items and nested quotations", () => withMath(calls => {
  const node = render("## $E=mc^2$\n\n- \\(x_i\\)\n- Result\n\n> $$\n> a_b\n> $$");
  assert.equal(byTag(node, "h2").length, 1);
  assert.equal(byTag(node, "li").length, 2);
  assert.equal(byTag(node, "blockquote").length, 1);
  assert.deepEqual(calls.map(call => call.displayMode), [false, false, true]);
  assert.equal(calls[2].tex, "\na_b\n");
}));

test("per-formula, total TeX and formula-count limits preserve excess source", () => {
  withMath(calls => {
    const source = "$" + "x".repeat(RCMarkdown.LIMITS.mathCharacters + 1) + "$";
    const node = render(source);
    assert.equal(calls.length, 0);
    assert.ok(node.textContent.startsWith(source));
    assert.equal(byClass(node, "rc-md-truncated").length, 1);
  });
  withMath(calls => {
    const node = render(("$" + "x".repeat(7000) + "$ ").repeat(5));
    assert.equal(calls.length, 4);
    assert.equal(byClass(node, "rc-md-math-fallback").length, 1);
    assert.equal(byClass(node, "rc-md-truncated").length, 1);
  });
  withMath(calls => {
    const node = render("$x$ ".repeat(RCMarkdown.LIMITS.mathExpressions + 1));
    assert.equal(calls.length, RCMarkdown.LIMITS.mathExpressions);
    assert.equal(byClass(node, "rc-md-math-fallback").length, 1);
    assert.equal(byClass(node, "rc-md-truncated").length, 1);
  });
});

test("math nodes count toward the shared Markdown tree budget", () => withMath(calls => {
  const node = render("$x$");
  assert.equal(calls.length, 1);
  assert.ok(node.textContent.startsWith("$x$"));
  assert.equal(byClass(node, "rc-md-truncated").length, 1);
  assert.ok(elements(node).length < 10);
}, doc => {
  const node = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  for (let i = 0; i < RCMarkdown.LIMITS.nodes; i++) node.appendChild(doc.createTextNode("x"));
  return node;
}));

test("several valid math subtrees cannot cumulatively bypass the shared node budget", () => withMath(calls => {
  const node = render("$x$ ".repeat(12));
  assert.equal(calls.length, 12);
  assert.equal(byClass(node, "large-math-stub").length, 11);
  assert.equal(byClass(node, "rc-md-math-fallback").length, 1);
  assert.equal(byClass(node, "rc-md-truncated").length, 1);
  let count = 0; const pending = [node];
  while (pending.length) { const current = pending.pop(); count++; pending.push(...current.childNodes); }
  assert.ok(count < RCMarkdown.LIMITS.nodes);
}, doc => {
  const node = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  node.setAttribute("class", "large-math-stub");
  for (let i = 0; i < 1000; i++) node.appendChild(doc.createTextNode("x"));
  return node;
}));

test("many malformed or complete math delimiters remain bounded", () => withMath(calls => {
  const malformed = String.raw`\(`.repeat(20000) + " **unclosed";
  assert.equal(render(malformed).textContent, malformed);
  const node = render("$x$ ".repeat(20000));
  assert.ok(calls.length <= RCMarkdown.LIMITS.mathExpressions);
  assert.ok(elements(node).length < RCMarkdown.LIMITS.nodes + 10);
  assert.equal(byClass(node, "rc-md-truncated").length, 1);
}));
