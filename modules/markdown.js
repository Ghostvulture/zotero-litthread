/* Safe, dependency-free Markdown for Zotero's privileged XHTML documents.
 * Deliberately a bounded Markdown subset, not an HTML parser. */
(function (root) {
  "use strict";
  const NS = "http://www.w3.org/1999/xhtml";
  const LIMITS = Object.freeze({ characters: 160000, lines: 6000, nodes: 12000, depth: 16, inlineDepth: 12, scan: 1000000,
    mathCharacters: 8192, mathTotalCharacters: 32768, mathExpressions: 128 });

  function element(state, name, className) {
    const node = state.doc.createElementNS(NS, name);
    if (className) node.setAttribute("class", className);
    state.nodes++;
    return node;
  }
  function text(state, parent, value) {
    if (value) { parent.appendChild(state.doc.createTextNode(value)); state.nodes++; }
  }
  function safeURL(value) {
    const raw = String(value || "").trim();
    if (raw.length > 4096 || /[\u0000-\u0020\u007f]/.test(raw) || !/^https?:\/\//i.test(raw)) return null;
    try {
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      return url.href;
    } catch (_) { return null; }
  }
  function escaped(source, index) {
    let count = 0;
    while (index > 0 && source[--index] === "\\") count++;
    return count % 2 === 1;
  }
  // A shared lexer shields TeX from emphasis parsing and table separators.
  // Unclosed delimiters remain literal, including their backslashes.
  function mathAt(state, source, start) {
    let open, close, displayMode = false;
    if (source.startsWith("$$", start)) { open = close = "$$"; displayMode = true; }
    else if (source.startsWith("\\[", start)) { open = "\\["; close = "\\]"; displayMode = true; }
    else if (source.startsWith("\\(", start)) { open = "\\("; close = "\\)"; }
    else if (source[start] === "$" && source[start - 1] !== "$" && !/\s/.test(source[start + 1] || " ")) { open = close = "$"; }
    else return null;
    if (escaped(source, start)) return null;
    const from = start + open.length;
    let at = from;
    for (; at < source.length && state.scan > 0; at++) {
      state.scan--;
      if (!displayMode && source[at] === "\n") break;
      if (!source.startsWith(close, at) || escaped(source, at)) continue;
      if (close === "$" && (source[at - 1] === "$" || source[at + 1] === "$"
        || /\s/.test(source[at - 1] || " ") || /\d/.test(source[at + 1] || ""))) continue;
      return { tex: source.slice(from, at), raw: source.slice(start, at + close.length),
        end: at + close.length, displayMode, closed: true };
    }
    // Once the shared scan budget is used, leave the remaining input as text.
    if (state.scan <= 0) { state.limited = true; at = source.length; }
    return { raw: source.slice(start, at), end: at, displayMode, closed: false };
  }
  function appendMath(state, parent, math, block = false) {
    let rendered = null;
    if (math.closed && math.tex.trim()) {
      if (math.tex.length > LIMITS.mathCharacters || state.mathExpressions >= LIMITS.mathExpressions
        || state.mathCharacters + math.tex.length > LIMITS.mathTotalCharacters) state.limited = true;
      else {
        state.mathExpressions++; state.mathCharacters += math.tex.length;
        try { rendered = root.RCMath?.render(state.doc, math.tex, { displayMode: math.displayMode }); }
        catch (_) { /* Keep the exact original formula if TeX cannot be rendered. */ }
      }
    }
    if (rendered && [1, 3, 11].includes(rendered.nodeType)) {
      let count = 0; const pending = [rendered];
      while (pending.length && count <= LIMITS.nodes - state.nodes) {
        const node = pending.pop(); count++;
        for (const child of node.childNodes || []) pending.push(child);
      }
      if (!pending.length && state.nodes + count < LIMITS.nodes) {
        state.nodes += count; parent.appendChild(rendered); return;
      }
      state.limited = true;
    }
    const fallback = element(state, block ? "div" : "span", "rc-md-math-fallback");
    fallback.textContent = math.raw; state.nodes++; parent.appendChild(fallback);
  }
  function closing(state, source, marker, start) {
    const end = Math.min(source.length, start + 8192);
    if (marker[0] !== "`") {
      for (let at = start; at < end && state.scan > 0; at++) {
        state.scan--;
        if (source[at] === "`" && !escaped(source, at)) {
          const code = source.slice(at).match(/^`+/)[0];
          const finish = code.length <= 16 ? closing(state, source, code, at + code.length) : -1;
          if (finish >= 0) { at = finish + code.length - 1; continue; }
        }
        const math = (source[at] === "$" || source[at] === "\\") && mathAt(state, source, at);
        if (math) { at = math.end - 1; continue; }
        if (source.startsWith(marker, at) && !escaped(source, at) && !/\s/.test(source[at - 1] || "")) return at;
      }
      return -1;
    }
    const segment = source.slice(start, end);
    let relative = segment.indexOf(marker);
    while (relative !== -1) {
      const pos = start + relative;
      const codeClose = marker[0] === "`" && source[pos - 1] !== "`" && source[pos + marker.length] !== "`";
      if (!escaped(source, pos) && (codeClose || (marker[0] !== "`" && !/\s/.test(source[pos - 1] || "")))) {
        state.scan -= relative + marker.length;
        return pos;
      }
      relative = segment.indexOf(marker, relative + marker.length);
    }
    state.scan -= end - start;
    return -1;
  }
  function linkAt(state, source, start) {
    const image = source[start] === "!";
    const labelStart = start + (image ? 2 : 1);
    let level = 1, close = -1;
    const limit = Math.min(source.length, labelStart + 4096);
    for (let at = labelStart; at < limit; at++) {
      state.scan--;
      if (source[at] === "\\") { at++; continue; }
      if (source[at] === "[") { if (++level > 8) return null; }
      if (source[at] === "]" && --level === 0) { close = at; break; }
    }
    if (close < 0 || source[close + 1] !== "(") return null;
    let at = close + 2, quote = "", angle = false;
    level = 1;
    for (; at < Math.min(source.length, close + 4096); at++) {
      state.scan--;
      const char = source[at];
      if (char === "\\") { at++; continue; }
      if (quote) { if (char === quote) quote = ""; continue; }
      if (char === "<") { angle = true; continue; }
      if (char === ">") { angle = false; continue; }
      if (angle) continue;
      if ((char === '"' || char === "'") && /\s/.test(source[at - 1] || "")) { quote = char; continue; }
      if (char === "(" && ++level > 8) return null;
      if (char === ")" && --level === 0) break;
    }
    if (source[at] !== ")" || level !== 0) return null;
    let destination = source.slice(close + 2, at).trim();
    let title = "";
    const match = /^(?:<([^<>\n]*)>|(\S+?))(?:\s+["']([^\n]*)["'])?$/.exec(destination);
    if (!match) return null;
    destination = (match[1] === undefined ? match[2] : match[1]).replace(/\\([\\()[\]<>])/g, "$1");
    title = match[3] || "";
    return { image, label: source.slice(labelStart, close), destination, title, end: at + 1 };
  }
  function appendLink(state, parent, label, destination, title, depth) {
    const href = safeURL(destination);
    const node = element(state, href ? "a" : "span", href ? "rc-md-link" : "rc-md-link-disabled");
    if (href) {
      node.setAttribute("href", href);
      node.setAttribute("rel", "noopener noreferrer");
      node.setAttribute("referrerpolicy", "no-referrer");
      node.setAttribute("title", title || href);
      const activate = event => {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === "click" && (event.button == null || event.button === 0) && typeof state.onOpenLink === "function") {
          state.onOpenLink(href);
        }
      };
      node.addEventListener("click", activate);
      node.addEventListener("auxclick", activate);
    } else node.setAttribute("title", "此链接地址不受支持");
    inline(state, node, label, depth + 1, false);
    parent.appendChild(node);
  }
  function inline(state, parent, source, depth = 0, allowLinks = true) {
    if (depth >= LIMITS.inlineDepth) { text(state, parent, source); return; }
    let at = 0, plain = "";
    const flush = () => { text(state, parent, plain); plain = ""; };
    while (at < source.length) {
      if (state.scan < 0 || state.nodes >= LIMITS.nodes) {
        plain += source.slice(at); state.limited = true; break;
      }
      state.scan--;
      const char = source[at];
      const math = (char === "$" || char === "\\") && mathAt(state, source, at);
      if (math) {
        flush(); appendMath(state, parent, math); at = math.end; continue;
      }
      if (char === "\\" && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(source[at + 1] || "")) {
        plain += source[at + 1]; at += 2; continue;
      }
      if (char === "\n" || (char === "\\" && source[at + 1] === "\n")) {
        const hard = char === "\\" || / {2}$/.test(plain);
        if (hard) { plain = plain.replace(/ {2,}$/, ""); flush(); parent.appendChild(element(state, "br")); }
        else plain += "\n";
        at += char === "\\" ? 2 : 1; continue;
      }
      if (char === "`") {
        const marker = source.slice(at).match(/^`+/)[0];
        const end = marker.length <= 16 ? closing(state, source, marker, at + marker.length) : -1;
        if (end >= 0) {
          flush();
          const code = element(state, "code");
          let value = source.slice(at + marker.length, end).replace(/\n/g, " ");
          if (/^ .+ $/.test(value) && /[^ ]/.test(value)) value = value.slice(1, -1);
          code.textContent = value; parent.appendChild(code); at = end + marker.length; continue;
        }
        plain += marker; at += marker.length; continue;
      }
      if (allowLinks && (char === "[" || (char === "!" && source[at + 1] === "["))) {
        const link = linkAt(state, source, at);
        if (link) {
          flush();
          if (link.image) {
            const image = element(state, "span", "rc-md-image-placeholder");
            image.textContent = "[图片未加载" + (link.label ? "：" + link.label : "") + "]";
            parent.appendChild(image);
          } else appendLink(state, parent, link.label, link.destination, link.title, depth);
          at = link.end; continue;
        }
      }
      if (allowLinks && char === "<" && /^https?:\/\//i.test(source.slice(at + 1, at + 9))) {
        const end = source.indexOf(">", at + 1);
        if (end > at && end - at < 4096 && safeURL(source.slice(at + 1, end))) {
          flush(); const value = source.slice(at + 1, end);
          appendLink(state, parent, value, value, "", depth); at = end + 1; continue;
        }
      }
      let marker = ["***", "___", "**", "__", "~~", "*", "_"].find(token => source.startsWith(token, at));
      if (marker && !/\s/.test(source[at + marker.length] || " ") && !(char === "_" && /[\p{L}\p{N}]/u.test(source[at - 1] || ""))) {
        const end = closing(state, source, marker, at + marker.length);
        if (end > at + marker.length) {
          flush();
          const tag = marker === "~~" ? "del" : marker.length > 1 ? "strong" : "em";
          const node = element(state, tag);
          const target = marker.length === 3 ? element(state, "em") : node;
          if (target !== node) node.appendChild(target);
          inline(state, target, source.slice(at + marker.length, end), depth + 1, allowLinks);
          parent.appendChild(node); at = end + marker.length; continue;
        }
      }
      plain += char; at++;
    }
    flush();
  }
  function indentation(line) {
    const prefix = (line.match(/^[ \t]*/) || [""])[0];
    return prefix.replace(/\t/g, "    ").length;
  }
  function stripIndent(line, count) {
    const expanded = line.replace(/^[ \t]*/, prefix => prefix.replace(/\t/g, "    "));
    return expanded.slice(Math.min(indentation(expanded), count));
  }
  function listMarker(line) {
    const match = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line);
    return match ? { indent: indentation(match[1]), ordered: /^\d/.test(match[2]), number: parseInt(match[2], 10),
      contentIndent: indentation(match[1]) + match[2].length + Math.min(4, indentation(match[3])), text: match[4] } : null;
  }
  const isFence = line => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const isRule = line => /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);
  const isHeading = line => /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
  const isQuote = line => /^ {0,3}>[ \t]?(.*)$/.exec(line);
  const isDisplayMath = line => /^ {0,3}(?:\$\$|\\\[)/.test(line);
  function blockStart(line) { return !!(isFence(line) || isRule(line) || isHeading(line) || isQuote(line) || listMarker(line) || isDisplayMath(line)); }
  function cells(state, line) {
    const output = []; let current = "", lastSeparator = -1;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === "`") {
        const marker = line.slice(i).match(/^`+/)[0];
        const end = marker.length <= 16 ? closing(state, line, marker, i + marker.length) : -1;
        if (end >= 0) { current += line.slice(i, end + marker.length); i = end + marker.length - 1; continue; }
      }
      const math = (char === "$" || char === "\\") && mathAt(state, line, i);
      if (math?.closed) { current += math.raw; i = math.end - 1; continue; }
      if (char === "\\" && line[i + 1] === "|") { current += "|"; i++; continue; }
      if (char === "\\" && line[i + 1]) { current += char + line[++i]; continue; }
      if (char === "|") { output.push(current.trim()); current = ""; lastSeparator = i; }
      else current += char;
    }
    output.push(current.trim());
    if (line.trim().startsWith("|")) output.shift();
    if (lastSeparator === line.trimEnd().length - 1) output.pop();
    return output;
  }
  function tableDefinition(state, lines, at) {
    if (at + 1 >= lines.length || !lines[at].includes("|")) return null;
    const headers = cells(state, lines[at]), separators = cells(state, lines[at + 1]);
    if (!headers.length || headers.length > 24 || headers.length !== separators.length || !separators.every(cell => /^:?-+:?$/.test(cell))) return null;
    return { headers, align: separators.map(cell => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left") };
  }
  function blocks(state, parent, lines, depth = 0) {
    if (depth >= LIMITS.depth) { const p = element(state, "p"); p.textContent = lines.join("\n"); parent.appendChild(p); state.limited = true; return; }
    // Joined once per block container, so repeated delimiters do not repeatedly
    // concatenate the remaining document while looking for multiline math.
    const source = lines.join("\n"), offsets = []; let offset = 0;
    for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
    let at = 0;
    while (at < lines.length && state.nodes < LIMITS.nodes) {
      const line = lines[at];
      if (!line.trim()) { at++; continue; }
      const fence = isFence(line);
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
        const chunks = []; const marker = fence[1]; at++;
        const end = new RegExp("^ {0,3}" + marker[0] + "{" + marker.length + ",}[ \\t]*$");
        while (at < lines.length && !end.test(lines[at])) chunks.push(lines[at++]);
        if (at < lines.length) at++;
        const pre = element(state, "pre", "rc-md-code"), code = element(state, "code");
        const language = fence[2].trim().split(/\s+/)[0];
        if (/^[a-zA-Z0-9_+-]{1,40}$/.test(language)) code.setAttribute("data-language", language);
        code.textContent = chunks.join("\n"); pre.appendChild(code); parent.appendChild(pre); continue;
      }
      if (isDisplayMath(line)) {
        const start = offsets[at] + (line.match(/^ */) || [""])[0].length;
        const math = mathAt(state, source, start);
        let last = at;
        while (last + 1 < lines.length && offsets[last + 1] < math.end) last++;
        const remainder = source.slice(math.end, offsets[last] + lines[last].length);
        if (!math.closed || !remainder.trim()) {
          appendMath(state, parent, math, true); at = last + 1; continue;
        }
      }
      const heading = isHeading(line);
      if (heading) {
        const node = element(state, "h" + heading[1].length);
        inline(state, node, heading[2].replace(/[ \t]+#+[ \t]*$/, "")); parent.appendChild(node); at++; continue;
      }
      if (at + 1 < lines.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[at + 1]) && !blockStart(line)) {
        const node = element(state, lines[at + 1].trim()[0] === "=" ? "h1" : "h2");
        inline(state, node, line.trim()); parent.appendChild(node); at += 2; continue;
      }
      if (isRule(line)) { parent.appendChild(element(state, "hr")); at++; continue; }
      if (isQuote(line)) {
        const chunks = [];
        while (at < lines.length) {
          const quote = isQuote(lines[at]);
          if (!quote) break;
          chunks.push(quote[1]); at++;
        }
        const node = element(state, "blockquote"); blocks(state, node, chunks, depth + 1); parent.appendChild(node); continue;
      }
      const first = listMarker(line);
      if (first) {
        const list = element(state, first.ordered ? "ol" : "ul");
        if (first.ordered && first.number !== 1) list.setAttribute("start", String(first.number));
        while (at < lines.length && state.nodes < LIMITS.nodes) {
          const marker = listMarker(lines[at]);
          if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;
          const itemLines = [marker.text]; at++;
          let blank = false;
          while (at < lines.length) {
            const next = lines[at], nextMarker = listMarker(next);
            if (nextMarker && nextMarker.indent <= first.indent) break;
            if (!next.trim()) {
              itemLines.push(""); at++; blank = true;
              if (at < lines.length && indentation(lines[at]) <= first.indent && !listMarker(lines[at])) break;
              continue;
            }
            if (indentation(next) > first.indent) { itemLines.push(stripIndent(next, marker.contentIndent)); at++; blank = false; continue; }
            if (!blank && !blockStart(next)) { itemLines.push(next); at++; continue; }
            break;
          }
          const li = element(state, "li"); blocks(state, li, itemLines, depth + 1); list.appendChild(li);
          while (at < lines.length && !lines[at].trim()) at++;
        }
        parent.appendChild(list); continue;
      }
      const table = tableDefinition(state, lines, at);
      if (table) {
        const wrap = element(state, "div", "rc-md-table-wrap"), node = element(state, "table"), head = element(state, "thead"), body = element(state, "tbody");
        const row = (values, header) => {
          const tr = element(state, "tr");
          for (let i = 0; i < table.headers.length; i++) {
            const cell = element(state, header ? "th" : "td");
            cell.setAttribute("data-align", table.align[i]);
            if (header) cell.setAttribute("scope", "col");
            inline(state, cell, values[i] || ""); tr.appendChild(cell);
          }
          return tr;
        };
        head.appendChild(row(table.headers, true)); at += 2;
        while (at < lines.length && lines[at].trim() && lines[at].includes("|") && state.nodes < LIMITS.nodes - 50) body.appendChild(row(cells(state, lines[at++]), false));
        node.appendChild(head); node.appendChild(body); wrap.appendChild(node); parent.appendChild(wrap); continue;
      }
      const paragraph = [line]; at++;
      while (at < lines.length && lines[at].trim() && !blockStart(lines[at]) && !tableDefinition(state, lines, at)) {
        if (at + 1 < lines.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[at + 1])) break;
        paragraph.push(lines[at++]);
      }
      const node = element(state, "p"); inline(state, node, paragraph.join("\n")); parent.appendChild(node);
    }
    if (at < lines.length) state.limited = true;
  }

  class RCMarkdown {
    static render(doc, value, options = {}) {
      if (!doc || typeof doc.createElementNS !== "function" || typeof doc.createTextNode !== "function") throw new TypeError("RCMarkdown requires an XHTML-capable document");
      const original = String(value == null ? "" : value).replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
      const source = original.slice(0, LIMITS.characters);
      const allLines = source.split("\n");
      const state = { doc, onOpenLink: options.onOpenLink, nodes: 0, scan: LIMITS.scan, mathExpressions: 0, mathCharacters: 0,
        limited: original.length > source.length || allLines.length > LIMITS.lines };
      const node = element(state, "div", "rc-markdown");
      blocks(state, node, allLines.slice(0, LIMITS.lines));
      if (state.limited) {
        const notice = element(state, "p", "rc-md-truncated");
        notice.textContent = "部分内容过长或格式过于复杂，已限制渲染；完整原文仍保留在对话记录中。";
        node.appendChild(notice);
      }
      return node;
    }
  }
  RCMarkdown.LIMITS = LIMITS;
  root.RCMarkdown = RCMarkdown;
  if (typeof module !== "undefined" && module.exports) module.exports = RCMarkdown;
})(typeof globalThis !== "undefined" ? globalThis : this);
