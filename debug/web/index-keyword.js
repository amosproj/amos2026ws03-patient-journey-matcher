"use strict";
// ── Index › Keyword: what the keyword index holds ──
// The columns of the keyword coverage (FULL_TEXT_STATES): the first two are done, the next run
// reads the other two.
const COVERAGE_STATES = [
  ["indexed", "Fully indexed", "good", FULL_TEXT_STATES.indexed[1]],
  ["skipped", "Metadata only", "neutral", FULL_TEXT_STATES.skipped[1]],
  ["failed", "Retry download", "critical", FULL_TEXT_STATES.failed[1]],
  ["unread", "New or changed", "pending", "Open: not read yet, or changed since it was read; the next run reads it"],
];
const COVERAGE_BAR = { good: "--good", neutral: "--dropped", critical: "--critical", pending: "--pending" };
const kw = { tab: "coverage", by: "source", rendered: "", wordsTicket: 0, termsLoaded: false };

function kwTotals() {
  const total = { documents: 0, metadata: 0, metadata_to_index: 0, indexed: 0, skipped: 0, failed: 0, unread: 0, to_read: 0 };
  for (const row of ix.overview?.coverage || []) for (const key of Object.keys(total)) total[key] += row[key];
  return total;
}

function renderKwSide() {
  const box = $("#kw-state");
  const overview = ix.overview;
  const lines = (...items) => items.filter(Boolean);
  if (ix.error) {
    box.className = "db-conn down";
    box.replaceChildren(...ixErrorLines().filter(Boolean));
  } else if (overview) {
    const total = kwTotals();
    const waiting = Math.max(total.to_read, total.metadata_to_index);
    const { available, installed, preloaded } = overview.extension;
    box.className = `db-conn${waiting || !overview.exists || !available || !preloaded ? " warn" : ""}`;
    box.replaceChildren(...lines(
      h("b", {}, !overview.exists ? "No keyword index yet" : waiting ? `${plural(waiting, "document")} to index` : "Up to date"),
      h("small", {}, !overview.exists ? "The indexer creates it: start it below, or run make index."
        : waiting ? "Downloads to retry, new and changed documents wait for the next run."
        : "Every document is done: fully indexed, or metadata only."),
      h("small", {}, available ? `pg_textsearch ${installed || available}${installed ? "" : " (not created yet)"}${preloaded ? ", preloaded" : ""}` : ""),
      !available && h("span", { class: "hint" }, "This database has no pg_textsearch: use the database of compose.yaml (make db)"),
      available && !preloaded && h("span", { class: "hint" }, "pg_textsearch is not in shared_preload_libraries: start the database with make db"),
      overview.indexer.missing && h("span", { class: "hint" }, overview.indexer.missing),
    ));
  }
  const hosts = overview?.hosts || [];
  const list = $("#kw-hosts");
  if (!hosts.length) list.replaceChildren(h("li", { class: "empty" }, overview ? "Nothing: every full text is read" : "–"));
  else list.replaceChildren(...hosts.map((host) => h("li", { class: "plain" },
    h("code", {}, host.host || "no readable file"),
    h("small", {}, host.host ? `${plural(host.documents, "file")}, about ${fmtSpan(host.seconds * 1000)}` : `${host.documents}: metadata only, nothing to download`))));
}

function renderKwStats() {
  const box = $("#kw-stats");
  box.classList.toggle("overview", Boolean(ix.overview));
  if (!ix.overview) { box.replaceChildren(card("Documents", "–", "muted"), card("Full texts indexed", "–", "muted")); return; }
  const total = kwTotals();
  const words = ix.overview.words;
  box.replaceChildren(
    ovSection("Documents, not expired", h("b", { class: "ov-total" }, fmtCount(total.documents)), ovList([
      ovShare("Metadata indexed", total.metadata, total.documents, { tip: "Its title, abstract and subjects are in the keyword index" }),
    ])),
    // Each document's full text is in one of these states, as in the coverage below.
    ovSection("Full texts", ovList(COVERAGE_STATES.map(([key, label, cls, tip]) =>
      ovShare(label, total[key], total.documents, { color: COVERAGE_BAR[cls], tip, onclick: () => dbShowDocuments({ "db-fulltext": key }) })))),
    ovSection("Keyword index", ovList([
      ovFigure(words ? fmtCompact(words.words) : "–", "keywords stored", { cls: words ? "" : "zero" }),
      ovFigure(words?.last_read ? fmtAgo(words.last_read) : "–", "last full text indexed", { cls: words?.last_read ? "" : "zero" }),
      ovFigure(fmtCount(total.to_read), "read by the next run", { cls: total.to_read ? "" : "zero" }),
    ], true)),
  );
}

