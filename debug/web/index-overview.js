"use strict";
// ── Index: the overview of the shared jobs, then one screen per approach ───────
// The indexer job brings the index of every approach up to date, or of one. Its lines start with
// the approach that writes them (`keyword: …`), so the screen of an approach shows only its own.
const ix = { overview: null, error: null, tab: "log", loading: false, run: null, stream: null };
// Lines of the other approaches and of the steps after them, left out of the keyword log.
const KW_LOG_HIDES = new Set(["graph", "ai_summary", "transcripts"]);
// The same for the AI log. A line that starts with none of them, like an error, shows in every log.
const AI_LOG_HIDES = new Set(["keyword", "graph", "transcripts"]);

// One request for both screens: the state of the indexer job comes with the keyword index.
async function ixRefresh() {
  if (ix.loading) return;
  ix.loading = true;
  try {
    try {
      ix.overview = await api("/api/index");
      ix.error = null;
    } catch (error) {
      ix.overview = null;
      ix.error = { message: error.message, hint: error.data?.hint, database: Boolean(error.data?.unavailable) };
    }
    renderIxButtons();
    renderIxSide();
    renderIxStats();
    renderKwSide();
    renderKwStats();
    renderKwCoverage();
    renderIxDown();
    const updated = `(last ${fmtClock(new Date().toISOString())})`;
    $("#ix-updated").textContent = updated;
    $("#kw-updated").textContent = updated;
    await aiRefresh();
    await ixFollowRun();
  } finally {
    ix.loading = false;
  }
}

// One job at a time: a run of every approach or of one blocks all Start buttons.
function renderIxButtons() {
  const indexer = ix.overview?.indexer || ai.data?.indexer;
  const running = indexer?.run?.status === "running";
  for (const id of ["#ix-start", "#kw-start", "#gr-start", "#ai-start"]) $(id).disabled = !indexer || running || Boolean(indexer.missing);
  for (const id of ["#ix-stop", "#kw-stop", "#gr-stop", "#ai-stop"]) $(id).disabled = !running;
  $("#ai-start").disabled ||= ai.loading || !ai.data || ai.encoder?.status !== "running";
}

const ixErrorLines = () => [h("b", {}, ix.error.database ? "Not connected" : "Not loaded"), h("small", {}, ix.error.message), ix.error.hint ? h("span", { class: "hint" }, ix.error.hint) : null];

function renderIxSide() {
  const box = $("#ix-state");
  if (ix.error) { box.className = "db-conn down"; box.replaceChildren(...ixErrorLines().filter(Boolean)); return; }
  const indexer = ix.overview?.indexer;
  if (!indexer) return;
  const run = indexer.run, running = run?.status === "running";
  const ended = run && !running && run.duration != null ? new Date(new Date(run.started_at).getTime() + run.duration * 1000).toISOString() : null;
  box.className = `db-conn${running ? "" : run?.status === "failed" ? " down" : " off"}`;
  box.replaceChildren(...[
    h("b", {}, running ? "Indexing" : "Not running"),
    run ? h("small", { class: "mono" }, run.command) : null,
    h("small", {}, running ? `Started ${fmtAgo(run.started_at)}` : run ? `Last run ${run.status} ${fmtAgo(ended)}, after ${fmtSeconds(run.duration)}` : "No run since this server started."),
    indexer.missing ? h("span", { class: "hint" }, indexer.missing) : null,
  ].filter(Boolean));
}

