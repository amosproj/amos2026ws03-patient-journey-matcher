// Markdown as GitHub renders it, for the Docs screen: mdParse turns text into blocks, mdBuild makes
// them elements with h(). No HTML string is ever inserted: raw HTML in a doc is parsed inert and
// rebuilt with a short list of harmless tags and attributes. ```math blocks become MathML.
"use strict";
const MD_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const MD_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const MD_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const MD_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const MD_QUOTE = /^ {0,3}>/;
// An HTML block starts with a block tag or a comment, or is a single inline tag on its line (GFM types 2, 6, 7).
const MD_HTML_BLOCK = /^ {0,3}(?:<!--|<\/?(?:address|article|aside|blockquote|center|details|dialog|div|dl|dd|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|picture|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)(?=[\s/>]|$))/i;
const MD_HTML_LINE = /^ {0,3}<\/?(?:a|img|span|b|i|em|strong|code|kbd|sub|sup|br|source)\b[^<>]*>\s*$/i;
const MD_ESCAPABLE = /[!-/:-@[-`{-~]/;
const MD_PUNCT = /[\p{P}\p{S}]/u;
const MD_SPACE = /\s/u;
const MD_AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+))>/y;
const MD_BR = /<br\s*\/?>/iy;
const MD_URL = /(?:https?:\/\/|www\.)[^\s<]+/y;

// ── Blocks ────────────────────────────────────────────────────────────────────
function mdParse(text) {
  const blocks = mdBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
  // Every block that holds text gets a number in reading order: search hits point at it.
  let seq = 0;
  const walk = (list) => {
    for (const block of list) {
      if (block.children) walk(block.children);
      else if (block.items) for (const item of block.items) walk(item.children);
      else if (block.type !== "hr") block.seq = seq++;
    }
  };
  walk(blocks);
  return blocks;
}

// `from` and `to` are line numbers in `lines`: a gap between two blocks is a blank line.
function mdBlocks(lines) {
  const blocks = [];
  let i = 0;
  const add = (block, from) => { block.from = from; block.to = i; blocks.push(block); };
  while (i < lines.length) {
    const line = lines[i], from = i;
    let m;
    if (!line.trim()) { i++; continue; }
    if ((m = MD_FENCE.exec(line)) && !(m[2][0] === "`" && m[3].includes("`"))) {
      const close = new RegExp(`^ {0,3}${m[2][0] === "`" ? "`" : "~"}{${m[2].length},}[ \\t]*$`);
      const indent = new RegExp(`^ {0,${m[1].length}}`);
      const body = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i].replace(indent, ""));
      i++;
      const lang = m[3].trim().split(/\s+/)[0].toLowerCase();
      add({ type: lang === "math" ? "math" : "code", lang, text: body.join("\n") }, from);
    } else if ((m = MD_ATX.exec(line))) {
      i++;
      add({ type: "heading", level: m[1].length, text: (m[2] || "").trim() }, from);
    } else if (MD_HR.test(line)) {
      i++;
      add({ type: "hr" }, from);
    } else if (MD_QUOTE.test(line)) {
      const inner = [];
      for (; i < lines.length; i++) {
        const quoted = /^ {0,3}> ?(.*)$/.exec(lines[i]);
        if (quoted) inner.push(quoted[1]);
        else if (lines[i].trim() && inner.at(-1)?.trim() && !mdInterrupts(lines, i)) inner.push(lines[i]); // lazy line
        else break;
      }
      add({ type: "quote", children: mdBlocks(inner) }, from);
    } else if (MD_HTML_BLOCK.test(line) || MD_HTML_LINE.test(line)) {
      const comment = /^ {0,3}<!--/.test(line);
      const body = [];
      for (; i < lines.length && (comment || lines[i].trim()); i++) {
        body.push(lines[i]);
        if (comment && lines[i].includes("-->")) { i++; break; }
      }
      add({ type: "html", html: body.join("\n") }, from);
    } else if (MD_ITEM.test(line)) {
      i = mdList(lines, i, blocks);
    } else if (mdTableStart(lines, i)) {
      const aligns = mdTableStart(lines, i);
      const head = mdCells(lines[i]);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && !mdStartsBlock(lines[i]) && !MD_ITEM.test(lines[i]); i++) {
        const cells = mdCells(lines[i]);
        rows.push(head.map((_, k) => cells[k] ?? ""));
      }
      add({ type: "table", aligns, head, rows }, from);
    } else if (/^ {4}/.test(line)) {
      const body = [];
      for (; i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim()); i++) body.push(lines[i].slice(4));
      while (body.length && !body.at(-1).trim()) { body.pop(); i--; }
      add({ type: "code", lang: "", text: body.join("\n") }, from);
    } else {
      const para = [line.trimStart()];
      let level = 0;
      for (i++; i < lines.length; i++) {
        const next = lines[i];
        if (!next.trim()) break;
        if (/^ {0,3}=+[ \t]*$/.test(next)) { level = 1; i++; break; }
        if (/^ {0,3}-+[ \t]*$/.test(next)) { level = 2; i++; break; }
        if (mdInterrupts(lines, i)) break;
        para.push(next.trimStart());
      }
      const text = para.join("\n").replace(/[ \t]+$/, "");
      add(level ? { type: "heading", level, text } : { type: "paragraph", text }, from);
    }
  }
  return blocks;
}

function mdStartsBlock(line) {
  return MD_FENCE.test(line) || MD_ATX.test(line) || MD_HR.test(line) || MD_QUOTE.test(line) || MD_HTML_BLOCK.test(line);
}

// Whether line i ends a paragraph: another block starts there. An ordered list must start at 1.
function mdInterrupts(lines, i) {
  const line = lines[i];
  if (mdStartsBlock(line)) return true;
  const item = MD_ITEM.exec(line);
  if (item && item[4]?.trim() && (!/\d/.test(item[2]) || /^1[.)]$/.test(item[2]))) return true;
  return Boolean(mdTableStart(lines, i));
}

function mdList(lines, i, blocks) {
  const first = MD_ITEM.exec(lines[i]);
  const ordered = /\d/.test(first[2]);
  const kind = first[2].slice(-1);
  const list = { type: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, loose: false, items: [], from: i };
  let last = i;
  while (i < lines.length) {
    const m = MD_ITEM.exec(lines[i]);
    if (!m || MD_HR.test(lines[i]) || /\d/.test(m[2]) !== ordered || m[2].slice(-1) !== kind) break;
    if (list.items.length && i > last) list.loose = true; // a blank line between two items
    const pad = m[3]?.length ?? 0, rest = m[4] ?? "";
    const width = m[1].length + m[2].length + (rest && pad <= 4 ? pad : 1); // where the item's content starts
    const own = [rest && pad > 4 ? " ".repeat(pad - 1) + rest : rest];
    last = i + 1;
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { own.push(""); continue; }
      if (line.length - line.trimStart().length >= width) own.push(line.slice(width));
      else if (own.at(-1).trim() && !MD_ITEM.test(line) && !mdInterrupts(lines, i) && mdOpenParagraph(own)) own.push(line.trimStart());
      else break;
      last = i + 1;
    }
    while (own.length > 1 && !own.at(-1).trim()) own.pop();
    const children = mdBlocks(own);
    for (let k = 1; k < children.length; k++) if (children[k].from > children[k - 1].to) list.loose = true;
    list.items.push({ children });
  }
  list.to = last;
  blocks.push(list);
  return i;
}

// A lazy continuation line only continues a paragraph, not code, a heading or a rule.
function mdOpenParagraph(own) {
  let fence = null;
  for (const line of own) {
    const m = MD_FENCE.exec(line);
    if (fence) { if (m && m[2][0] === fence[0] && m[2].length >= fence.length && !m[3].trim()) fence = null; }
    else if (m) fence = m[2];
  }
  const last = own.at(-1);
  return !fence && !MD_FENCE.test(last) && !MD_ATX.test(last) && !MD_HR.test(last);
}

// The alignments of a GFM table that starts at line i, or null.
function mdTableStart(lines, i) {
  const head = lines[i], delimiter = lines[i + 1];
  if (delimiter === undefined || !head.includes("|") || !delimiter.includes("|") || /^ {4}/.test(head) || /^ {4}/.test(delimiter)) return null;
  const cells = mdCells(delimiter);
  if (!cells.every((cell) => /^:?-+:?$/.test(cell)) || mdCells(head).length !== cells.length) return null;
  return cells.map((cell) => (cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : cell.startsWith(":") ? "left" : null));
}

// Cells split at each | that is not escaped; \| is a pipe in the cell, also inside `code`.
function mdCells(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells = [];
  let cell = "";
  for (let k = 0; k < row.length; k++) {
    if (row[k] === "\\" && row[k + 1] === "|") { cell += "|"; k++; }
    else if (row[k] === "|") { cells.push(cell.trim()); cell = ""; }
    else cell += row[k];
  }
  cells.push(cell.trim());
  return cells;
}

// ── Inline ────────────────────────────────────────────────────────────────────
// Nodes: text, code, br, em, strong, del, link and img. Emphasis follows the delimiter rules of
// CommonMark, so snake_case words and a lone * stay text. Raw inline tags other than <br> stay text.
function mdInline(src, inLink = false) {
  const out = [];
  let text = "", i = 0;
  const push = (node) => { if (text) out.push({ t: "text", v: text }); text = ""; out.push(node); };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === "\n") { push({ t: "br" }); i += 2; continue; }
      if (next !== undefined && MD_ESCAPABLE.test(next)) { text += next; i += 2; continue; }
    } else if (ch === "`") {
      const run = mdRun(src, i, "`");
      const close = mdCodeClose(src, i + run, run);
      if (close < 0) { text += "`".repeat(run); i += run; continue; }
      let code = src.slice(i + run, close).replace(/\n/g, " ");
      if (code.length > 2 && code[0] === " " && code.at(-1) === " " && code.trim()) code = code.slice(1, -1);
      push({ t: "code", v: code });
      i = close + run;
      continue;
    } else if (ch === "<") {
      MD_AUTOLINK.lastIndex = i;
      const auto = !inLink && MD_AUTOLINK.exec(src);
      if (auto) { push({ t: "link", href: auto[2] ? `mailto:${auto[1]}` : auto[1], c: [{ t: "text", v: auto[1] }] }); i = MD_AUTOLINK.lastIndex; continue; }
      MD_BR.lastIndex = i;
      if (MD_BR.test(src)) { push({ t: "br" }); i = MD_BR.lastIndex; continue; }
    } else if (ch === "[" || (ch === "!" && src[i + 1] === "[")) {
      const image = ch === "!";
      const link = mdLinkAt(src, image ? i + 1 : i);
      if (link && (image || !inLink)) {
        push(image ? { t: "img", src: link.dest, title: link.title, alt: mdPlain(mdInline(link.text, true), true) }
          : { t: "link", href: link.dest, title: link.title, c: mdInline(link.text, true) });
        i = link.end;
        continue;
      }
    } else if (ch === "*" || ch === "_" || ch === "~") {
      const run = mdRun(src, i, ch);
      if (ch === "~" && run > 2) { text += src.slice(i, i + run); i += run; continue; }
      const before = src[i - 1] ?? "\n", after = src[i + run] ?? "\n";
      const left = !MD_SPACE.test(after) && (!MD_PUNCT.test(after) || MD_SPACE.test(before) || MD_PUNCT.test(before));
      const right = !MD_SPACE.test(before) && (!MD_PUNCT.test(before) || MD_SPACE.test(after) || MD_PUNCT.test(after));
      push({
        t: "delim", ch, n: run, orig: run,
        open: ch === "_" ? left && (!right || MD_PUNCT.test(before)) : left,
        close: ch === "_" ? right && (!left || MD_PUNCT.test(after)) : right,
      });
      i += run;
      continue;
    } else if (ch === "\n") {
      const hard = / {2,}$/.test(text);
      text = text.replace(/ +$/, "");
      if (hard) push({ t: "br" });
      else text += "\n";
      for (i++; src[i] === " "; i++);
      continue;
    } else if ((ch === "h" || ch === "w") && !inLink && !/[\p{L}\p{N}]/u.test(src[i - 1] ?? "")) {
      const url = mdBareUrl(src, i);
      if (url) { push({ t: "link", href: url.startsWith("www.") ? `https://${url}` : url, c: [{ t: "text", v: url }] }); i += url.length; continue; }
    }
    text += ch;
    i++;
  }
  if (text) out.push({ t: "text", v: text });
  return mdEmphasis(out);
}