function coverageGroups() {
  const field = kw.by === "source" ? "source" : "content_type";
  const groups = new Map();
  for (const row of ix.overview.coverage) {
    const group = groups.get(row[field]) || { key: row[field], documents: 0, indexed: 0, skipped: 0, failed: 0, unread: 0 };
    for (const key of ["documents", "indexed", "skipped", "failed", "unread"]) group[key] += row[key];
    groups.set(row[field], group);
  }
  return [...groups.values()].sort((a, b) => b.documents - a.documents);
}

// One whole split into its states; the figures stand in the columns beside it.
function coverageBar(group) {
  const title = COVERAGE_STATES.map(([key, label]) => `${label}: ${fmtCount(group[key])}`).join(", ");
  return h("div", { class: "seg-bar", role: "img", title, "aria-label": title },
    ...COVERAGE_STATES.filter(([key]) => group[key] > 0).map(([key]) => h("i", { class: `s-${key}`, style: `flex:${group[key]}` })));
}

function coveragePanel() {
  const total = kwTotals();
  const filterId = kw.by === "source" ? "db-source" : "db-type";
  const number = (group, key) => {
    const filters = { "db-fulltext": key };
    if (group.key) filters[filterId] = group.key;
    return h("td", { class: `num${group[key] ? " link" : " zero"}`, title: group[key] ? "Show these documents" : null, onclick: group[key] ? () => dbShowDocuments(filters) : null }, fmtCount(group[key]));
  };
  const row = (group, name) => h("tr", {},
    h("td", {}, name),
    h("td", { class: "barcell" }, coverageBar(group)),
    h("td", { class: "num" }, fmtCount(group.documents)),
    ...COVERAGE_STATES.map(([key]) => number(group, key)),
    h("td", { class: "num" }, fmtShare(group.indexed + group.skipped, group.documents)));
  const seg = h("span", { class: "mini-seg" }, ...[["source", "Source"], ["type", "Content type"]].map(([value, label]) =>
    h("button", { type: "button", class: kw.by === value ? "active" : null, onclick: () => { kw.by = value; renderKwCoverage(); } }, label)));
  return h("div", { class: "panel" },
    h("h3", {}, "Full texts by", seg),
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, kw.by === "source" ? "Source" : "Content type"), h("th", {}, "Share"), h("th", { class: "num" }, "Documents"),
        // Each state's heading carries the colour of its part of the bar.
        ...COVERAGE_STATES.map(([, label, cls, tip]) => h("th", { class: "num", title: tip }, h("i", { class: `swatch ${cls}` }), label)),
        h("th", { class: "num", title: "Fully indexed or metadata only: the share the next run leaves alone" }, "Done"))),
      h("tbody", {},
        ...coverageGroups().map((group) => row(group, kw.by === "source" ? sourcePill(group.key) : typeLabel(group.key))),
        row({ ...total, key: null }, h("b", {}, "All")))));
}