// One part per approach: how far its index is; a click opens its screen.
function renderIxStats() {
  const overview = ix.overview, total = kwTotals();
  const title = (label, screen) => h("a", { onclick: () => showScreen(screen), title: `Open Index › ${label.replace(/ index$/, "")}` }, label);
  const keyword = ovSection(title("Keyword index", "keyword"),
    h("b", { class: `ov-total${overview?.exists ? "" : " muted"}` }, !overview ? "–" : overview.exists ? `${fmtShare(total.indexed + total.skipped, total.documents)} done` : "no index yet"),
    overview ? ovList(COVERAGE_STATES.map(([key, label, cls, tip]) => ovShare(label, total[key], total.documents, { color: COVERAGE_BAR[cls], tip, onclick: () => showScreen("keyword") }))) : null,
    overview ? h("small", { class: "ov-note" }, `of ${fmtCount(total.documents)} documents, not expired`) : null);
  const g = overview?.graph;
  const graphCard = ovSection(title("Graph index", "graph"),
    h("b", { class: `ov-total${g?.exists ? "" : " muted"}` }, !g ? "–" : g.exists ? `${fmtShare(g.indexed, g.pubmed)} done` : "no index yet"),
    g ? ovList([
      ovShare("With entities", g.with_entities, g.pubmed, { color: "--good", tip: "PubMed papers with at least one mapped PubTator3 entity", onclick: () => showScreen("graph") }),
      ovShare("With relations", g.with_relations, g.pubmed, { color: "--accent", tip: "PubMed papers with at least one normalized PubTator3 relation", onclick: () => showScreen("graph") }),
      ovShare("Retry PubTator3", g.retrying, g.pubmed, { color: "--warn", tip: "PubMed papers PubTator3 did not return, asked again after 2 days; meanwhile their MeSH headings still match", onclick: () => showScreen("graph") }),
    ]) : null,
    g ? h("small", { class: "ov-note" }, `of ${fmtCount(g.pubmed)} PubMed papers, not expired`) : null);
  // One approach with an index per model: its part is wide enough for both next to each other.
  const semantic = ovSection(title("AI index", "ai"),
    ai.data ? h("div", { class: "ov-parts even" }, ...ai.data.models.map(aiOverviewPart)) : h("b", { class: "ov-total muted" }, "–"),
    ai.data ? h("small", { class: "ov-note" }, `of ${fmtCount(ai.data.models[0]?.documents ?? 0)} documents, not expired`) : null);
  semantic.classList.add("wide");
  $("#ix-stats").replaceChildren(keyword, graphCard, semantic);
}

function renderIxDown() {
  for (const id of ["#ix-down", "#kw-down"]) {
    const box = $(id);
    box.hidden = !ix.error;
    if (ix.error) box.replaceChildren(h("div", { class: "db-down-box" }, h("h3", {}, ix.error.database ? "Database not reachable" : "The index could not be loaded"), h("p", {}, ix.error.message), ix.error.hint ? h("p", { class: "cmd" }, ix.error.hint) : null, h("button", { type: "button", onclick: () => ixRefresh() }, "Try again")));
  }
}

// ── The indexer run: its output lines, live, on the overview and on the screen of an approach ──
function ixAppendLog(event) {
  const [cls, text] = {
    index_started: ["run", `Start: ${event.command}`],
    line: [/\berror\b|ECONN|ENOTFOUND/i.test(event.text || "") ? "err" : "ok", event.text],
    cancel_requested: ["warn", "Stop requested …"],
    index_finished: ["run", "Done"],
    index_failed: ["err", `The indexer failed (exit code ${event.code ?? "unknown"})`],
    index_cancelled: ["err", "Stopped: the next run continues with the documents not read yet"],
  }[event.type] || ["start", JSON.stringify(event)];
  const writer = event.type === "line" ? /^(\w+): /.exec(event.text || "")?.[1] : null;
  const logs = [["#ix-log", "#ix-follow"]];
  const model = /^ai_summary: (qwen|bge):/.exec(event.text || "")?.[1];
  if (!AI_LOG_HIDES.has(writer) && (aiTechnique() === "semantic" || !model || model === aiTechnique())) logs.push(["#ai-log", "#ai-follow"]);
  if (!KW_LOG_HIDES.has(writer)) logs.push(["#kw-log", "#kw-follow"]);
  for (const [logId, followId] of logs) {
    const log = $(logId);
    if (log.firstElementChild?.classList.contains("empty")) log.replaceChildren();
    log.append(h("div", { class: cls }, h("span", { class: "t" }, `${event.t.toFixed(1)} s`), h("span", {}, text)));
    while (log.childElementCount > LOG_LIMIT) log.firstElementChild.remove();
    if ($(followId).checked) log.scrollTop = log.scrollHeight;
  }
  if (writer === "keyword" && event.text.includes("full texts:")) {
    $("#ix-run").textContent = event.text;
    $("#kw-run").textContent = event.text.replace(/^\w+: /, "");
  }
}

// Shows the run the server reports: its lines so far, then the stream while it runs.
async function ixFollowRun() {
  const run = ix.overview?.indexer.run || ai.data?.indexer.run;
  if (!run || ix.run === run.id) return;
  ix.run = run.id;
  const data = await api("/api/index/run");
  if (data.run?.id !== run.id) { ix.run = null; return; }
  for (const id of ["#ix-log", "#kw-log", "#ai-log"]) $(id).replaceChildren();
  for (const id of ["#ix-run", "#kw-run"]) $(id).textContent = "";
  for (const event of data.events) ixAppendLog(event);
  if (data.run.status !== "running") return;
  ix.stream?.close();
  const stream = new EventSource(`/api/index/events?run=${encodeURIComponent(run.id)}&from=${data.events.length}`);
  ix.stream = stream;
  const done = () => { stream.close(); if (ix.stream === stream) ix.stream = null; ixRefresh(); };
  stream.onmessage = (message) => ixAppendLog(JSON.parse(message.data));
  stream.addEventListener("end", done);
  stream.onerror = () => { if (stream.readyState === EventSource.CLOSED) done(); };
}

