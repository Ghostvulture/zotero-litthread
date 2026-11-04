/* Local TeX -> MathML. KaTeX's public string API never receives a live document.
 * Only a new allowlisted MathML tree is attached to Zotero's privileged UI. */
(function (root) {
  "use strict";
  const MATH_NS = "http://www.w3.org/1998/Math/MathML";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const LIMITS = Object.freeze({ characters: 8192, markup: 131072, nodes: 4096, depth: 128, text: 32768, expansions: 1000, size: 20 });
  const TAGS = new Set(("math semantics annotation mrow mi mn mo mtext ms mspace msup msub msubsup "
    + "mfrac msqrt mroot mover munder munderover mtable mtr mtd mlabeledtr mstyle mpadded "
    + "mphantom menclose merror mmultiscripts mprescripts none").split(" "));
  const BOOLEAN = new Set("displaystyle stretchy symmetric fence separator movablelimits accent accentunder largeop equalrows equalcolumns".split(" "));
  const LENGTH = new Set("width height depth lspace rspace voffset minsize maxsize mathsize linethickness rowspacing columnspacing framespacing subscriptshift superscriptshift scriptminsize".split(" "));
  const VARIANTS = new Set(("normal bold italic bold-italic double-struck fraktur bold-fraktur script bold-script "
    + "sans-serif bold-sans-serif sans-serif-italic sans-serif-bold-italic monospace initial tailed looped stretched").split(" "));
  const ALIGN = new Set("left right center top bottom baseline axis".split(" "));
  const NOTATION = new Set("longdiv actuarial phasorangle radical box roundedbox circle left right top bottom updiagonalstrike downdiagonalstrike verticalstrike horizontalstrike madruwb".split(" "));
  let nodeEngine;
  if (typeof module === "object" && module.exports && typeof require === "function") {
    nodeEngine = require("../vendor/katex/katex.min.js");
  }

  function words(value, allowed) {
    const tokens = value.trim().split(/\s+/);
    return tokens.length <= 128 && tokens.every(token => allowed.has(token));
  }
  function length(value) {
    const parts = value.trim().split(/\s+/);
    return parts.length <= 128 && parts.every(part => {
      if (part === "0") return true;
      const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(em|ex|px|pt|mu|pc|in|cm|mm|%)$/.exec(part);
      if (!match) return false;
      const number = Math.abs(Number(match[1]));
      // KaTeX normalizes dimensions to em and caps them at maxSize. A second
      // conservative guard protects the importer if its input ever changes.
      return Number.isFinite(number) && number <= (match[2] === "%" ? 2000 : LIMITS.size);
    });
  }
  function safeAttribute(name, value, tag) {
    if (value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return false;
    if (BOOLEAN.has(name)) return value === "true" || value === "false";
    if (LENGTH.has(name)) return length(value) || (name === "linethickness" && /^(thin|medium|thick)$/.test(value));
    if (name === "display") return tag === "math" && /^(block|inline)$/.test(value);
    if (name === "encoding") return tag === "annotation" && value === "application/x-tex";
    if (name === "mathvariant") return VARIANTS.has(value);
    if (name === "mathcolor" || name === "mathbackground") return /^(?:#[0-9a-f]{3,8}|[a-z]{1,30})$/i.test(value);
    if (name === "columnalign" || name === "rowalign" || name === "align") return words(value, ALIGN);
    if (name === "columnlines" || name === "rowlines" || name === "frame") return words(value, new Set(["none", "solid", "dashed"]));
    if (name === "notation") return words(value, NOTATION);
    if (name === "form") return /^(prefix|infix|postfix)$/.test(value);
    if (name === "dir") return /^(ltr|rtl)$/.test(value);
    if (name === "scriptlevel") return /^[+-]?[0-4]$/.test(value);
    if (name === "columnspan" || name === "rowspan") return /^\d{1,3}$/.test(value) && Number(value) >= 1;
    return false; // No style, href, src, events, class, ID, xml:base, or links.
  }

  function sanitizeTree(doc, source) {
    if (source?.nodeType !== 1 || source.localName !== "math" || source.namespaceURI !== MATH_NS) {
      throw new Error("Expected a MathML root");
    }
    const budget = { nodes: 0, text: 0 };
    function copy(node, depth) {
      if (++budget.nodes > LIMITS.nodes || depth > LIMITS.depth) throw new Error("MathML tree budget exceeded");
      if (node.nodeType === 3) {
        const value = String(node.nodeValue ?? node.textContent ?? "");
        budget.text += value.length;
        if (budget.text > LIMITS.text) throw new Error("MathML text budget exceeded");
        return doc.createTextNode(value);
      }
      if (node.nodeType !== 1 || node.namespaceURI !== MATH_NS || !TAGS.has(node.localName)) {
        throw new Error("Unsupported MathML element");
      }
      const name = node.localName;
      if (name === "annotation" && (node.getAttribute("encoding") !== "application/x-tex"
          || Array.from(node.childNodes).some(child => child.nodeType !== 3))) {
        throw new Error("Only a text TeX annotation is allowed");
      }
      const result = doc.createElementNS(MATH_NS, name);
      for (const attr of Array.from(node.attributes || [])) {
        if (!attr.namespaceURI && safeAttribute(attr.name, String(attr.value), name)) {
          result.setAttribute(attr.name, attr.value);
        }
      }
      for (const child of Array.from(node.childNodes || [])) result.appendChild(copy(child, depth + 1));
      return result;
    }
    return copy(source, 0);
  }

  function toMathML(tex, options = {}) {
    if (typeof tex !== "string" || !tex.trim() || tex.length > LIMITS.characters) throw new Error("Formula input budget exceeded");
    // These commands are never needed for a local mathematical expression.
    // Preserve their original text via the caller instead of KaTeX's red stub.
    if (/\\(?:includegraphics|href|url|htmlClass|htmlId|htmlStyle|htmlData)(?![A-Za-z])/.test(tex)) {
      throw new Error("External or HTML formula command is disabled");
    }
    const engine = root.katex || nodeEngine;
    if (typeof engine?.renderToString !== "function") throw new Error("Local KaTeX is not loaded");
    const markup = engine.renderToString(tex, {
      displayMode: !!options.displayMode, output: "mathml", trust: false,
      throwOnError: true, strict: "ignore", maxExpand: LIMITS.expansions,
      maxSize: LIMITS.size, macros: Object.create(null), globalGroup: false,
    });
    if (markup.length > LIMITS.markup || /<!DOCTYPE|<!ENTITY/i.test(markup)) throw new Error("Formula output budget exceeded");
    return markup;
  }

  function render(doc, tex, options = {}) {
    try {
      const markup = toMathML(tex, options);
      const Parser = doc?.defaultView?.DOMParser || root.DOMParser;
      if (typeof Parser !== "function") return null;
      // XML parsing is inert. Do not parse as HTML, assign innerHTML, import the
      // enclosing KaTeX span, or use KaTeX's internal toNode(document) API.
      const parsed = new Parser().parseFromString(markup, "application/xml");
      if (parsed.getElementsByTagName("parsererror").length) return null;
      const candidates = parsed.getElementsByTagNameNS(MATH_NS, "math");
      if (candidates.length !== 1) return null;
      const math = sanitizeTree(doc, candidates[0]);
      // Set display from the caller, never from an arbitrary parsed attribute.
      math.setAttribute("display", options.displayMode ? "block" : "inline");
      const wrapper = doc.createElementNS(HTML_NS, options.displayMode ? "div" : "span");
      wrapper.setAttribute("class", options.displayMode ? "rc-math-display" : "rc-math-inline");
      wrapper.appendChild(math);
      return wrapper;
    } catch (_) {
      // KaTeX errors can contain raw source. The Markdown caller safely appends
      // the original delimited expression as text instead of displaying HTML.
      return null;
    }
  }

  const api = Object.freeze({ render, toMathML, sanitizeTree, LIMITS, MATH_NS });
  root.RCMath = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