function reasonsPanel() {
  const reasons = ix.overview.reasons.filter((reason) => reason.status !== "indexed");
  const body = reasons.length
    ? barList(reasons.map((reason) => ({
      name: h("span", {}, fullTextPill(reason.status), ` ${reason.detail || "no reason given"}`,
        reason.detail === tx.data?.waiting_detail ? h("small", { class: "muted" }, "; the transcription job reads these") : null),
      value: reason.documents,
      title: `${reason.detail || reason.status}: show these documents`,
      onclick: () => dbShowDocuments({ "db-fulltext": reason.status }, reason.detail),
    })), 420)
    : h("div", { class: "muted" }, "Every document read so far has an indexed full text.");
  return h("div", { class: "panel" },
    h("h3", {}, "Why a document has no full text", h("small", {}, "metadata only: done, no usable full text; retry download: open, tried again in the next run")),
    h("div", { class: "panel-body" }, body));
}

function wordsPanel() {
  const words = ix.overview.words;
  if (!words.documents) return null;
  const label = (bucket) => bucket.to == null ? `${fmtCount(bucket.from)} (cut off)` : `${fmtCount(bucket.from)}–${fmtCount(bucket.to)}`;
  return h("div", { class: "panel" },
    h("h3", {}, "Keywords per indexed full text", h("small", {}, `median ${fmtCount(words.median)}, from ${fmtCount(words.min)} to ${fmtCount(words.max)}; very few can mean a file that was not read well`)),
    h("div", { class: "panel-body" }, barList(words.buckets.map((bucket) => ({ name: label(bucket), value: bucket.documents })), 130)));
}

function formatsPanel() {
  const formats = ix.overview.formats;
  if (!formats.length) return null;
  return h("div", { class: "panel" },
    h("h3", {}, "Files the indexed full texts were read from"),
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Media type"), h("th", { class: "num" }, "Full texts"), h("th", { class: "num" }, "Keywords"), h("th", { class: "num" }, "Keywords per full text, average"))),
      h("tbody", {}, ...formats.map((format) => h("tr", {},
        h("td", {}, h("code", {}, format.media_type || "unknown")),
        h("td", { class: "num" }, fmtCount(format.documents)),
        h("td", { class: "num" }, fmtCount(format.words)),
        h("td", { class: "num" }, fmtCount(Math.round(format.words / format.documents))))))));
}

function renderKwCoverage() {
  if (!ix.overview) return;
  // The view refreshes every 5 s: build it again only when something changed.
  const snapshot = JSON.stringify([kw.by, ix.overview.exists, ix.overview.coverage, ix.overview.reasons, ix.overview.words, ix.overview.formats, tx.data?.waiting_detail]);
  if (snapshot === kw.rendered) return;
  kw.rendered = snapshot;
  const parts = [coveragePanel()];
  if (!ix.overview.exists) parts.unshift(h("div", { class: "notice quiet", style: "margin:0" }, "No keyword index yet, so no document is indexed. Use Index keyword in the controls, or run make index; the first run reads every full text and takes a while (see “Next run downloads”)."));
  else parts.push(reasonsPanel(), wordsPanel(), formatsPanel());
  $("#kw-coverage").replaceChildren(...parts.filter(Boolean));
}

// The figures, then their share of all documents as a bar on a fixed 0–100 % scale; for a right-aligned cell.
const kwShare = (count, total) => [`${fmtCount(count)} (${fmtShare(count, total)})`, h("span", { class: "meter", style: "margin:0 0 0 7px" }, h("i", { style: `width:${total ? (100 * count) / total : 0}%` }))];