// Starts or stops the job from the overview or from the screen of an approach, then shows its log.
async function ixCommand(path, body = {}) {
  const keyword = state.screen === "keyword";
  const graphScreen = state.screen === "graph";
  const semantic = state.screen === "ai";
  const error = $(semantic ? "#ai-error" : keyword ? "#kw-error" : graphScreen ? "#gr-index-error" : "#ix-error");
  error.textContent = "";
  try {
    await api(path, { method: "POST", body: JSON.stringify(body) });
    if (keyword) kwSwitchTab("log");
    else if (semantic) aiSwitchTab("log");
    else {
      if (graphScreen) showScreen("index");
      ixSwitchTab("log");
    }
    // A refresh in progress still holds the state from before the command.
    while (ix.loading) await new Promise((resolve) => setTimeout(resolve, 100));
    await ixRefresh();
  } catch (failure) {
    error.textContent = failure.message;
  }
}

// ── Transcription: the job that reads audio without a transcript, and its workers ──
// The job runs on its own: a systemd unit on the VM, make transcribe elsewhere. This page sets
// how many files it reads at once and shows what it reports (the table transcription).
const tx = { data: null, error: null, loading: false, controls: "" };
const fmtLength = (seconds) => seconds == null ? "–" : seconds < 3600 ? `${Math.max(1, Math.round(seconds / 60))} min`
  : `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
// Much audio in whole hours, little to the minute.
const fmtAudio = (seconds) => seconds >= 36000 ? `${fmtCount(Math.round(seconds / 3600))} h` : seconds ? fmtLength(seconds) : "0";

// What the job does now; a job that stopped reporting does nothing.
function txNow() {
  const data = tx.data, job = data?.running ? data.state : null;
  return { job, running: Boolean(job), wanted: Math.min(data?.workers ?? 0, data?.max_workers ?? 0), active: job?.workers ?? 0, reading: job?.reading ?? [] };
}

async function txRefresh() {
  if (tx.loading) return;
  tx.loading = true;
  try {
    tx.data = await api("/api/index/transcription");
    tx.error = null;
  } catch (error) {
    tx.data = null;
    tx.error = error.message;
  } finally {
    tx.loading = false;
  }
  renderTx();
}

async function txSetWorkers(count) {
  $("#tx-error").textContent = "";
  try {
    tx.data = await api("/api/index/transcription", { method: "POST", body: JSON.stringify({ workers: count }) });
    tx.error = null;
    renderTx();
    // The job follows within seconds: look again sooner than the next refresh.
    setTimeout(txRefresh, 1200);
  } catch (error) {
    $("#tx-error").textContent = error.message;
  }
}

const txStartCommand = () => tx.data?.unit ? "sudo systemctl start matcher-transcribe" : "WHISPER_MODEL=tiny-q5_1 make transcribe";

// Why no file is in work, or null while files are read.
function txIdleReason() {
  const data = tx.data, { job, running, wanted, active } = txNow();
  if (!data.exists) return "The job has no table in this database yet: run make index or make transcribe once.";
  if (!running) return `No transcription job reports${wanted ? `, though ${plural(wanted, "file")} at once ${wanted === 1 ? "is" : "are"} set` : ""}. Start it: ${txStartCommand()}`;
  if (job.error) return job.error;
  if (job.preparing) return "Setting up speech-to-text: the first run installs its packages and downloads the model.";
  if (active) return null;
  if (!wanted) return "The job runs and waits: set a number of files in the controls.";
  return data.waiting?.documents ? "The job starts within seconds." : "No audio waits: every file is read.";
}

function renderTxSide() {
  const box = $("#tx-state"), data = tx.data;
  if (!data) {
    box.className = `db-conn${tx.error ? " down" : ""}`;
    box.replaceChildren(h("b", {}, tx.error ? "Not loaded" : "Loading …"), tx.error ? h("small", {}, tx.error) : null);
    $("#tx-workers").replaceChildren();
    $("#tx-note").textContent = "";
    tx.controls = "";
    return;
  }
  const { job, running, wanted, active, reading } = txNow();
  const reason = txIdleReason();
  const stopped = !running && wanted > 0;
  box.className = `db-conn${stopped ? " down" : active ? "" : wanted && running ? " warn" : " off"}`;
  box.replaceChildren(...[
    h("b", {}, !data.exists ? "Not set up" : stopped ? "Not running" : active ? `Reading ${plural(active, "file")} at once` : wanted ? "Nothing in work" : "Off"),
    active > wanted ? h("small", {}, `${wanted} set: ${plural(active - wanted, "worker")} ${active - wanted === 1 ? "ends" : "end"} after ${active - wanted === 1 ? "its" : "their"} file.`) : null,
    active && active < wanted && !job.error ? h("small", {}, `${wanted} set: ${(data.waiting?.documents ?? 0) > reading.length ? "more start within seconds." : "no more audio waits."}`) : null,
    reason ? h(job?.error ? "span" : "small", { class: job?.error ? "hint" : null }, reason) : null,
    data.unit ? h("small", {}, `systemd unit: ${data.unit}`) : null,
  ].filter(Boolean));
  // The buttons are built again only when they change: a click must not hit a button that goes.
  const controls = JSON.stringify([data.exists, data.max_workers, wanted]);
  if (controls !== tx.controls) {
    tx.controls = controls;
    $("#tx-workers").replaceChildren(...Array.from({ length: data.max_workers + 1 }, (_, count) => h("button", {
      type: "button", class: count === wanted ? "active" : null, disabled: !data.exists, "aria-pressed": String(count === wanted),
      title: count ? `Read ${plural(count, "file")} at once` : "Read no new file; the files in work are read to their end",
      onclick: () => txSetWorkers(count),
    }, count ? String(count) : "Off")));
  }
  const state = data.state, cores = data.cpus;
  $("#tx-note").textContent = !state ? "Each file takes up to 4 threads."
    : `${wanted ? `${wanted} × ${state.threads} threads: ${wanted * state.threads} of ${cores} cores` : `${state.threads} threads per file, ${data.max_workers} files fill the ${cores} cores`}; model ${state.model}`;
}

function renderTxPanels() {
  const data = tx.data, box = $("#tx-panels");
  if (!data) { box.replaceChildren(tx.error ? h("div", { class: "notice", style: "margin:0" }, tx.error) : h("div", { class: "muted" }, "Loading …")); return; }
  const { job, running, wanted, active, reading } = txNow();
  const reason = txIdleReason();
  const workers = h("div", { class: "panel" },
    h("h3", {}, "Workers", h("small", {}, !running ? "no job reports" : active === wanted ? `${active} of ${data.max_workers} possible on this machine`
      : active < wanted ? `${active} running, ${wanted} set` : `${active} running, ${wanted} set: ${plural(active - wanted, "worker")} ${active - wanted === 1 ? "ends" : "end"} after ${active - wanted === 1 ? "its" : "their"} file`)),
    reading.length ? h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Audio"), h("th", { class: "num" }, "Length"), h("th", {}, "Step"), h("th", {}, "For"))),
      h("tbody", {}, ...reading.map((item) => h("tr", {},
        h("td", {}, item.title, h("div", { class: "small muted" }, [item.venue, item.id].filter(Boolean).join(", "))),
        h("td", { class: "num" }, fmtLength(item.duration_seconds)),
        h("td", {}, h("span", { class: "pill plain" }, item.step)),
        h("td", { class: "when" }, fmtSpan(Date.now() - new Date(item.since)))))))
      : h("div", { class: "panel-body muted" }, reason || "Taking the next files."));

  // Files without a known length count as the average one. The files in work still wait in
  // the database: here they count as taken.
  const waiting = data.waiting || { documents: 0, seconds: 0, unknown: 0 };
  const known = waiting.documents - waiting.unknown;
  const average = known ? waiting.seconds / known : 0;
  const files = Math.max(0, waiting.documents - reading.length);
  const left = Math.max(0, average * waiting.documents - reading.reduce((sum, item) => sum + (item.duration_seconds ?? average), 0));
  const speed = data.state?.speed, pace = wanted || active || 1;
  const read = Object.fromEntries((data.read || []).map((row) => [row.status, row.documents]));
  const total = (read.ok || 0) + (read.skipped || 0) + (read.failed || 0);
  const audio = h("div", { class: "panel" },
    h("h3", {}, "Audio without a transcript", h("small", {}, "podcast episodes whose only full text is audio, newest first; the indexes read the stored transcript")),
    h("div", { class: "stats overview", style: "border:0" },
      ovSection("Waiting", h("b", { class: "ov-total" }, fmtCount(files)), ovList([
        ovFigure(fmtAudio(left), "of audio", { cls: left ? "" : "zero", title: waiting.unknown ? `${plural(waiting.unknown, "file")} without a known length ${waiting.unknown === 1 ? "counts" : "count"} as the average` : null }),
      ], true), files ? h("button", { type: "button", class: "link-button", style: "margin-top:6px", onclick: () => dbShowDocuments({ "db-fulltext": "skipped" }, data.waiting_detail) }, "Show these documents") : null),
      ovSection("Read from audio so far", ovList([
        ovShare("Transcribed", read.ok, total, { unit: "files", color: "--good", tip: "Stored for the indexes; the text goes once every index has read it" }),
        ovShare("No transcript", read.skipped, total, { unit: "files", color: "--dropped", tip: "No speech, an unreadable file, or larger than 150 MB; the episode is matched by its metadata" }),
        ovShare("Retry", read.failed, total, { unit: "files", color: "--critical", tip: "The download or speech-to-text failed; tried again a day later" }),
      ])),
      ovSection("Pace", ovList([
        ovFigure(speed ? `${speed.toFixed(1)} ×` : "–", "real time per worker", { cls: speed ? "" : "zero", title: "Seconds of audio one worker reads in a second, download included, over the 30 files read last" }),
        ovFigure(speed && left ? fmtSpan((left / (speed * pace)) * 1000) : "–", `left with ${plural(pace, "worker")}`, { cls: speed && left ? "" : "zero", title: "The waiting audio at this pace; a rough estimate" }),
      ], true))));

  const pill = { ok: ["ok", "transcribed"], skipped: ["plain", "no transcript"], failed: ["failed", "retry"] };
  const recent = data.state?.recent || [];
  const last = recent.length ? h("div", { class: "panel" },
    h("h3", {}, "Read last", h("small", {}, running ? "by the running job" : "by the job that ran last")),
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Finished"), h("th", {}, "Audio"), h("th", {}, "Result"), h("th", { class: "num" }, "Length"), h("th", { class: "num" }, "Took"))),
      h("tbody", {}, ...recent.map((item) => h("tr", {},
        h("td", { class: "when", title: fmtDateTime(item.at) }, fmtAgo(item.at)),
        h("td", {}, item.title, h("div", { class: "small muted mono" }, item.id)),
        h("td", {}, h("span", { class: `pill ${pill[item.status]?.[0] || "plain"}` }, pill[item.status]?.[1] || item.status),
          item.detail ? h("div", { class: "small muted" }, item.detail) : null),
        h("td", { class: "num" }, fmtLength(item.duration_seconds)),
        h("td", { class: "num" }, fmtSpan(item.seconds * 1000))))))) : null;
  box.replaceChildren(...[workers, audio, last].filter(Boolean));
}

function renderTx() {
  renderTxSide();
  renderTxPanels();
  const { active, wanted, running } = txNow();
  const badge = $("#tx-count");
  badge.textContent = active;
  badge.classList.toggle("bad", !running && wanted > 0);
  // The reasons of the keyword coverage name the rows this job reads, once they are known.
  renderKwCoverage();
}

function ixSwitchTab(tab) {
  ix.tab = tab;
  history.replaceState(null, "", tab === "log" ? "#index" : `#index-${tab}`);
  for (const button of document.querySelectorAll("#ix-tabs button")) button.classList.toggle("active", button.dataset.ixtab === tab);
  for (const section of document.querySelectorAll(".ixtab")) section.classList.toggle("active", section.id === `ixtab-${tab}`);
  if (tab === "log") { const log = $("#ix-log"); log.scrollTop = log.scrollHeight; }
}

for (const button of document.querySelectorAll("#ix-tabs button")) button.addEventListener("click", () => ixSwitchTab(button.dataset.ixtab));
$("#ix-refresh").addEventListener("click", () => { ixRefresh(); txRefresh(); });
$("#ix-start").addEventListener("click", () => ixCommand("/api/index/run"));
$("#gr-start").addEventListener("click", () => ixCommand("/api/index/run", { approach: "graph" }));
for (const id of ["#ix-stop", "#kw-stop", "#gr-stop"]) $(id).addEventListener("click", () => ixCommand("/api/index/cancel"));
const ixAutoRefresh = (screen, checkbox) => state.screen === screen && $(checkbox).checked && document.visibilityState === "visible";
setInterval(() => { if (ixAutoRefresh("index", "#ix-auto") || ixAutoRefresh("keyword", "#kw-auto")) ixRefresh(); }, 5000);
// The job follows a new number within seconds: its state is asked for more often than the index.
setInterval(() => { if (ixAutoRefresh("index", "#ix-auto")) txRefresh(); }, 2500);
