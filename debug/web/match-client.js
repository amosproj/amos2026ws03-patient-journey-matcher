"use strict";
// ── Example client: the answer as an app could show it ────────────────────────
// It reads only what the tools answer, no step of the match and no database row, so it shows
// what a client can build from the contract (Documentation/user/mcp-interface.md).
const CLIENT_FILES = 8;

function mtRenderClient() {
  const box = $("#mt-client");
  const result = mt.result;
  if (result.error) {
    box.replaceChildren(h("div", { class: "notice" }, `The request was refused (${result.error.code}).`));
    return;
  }
  const answer = result.answer;
  const focus = mtEvents(mt.request).find((event) => event?.id === answer.focus_event_id);
  const state = answer.degraded ? h("div", { class: "notice" }, `The search is not available right now, so this is not “nothing relevant”.\n${answer.degraded_reason || ""}`)
    : answer.results.length ? null : h("div", { class: "notice quiet" }, "Nothing relevant for this event.");
  box.replaceChildren(...[
    h("div", { class: "client-head" },
      h("small", {}, [plural(answer.results.length, "source"), focus?.date].filter(Boolean).join(", ")),
      h("h3", {}, focus?.label || answer.focus_event_id)),
    state, ...answer.results.map(mtClientCard)].filter(Boolean));
}

function mtClientCard(result) {
  const authors = result.authors || [];
  const files = h("div", { class: "files" });
  const long = result.summary && (result.summary.length > 220 || result.summary.includes("\n"));
  const card = h("article", { class: `src-card${result.rank === 1 ? " top-result" : ""}${result.image_url ? " has-image" : ""}` },
    result.image_url ? h("img", { src: result.image_url, alt: "", loading: "lazy" }) : null,
    h("div", {},
      h("div", { class: "src-meta" },
        sourcePill(result.source),
        h("span", {}, [typeLabel(result.content_type), result.published_date].filter(Boolean).join(", ")),
        h("span", { class: "rank", title: result.score == null ? null : `score ${result.score}: relative to the best source of this list` }, `#${result.rank}`,
          result.score == null ? null : h("span", { class: "meter" }, h("i", { style: `width:${100 * result.score}%` })))),
      h("h4", {}, h("a", { href: result.url, target: "_blank", rel: "noopener noreferrer" }, result.title)),
      authors.length ? h("div", { class: "byline" }, authors.length > 3 ? `${authors.slice(0, 3).join(", ")} and ${authors.length - 3} more` : authors.join(", ")) : null,
      result.explanation ? h("p", { class: "muted", style: "margin:4px 0 0;font-size:13px" }, result.explanation) : null,
      h("p", { class: `summary${result.summary ? "" : " none"}` }, result.summary || "No summary"),
      h("div", { class: "src-foot" },
        h("button", { type: "button", title: "get_source: the files of this source at its origin", onclick: (event) => mtClientFiles(result.source_id, files, event.currentTarget) }, "Files"),
        long ? h("button", { type: "button", onclick: (event) => { event.currentTarget.textContent = card.classList.toggle("more") ? "Less" : "More"; } }, "More") : null,
        h("span", { title: "The client has to follow the licence when it downloads a file" }, result.licence || "Licence unknown")),
      files));
  return card;
}

// Shows the files of a source below its card, or hides them again.
async function mtClientFiles(id, box, button) {
  if (box.childElementCount) { box.replaceChildren(); button.textContent = "Files"; return; }
  const key = `${mt.via}:${id}`;
  button.disabled = true;
  try {
    if (!mt.sources.has(key)) mt.sources.set(key, await busyButton(button, api("/api/match/source", { method: "POST", body: JSON.stringify({ source_id: id, via: mt.via }) })));
    box.replaceChildren(...mtClientFileRows(mt.sources.get(key)));
    button.textContent = "Hide files";
  } catch (error) {
    box.replaceChildren(h("div", { class: "error" }, error.message));
  } finally {
    button.disabled = false;
  }
}

function mtClientFileRows(source) {
  if (source.error) return [h("div", { class: "error" }, `get_source refused the request (${source.error.code}): ${source.error.message}`)];
  const { downloads, url } = source.answer;
  const open = { target: "_blank", rel: "noopener noreferrer" };
  // The file name of a link (Zenodo's end in /content after it); the whole link if it has none.
  const name = (link) => {
    try {
      const parts = new URL(link).pathname.split("/").filter(Boolean);
      return decodeURIComponent((parts.at(-1) === "content" ? parts.at(-2) : parts.at(-1)) || link);
    } catch (error) {
      return link;
    }
  };
  return [
    downloads.length ? null : h("div", { class: "muted" }, "No file to download. ", h("a", { href: url, ...open }, "Open the page"), " instead."),
    ...downloads.slice(0, CLIENT_FILES).map((file) => h("div", { class: "file" },
      h("a", { href: file.url, ...open }, name(file.url)),
      h("span", { class: "muted" }, [file.kind, file.media_type, file.size == null ? null : fmtBytes(file.size)].filter(Boolean).join(", ")))),
    downloads.length > CLIENT_FILES ? h("div", { class: "muted" }, `and ${fmtCount(downloads.length - CLIENT_FILES)} more`) : null,
    h("details", {}, h("summary", {}, `Answer of get_source (${source.seconds.toFixed(2)} s)`), h("pre", {}, JSON.stringify(source.answer, null, 2))),
  ].filter(Boolean);
}