// Counting runs over every full text: the first time a note in the table, later the list fades.
async function kwLoadWords() {
  const ticket = ++kw.wordsTicket;
  const body = $("#kw-words");
  const request = api(`/api/index/vocabulary?${queryString({ limit: $("#kw-words-limit").value, q: $("#kw-word").value.trim() })}`);
  const first = !body.childElementCount;
  if (first) {
    body.replaceChildren(loadingRow(5, "Counting the keywords of every full text …"));
    $("#kw-words-shown").textContent = "";
  }
  try {
    const data = await (first ? request : busyArea($("#keyword-view .content"), request));
    if (ticket !== kw.wordsTicket) return;
    const stems = (row) => !row.stems.length
      ? h("span", { class: "pill none", title: "An English stop word: stored, but not searched" }, "stop word, not searched")
      : row.stems.join(" ") === row.word ? h("span", { class: "muted", title: "The stemmer keeps the word as it is" }, "unchanged") : row.stems.join(" ");
    body.replaceChildren(...(data.rows.length ? data.rows.map((row, index) => h("tr", {},
      h("td", { class: "num zero" }, index + 1),
      h("td", { class: "id" }, row.word),
      h("td", { class: "num" }, fmtCount(row.count)),
      h("td", { class: "num" }, kwShare(row.documents, data.documents)),
      h("td", { class: "small" }, stems(row)),
    )) : [messageRow(5, "No keyword matches.")]));
    $("#kw-words-shown").textContent = `the most frequent keywords of ${plural(data.documents, "full text")}`;
  } catch (error) {
    if (ticket !== kw.wordsTicket) return;
    body.replaceChildren(messageRow(5, error.message, "small error"));
    $("#kw-words-shown").textContent = "";
  }
}

async function kwLoadTerms() {
  const body = $("#kw-terms");
  const request = api("/api/index/journey-terms");
  const first = !body.childElementCount;
  if (first) body.replaceChildren(loadingRow(5, "Counting the documents each journey term finds …"));
  try {
    const data = await (first ? request : busyArea($("#keyword-view .content"), request));
    const found = (term) => term.metadata + term.full_text;
    const flag = (term) => term.stop_words ? h("span", { class: "pill none", title: "Only English stop words: stored, but not searched" }, "stop words")
      : !found(term) ? h("span", { class: "pill failed", title: "No indexed document has this term" }, "finds nothing")
      : term.metadata > data.totals.metadata / 2 ? h("span", { class: "pill plain", title: "In more than half of the documents: it hardly tells them apart" }, "in most documents") : null;
    const rows = data.terms.sort((a, b) => found(a) - found(b) || a.term.localeCompare(b.term));
    body.replaceChildren(...rows.map((term) => h("tr", {},
      h("td", {}, term.term),
      h("td", { class: "small" }, term.german.join(", ")),
      h("td", { class: "small num" }, kwShare(term.metadata, data.totals.metadata)),
      h("td", { class: "small num" }, kwShare(term.full_text, data.totals.full_text)),
      h("td", {}, flag(term)),
    )));
    $("#kw-terms-shown").textContent = `${plural(rows.length, "English term")} of german-terms.json and the indexed documents each one finds, the rarest first`;
    kw.termsLoaded = true;
  } catch (error) {
    body.replaceChildren(messageRow(5, error.message, "small error"));
    $("#kw-terms-shown").textContent = "";
  }
}

function kwSwitchTab(tab) {
  kw.tab = tab;
  history.replaceState(null, "", tab === "coverage" ? "#index-keyword" : `#index-keyword-${tab}`);
  for (const button of document.querySelectorAll("#kw-tabs button")) button.classList.toggle("active", button.dataset.kwtab === tab);
  for (const section of document.querySelectorAll(".kwtab")) section.classList.toggle("active", section.id === `kwtab-${tab}`);
  if (tab === "log") { const log = $("#kw-log"); log.scrollTop = log.scrollHeight; }
  if (tab === "vocabulary" && !$("#kw-words").childElementCount) kwLoadWords();
  if (tab === "terms" && !kw.termsLoaded) kwLoadTerms();
}

for (const button of document.querySelectorAll("#kw-tabs button")) button.addEventListener("click", () => kwSwitchTab(button.dataset.kwtab));
$("#kw-refresh").addEventListener("click", () => { kw.termsLoaded = false; if (kw.tab === "vocabulary") kwLoadWords(); if (kw.tab === "terms") kwLoadTerms(); ixRefresh(); txRefresh(); });
$("#kw-start").addEventListener("click", () => ixCommand("/api/index/run", { approach: "keyword" }));
let kwTyping = 0;
$("#kw-word").addEventListener("input", () => { clearTimeout(kwTyping); kwTyping = setTimeout(kwLoadWords, 300); });
$("#kw-words-limit").addEventListener("change", kwLoadWords);