function mdRun(src, i, ch) {
  let k = i;
  while (src[k] === ch) k++;
  return k - i;
}

function mdCodeClose(src, from, length) {
  for (let k = src.indexOf("`", from); k >= 0; k = src.indexOf("`", k)) {
    const run = mdRun(src, k, "`");
    if (run === length) return k;
    k += run;
  }
  return -1;
}

// [text](destination "title") with src[i] === "[": brackets nest, code spans hide them.
function mdLinkAt(src, i) {
  let depth = 0, k = i;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === "\\") k++;
    else if (c === "`") {
      const run = mdRun(src, k, "`"), close = mdCodeClose(src, k + run, run);
      k = (close >= 0 ? close + run : k + run) - 1;
    } else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  if (k >= src.length || src[k + 1] !== "(") return null;
  let p = k + 2;
  const skip = () => { while (p < src.length && /[ \t\n]/.test(src[p])) p++; };
  skip();
  let dest;
  if (src[p] === "<") {
    const end = src.indexOf(">", p);
    if (end < 0 || src.slice(p, end).includes("\n")) return null;
    dest = src.slice(p + 1, end);
    p = end + 1;
  } else {
    const start = p;
    for (let parens = 0; p < src.length; p++) {
      const c = src[p];
      if (c === "\\" && MD_ESCAPABLE.test(src[p + 1] ?? "")) p++;
      else if (/\s/.test(c)) break;
      else if (c === "(") parens++;
      else if (c === ")" && parens-- === 0) break;
    }
    dest = src.slice(start, p);
  }
  skip();
  let title = null;
  if (src[p] === '"' || src[p] === "'" || (src[p] === "(" && p > k + 2)) {
    const end = src.indexOf(src[p] === "(" ? ")" : src[p], p + 1);
    if (end < 0) return null;
    title = src.slice(p + 1, end);
    p = end + 1;
    skip();
  }
  if (src[p] !== ")") return null;
  return { text: src.slice(i + 1, k), dest: dest.replace(/\\([!-/:-@[-`{-~])/g, "$1"), title, end: p + 1 };
}

// A bare URL as GFM links it: trailing punctuation stays outside, and so does a ")" without its "(".
function mdBareUrl(src, i) {
  MD_URL.lastIndex = i;
  const match = MD_URL.exec(src);
  if (!match) return null;
  let url = match[0];
  for (;;) {
    const end = url.at(-1);
    if (/[?!.,:*_~'"]/.test(end)) url = url.slice(0, -1);
    else if (end === ")" && url.split(")").length > url.split("(").length) url = url.slice(0, -1);
    else break;
  }
  return /^(?:https?:\/\/|www\.)[^/?#\s]*[a-zA-Z0-9]/.test(url) ? url : null;
}

// The delimiter runs of `nodes` paired up into em, strong and del (CommonMark's "process emphasis").
function mdEmphasis(nodes) {
  const opens = (node, closer) => {
    if (node.t !== "delim" || node.ch !== closer.ch || !node.open || !node.n) return false;
    if (closer.ch === "~") return node.n === closer.n;
    return !((node.close || closer.open) && (node.orig + closer.orig) % 3 === 0 && (node.orig % 3 || closer.orig % 3));
  };
  const asText = (node) => (node.t === "delim" ? { t: "text", v: node.ch.repeat(node.n) } : node);
  let i = 0;
  while (i < nodes.length) {
    const closer = nodes[i];
    if (closer.t !== "delim" || !closer.close || !closer.n) { i++; continue; }
    let j = i - 1;
    while (j >= 0 && !opens(nodes[j], closer)) j--;
    if (j < 0) { i++; continue; }
    const opener = nodes[j];
    const use = closer.ch === "~" ? closer.n : Math.min(2, opener.n, closer.n);
    const inner = nodes.splice(j + 1, i - j - 1).map(asText);
    nodes.splice(j + 1, 0, { t: closer.ch === "~" ? "del" : use === 2 ? "strong" : "em", c: inner });
    opener.n -= use;
    closer.n -= use;
    i = j + 2;
    if (!opener.n) { nodes.splice(j, 1); i--; }
    if (!closer.n) nodes.splice(i, 1);
  }
  return nodes.map(asText);
}

// The text of inline nodes as a reader sees it; image texts only with `alt`.
function mdPlain(nodes, alt = false) {
  let out = "";
  for (const node of nodes) {
    if (node.t === "text" || node.t === "code") out += node.v;
    else if (node.t === "br") out += " ";
    else if (node.t === "img") out += alt ? node.alt : "";
    else if (node.c) out += mdPlain(node.c, alt);
  }
  return out.replace(/\n/g, " ");
}

// The first heading of level 1 in a doc, as text; the README's is raw HTML.
function mdTitle(blocks) {
  for (const block of blocks) {
    if (block.type === "heading" && block.level === 1) return mdPlain(mdInline(block.text)).trim();
    const html = block.type === "html" && /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(block.html);
    if (html) return html[1].replace(/<[^>]*>/g, "").trim();
  }
  return null;
}

// Heading IDs as GitHub makes them (github-slugger), so links like #3-technology-stack work.
function mdSlugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    let slug = base;
    while (seen.has(slug)) {
      seen.set(base, seen.get(base) + 1);
      slug = `${base}-${seen.get(base)}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

// ── Elements ──────────────────────────────────────────────────────────────────
// ctx: link(href) → attributes of <a> or null for text only; image(src) → URL or null;
// slug(text) → anchor; anchorHref(anchor); headings collects { level, text, anchor }.
function mdBuild(blocks, ctx) {
  return blocks.map((block) => {
    switch (block.type) {
      case "heading": {
        const nodes = mdInline(block.text);
        const anchor = ctx.slug(mdPlain(nodes));
        ctx.headings.push({ level: block.level, text: mdPlain(nodes).trim(), anchor });
        return h(`h${block.level}`, { "data-anchor": anchor, "data-block": block.seq },
          h("a", { class: "md-anchor", href: ctx.anchorHref(anchor), "data-anchor-link": anchor, "aria-label": "Link to this section", tabindex: "-1" }),
          ...mdNodes(nodes, ctx));
      }
      case "paragraph": {
        const nodes = mdInline(block.text);
        const only = nodes.filter((node) => node.t !== "text" || node.v.trim());
        // An image on its own line is a figure: it can be enlarged, and its text is the caption.
        if (only.length === 1 && only[0].t === "img") {
          const src = ctx.image(only[0].src);
          if (src) return h("figure", { class: "md-figure", "data-block": block.seq }, h("img", { src, alt: only[0].alt, title: only[0].title, loading: "lazy" }), only[0].alt ? h("figcaption", {}, only[0].alt) : null);
        }
        return h("p", { "data-block": block.seq }, ...mdNodes(nodes, ctx));
      }
      case "code": return mdCodeBlock(block);
      case "math": return mdMathBlock(block);
      case "quote": return h("blockquote", {}, ...mdBuild(block.children, ctx));
      case "list":
        return h(block.ordered ? "ol" : "ul", { start: block.ordered && block.start !== 1 ? block.start : null, class: block.loose ? null : "md-tight" },
          ...block.items.map((item) => h("li", {}, ...mdBuild(item.children, ctx))));
      case "table": {
        const cell = (tag, text, k) => h(tag, { style: block.aligns[k] ? `text-align:${block.aligns[k]}` : null }, ...mdNodes(mdInline(text), ctx));
        return h("div", { class: "md-table", "data-block": block.seq }, h("table", {},
          h("thead", {}, h("tr", {}, ...block.head.map((text, k) => cell("th", text, k)))),
          h("tbody", {}, ...block.rows.map((row) => h("tr", {}, ...row.map((text, k) => cell("td", text, k)))))));
      }
      case "hr": return h("hr");
      case "html": return h("div", { class: "md-html", "data-block": block.seq }, ...mdHtml(block.html, ctx));
      default: return null;
    }
  });
}

function mdNodes(nodes, ctx) {
  return nodes.map((node) => {
    switch (node.t) {
      case "text": return node.v;
      case "code": return h("code", {}, node.v);
      case "br": return h("br");
      case "em": case "strong": case "del": return h(node.t, {}, ...mdNodes(node.c, ctx));
      case "link": {
        const attrs = ctx.link(node.href);
        return attrs ? h("a", { ...attrs, title: attrs.title || node.title }, ...mdNodes(node.c, ctx)) : mdNodes(node.c, ctx);
      }
      case "img": {
        const src = ctx.image(node.src);
        return src ? h("img", { src, alt: node.alt, title: node.title, loading: "lazy" }) : node.alt;
      }
      default: return null;
    }
  }).flat(Infinity);
}

const MD_LANGS = { sh: "Shell", bash: "Shell", shell: "Shell", console: "Shell", zsh: "Shell", json: "JSON", yaml: "YAML", yml: "YAML", ts: "TypeScript", typescript: "TypeScript", js: "JavaScript", javascript: "JavaScript", py: "Python", python: "Python", sql: "SQL", text: "Text", math: "TeX" };

function mdCodeBlock(block) {
  const copy = h("button", { type: "button", class: "md-copy", title: "Copy to the clipboard" }, "Copy");
  copy.addEventListener("click", () => {
    navigator.clipboard?.writeText(block.text).then(() => {
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1400);
    });
  });
  return h("div", { class: "md-code", "data-block": block.seq },
    h("div", { class: "md-code-bar" }, h("span", {}, MD_LANGS[block.lang] || block.lang || "Text"), copy),
    h("pre", {}, h("code", {}, block.text)));
}

// ── Raw HTML ──────────────────────────────────────────────────────────────────
const MD_HTML_TAGS = new Set(["a", "abbr", "b", "blockquote", "br", "center", "code", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "picture", "pre", "q", "s", "samp", "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "var"]);
const MD_HTML_DROP = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "template", "noscript", "svg", "math", "link", "meta", "base", "title", "head"]);
const MD_HTML_ATTRS = new Set(["align", "alt", "colspan", "rowspan", "height", "width", "title", "open", "start", "dir", "lang", "valign"]);

// Parsed inert (DOMParser runs nothing and loads nothing), then rebuilt: other tags give only
// their content, scripts and the like nothing, and links and images go through ctx.
function mdHtml(html, ctx) {
  const rebuild = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = node.localName;
    if (MD_HTML_DROP.has(tag)) return null;
    const children = [...node.childNodes].map(rebuild).flat(Infinity);
    if (!MD_HTML_TAGS.has(tag)) return children;
    let attrs = {};
    for (const { name, value } of node.attributes) if (MD_HTML_ATTRS.has(name)) attrs[name] = value;
    if (tag === "a" && node.hasAttribute("href")) attrs = { ...attrs, ...(ctx.link(node.getAttribute("href")) || {}) };
    if ((tag === "img" || tag === "source") && node.getAttribute("src")) attrs.src = ctx.image(node.getAttribute("src"));
    if (node.id || node.getAttribute("name")) attrs["data-anchor"] = node.id || node.getAttribute("name");
    return h(tag, attrs, ...children);
  };
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return [...body.childNodes].map(rebuild).flat(Infinity);
}

// ── Math: the TeX of ```math blocks as MathML, else as source ──────────────────
const MD_MATHML = "http://www.w3.org/1998/Math/MathML";
const TEX_SYMBOLS = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", eta: "η", theta: "θ", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Omega: "Ω", infty: "∞", partial: "∂", ell: "ℓ", ldots: "…", dots: "…", cdots: "⋯" };
const TEX_OPERATORS = { in: "∈", notin: "∉", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", sim: "∼", equiv: "≡", propto: "∝", cdot: "⋅", times: "×", div: "÷", pm: "±", to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", mid: "∣", cup: "∪", cap: "∩", subset: "⊂", subseteq: "⊆", setminus: "∖", lbrace: "{", rbrace: "}", langle: "⟨", rangle: "⟩", "{": "{", "}": "}", "|": "‖", "%": "%", "#": "#", "&": "&", _: "_" };
const TEX_LARGE = { sum: "∑", prod: "∏", int: "∫", bigcup: "⋃", bigcap: "⋂" };
const TEX_FUNCTIONS = new Set(["log", "ln", "lg", "exp", "min", "max", "sup", "inf", "lim", "arg", "argmax", "argmin", "sin", "cos", "tan", "det", "dim", "Pr"]);
const TEX_SPACES = { quad: "1em", qquad: "2em", ",": "0.1667em", ":": "0.2222em", ";": "0.2778em", " ": "0.25em", "!": "0em" };

function mml(tag, attrs, ...children) {
  const node = document.createElementNS(MD_MATHML, tag);
  for (const [key, value] of Object.entries(attrs || {})) if (value != null) node.setAttribute(key, value);
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

function mdMathBlock(block) {
  try {
    if (typeof MathMLElement === "undefined") throw new Error("no MathML");
    return h("div", { class: "md-math", "data-block": block.seq, title: block.text }, mml("math", { display: "block" }, mdTex(block.text)));
  } catch {
    return mdCodeBlock(block); // a command this converter does not know: the TeX as it is
  }
}

// TeX to MathML for what formulas in docs use: groups, ^ and _, \frac, \sqrt, \text, \mathrm,
// large operators, functions, Greek letters, relations and spaces. Anything else throws.
function mdTex(src) {
  let i = 0;
  const fail = (what) => { throw new Error(`TeX: ${what}`); };
  const skip = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const raw = () => { // the text of a {…} argument
    skip();
    if (src[i] !== "{") fail("{ expected");
    const start = i + 1;
    for (let depth = 0; i < src.length; i++) {
      if (src[i] === "\\") i++;
      else if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(start, i++);
    }
    return fail("unclosed {");
  };
  const argument = () => {
    skip();
    if (src[i] === "{") { i++; const row = expression("}"); i++; return row; }
    const item = atom();
    return item ? item.node : fail("argument expected");
  };
  function atom() {
    skip();
    const ch = src[i];
    if (ch === "{") { i++; const row = expression("}"); i++; return { node: row }; }
    if (ch === "}") fail("unexpected }");
    if (ch === "\\") {
      const name = /^\\([a-zA-Z]+|[^a-zA-Z])/.exec(src.slice(i))[1];
      i += name.length + 1;
      if (name === "frac") return { node: mml("mfrac", {}, argument(), argument()) };
      if (name === "sqrt") return { node: mml("msqrt", {}, argument()) };
      if (["text", "textrm", "mbox"].includes(name)) return { node: mml("mtext", {}, raw().replace(/\\([{}])/g, "$1")) };
      if (["mathrm", "operatorname", "textit", "mathit", "mathbf"].includes(name)) {
        const variant = { mathrm: "normal", operatorname: "normal", textit: "italic", mathit: "italic", mathbf: "bold" }[name];
        return { node: mml("mi", { mathvariant: variant }, raw()) };
      }
      if (name in TEX_LARGE) return { node: mml("mo", { largeop: "true", movablelimits: "false" }, TEX_LARGE[name]), large: true };
      if (TEX_FUNCTIONS.has(name)) return { node: mml("mi", {}, name) };
      if (name in TEX_OPERATORS) return { node: mml("mo", { stretchy: /^[{}⟨⟩‖]$/.test(TEX_OPERATORS[name]) ? "false" : null }, TEX_OPERATORS[name]) };
      if (name in TEX_SYMBOLS) return { node: mml("mi", {}, TEX_SYMBOLS[name]) };
      if (name in TEX_SPACES) return { node: mml("mspace", { width: TEX_SPACES[name] }) };
      if (name === "left" || name === "right") { skip(); if (src[i] === ".") i++; return null; }
      return fail(`\\${name}`);
    }
    const number = /^\d*\.?\d+/.exec(src.slice(i));
    if (number) { i += number[0].length; return { node: mml("mn", {}, number[0]) }; }
    i++;
    if (/[a-zA-Z]/.test(ch)) return { node: mml("mi", {}, ch) };
    if (ch === "^" || ch === "_" || ch === "&" || ch === "#" || ch === "%") return fail(ch);
    // Brackets keep their size, as in TeX without \left and \right.
    return { node: mml("mo", { stretchy: /[()[\]|]/.test(ch) ? "false" : null }, ch === "-" ? "−" : ch === "*" ? "∗" : ch === "'" ? "′" : ch) };
  }
  function expression(end) {
    const items = [];
    for (;;) {
      skip();
      if (i >= src.length) { if (end) fail("unclosed {"); break; }
      if (src[i] === end) break;
      const base = atom();
      if (!base) continue;
      let sub = null, sup = null;
      for (;;) {
        skip();
        if (src[i] === "_" && !sub) { i++; sub = argument(); }
        else if (src[i] === "^" && !sup) { i++; sup = argument(); }
        else break;
      }
      const tag = base.large ? (sub && sup ? "munderover" : sub ? "munder" : sup ? "mover" : null)
        : sub && sup ? "msubsup" : sub ? "msub" : sup ? "msup" : null;
      items.push(tag ? mml(tag, {}, base.node, sub, sup) : base.node);
    }
    return items.length === 1 ? items[0] : mml("mrow", {}, items);
  }
  return expression(null);
}
