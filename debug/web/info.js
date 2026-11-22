"use strict";
// ── Info screen: the machine, the timers, what runs, the topic files ──────────
const info = { data: null, error: null, tab: "schedule", loading: false, topic: null, topics: new Map(), docCounts: null, countsAsked: false };
const fmtGB = (bytes) => (bytes / 2 ** 30).toFixed(bytes < 10 * 2 ** 30 ? 1 : 0);
const fmtSize = (bytes) => bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : fmtBytes(bytes);
// To the minute within a day, as the timers run at set times.
function fmtUntil(iso) {
  if (!iso) return "–";
  const minutes = Math.round((new Date(iso) - Date.now()) / 60000);
  if (minutes <= 0) return "now";
  if (minutes >= 1440) return `in ${fmtSpan(minutes * 60000)}`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `in ${hours ? `${hours} h` : ""}${hours && rest ? " " : ""}${rest ? `${rest} min` : ""}`;
}
const CALENDAR_DAYS = { Mon: "Mondays", Tue: "Tuesdays", Wed: "Wednesdays", Thu: "Thursdays", Fri: "Fridays", Sat: "Saturdays", Sun: "Sundays" };
// OnCalendar= as deploy/vm-setup.sh writes it: "*-*-* 03:00:00 UTC" or "Sun *-*-* 23:30:00 UTC"
function fmtCalendar(calendar) {
  const match = /^(?:(\w{3}) )?\*-\*-\* (\d\d:\d\d):\d\d UTC$/.exec(calendar || "");
  return match ? `${match[1] ? CALENDAR_DAYS[match[1]] : "daily"} ${match[2]} UTC` : calendar || "–";
}

async function infoRefresh(fresh = false) {
  if (info.loading) return;
  info.loading = true;
  try {
    info.data = await api(`/api/info${fresh ? "?fresh=1" : ""}`);
    info.error = null;
  } catch (error) {
    info.error = error.message;
  } finally {
    info.loading = false;
  }
  renderInfoSide();
  renderInfoStats();
  // the tables change with the probes, every 30 s: redrawn every 5 s, a selection in them would go
  const key = JSON.stringify([info.error, info.data?.probed_at, info.data?.runs, info.data?.mcp]);
  if (key !== info.drawn) {
    info.drawn = key;
    renderInfoSchedule();
    renderInfoRunning();
  }
  $("#info-updated").textContent = `· ${fmtClock(new Date().toISOString())}`;
}

function infoShow() {
  $("#info-topics-count").textContent = state.meta?.topics?.length ?? 0;
  infoSwitchTab(info.tab);
  infoRefresh();
}

function infoSwitchTab(tab) {
  info.tab = tab;
  history.replaceState(null, "", tab === "schedule" ? "#info" : `#info-${tab}`);
  for (const button of document.querySelectorAll("#info-tabs button")) button.classList.toggle("active", button.dataset.infotab === tab);
  for (const section of document.querySelectorAll(".infotab")) section.classList.toggle("active", section.id === `infotab-${tab}`);
  if (tab === "topics") infoShowTopics();
}

const infoJobs = () => (info.data?.schedule?.error ? [] : info.data?.schedule?.jobs || []);
const infoLive = () => Boolean(info.data?.schedule?.live);

// A run already in progress opens as on load: its clock and Stop come from its events.
function infoShowRun(id) {
  showScreen("runs");
  if (state.view !== id) viewRun(id, false);
}

function renderInfoSide() {
  const data = info.data, box = $("#info-host");
  if (!data) {
    box.className = `db-conn${info.error ? " down" : ""}`;
    box.replaceChildren(h("b", {}, info.error ? "Not loaded" : "Loading …"), info.error ? h("small", {}, info.error) : null);
    return;
  }
  const m = data.machine.error ? {} : data.machine;
  box.className = "db-conn";
  box.replaceChildren(
    h("b", {}, m.host ?? data.machine.error ?? "–"),
    h("small", {}, [m.os, m.cpus ? `${m.cpus} cores` : null, m.memory ? `${fmtGB(m.memory.total)} GB memory` : null].filter(Boolean).join(" · ")),
    m.uptime != null ? h("small", {}, `Running for ${fmtSpan(m.uptime * 1000)}`) : null);
  const code = data.code;
  $("#info-code").replaceChildren(...(code && !code.error ? [
    h("dt", {}, "Branch"), h("dd", { class: "mono" }, code.branch),
    h("dt", {}, "Commit"), h("dd", { title: code.subject }, h("span", { class: "mono" }, code.commit), ` · ${fmtAgo(code.date)}`),
    h("dt", {}, "Changed"), h("dd", { class: code.changed ? "expiring" : "muted", title: "Tracked files that differ from the commit" }, code.changed == null ? "–" : code.changed ? plural(code.changed, "file") : "none"),
  ] : [h("dd", { class: "muted" }, code?.error || "Not a git checkout")]));
}

function renderInfoStats() {
  const box = $("#info-stats"), data = info.data;
  if (!data) { box.replaceChildren(ovSection("This machine", info.error ? h("div", { class: "notice", style: "margin:0" }, info.error) : h("b", { class: "ov-total muted" }, "–"))); return; }
  const m = data.machine.error ? {} : data.machine;
  const cores = m.cpus || 1;
  const machine = [
    // the first share needs a second probe: until then the row holds its place
    m.cpu == null && !m.memory ? null : ovShare("CPU", m.cpu ?? 0, 100, { display: m.cpu == null ? "–" : `${Math.round(m.cpu)} %`, percent: false, tip: `How busy all ${cores} cores were since the last refresh` }),
    m.load ? ovShare("Load", m.load[0], cores, { display: `${m.load[0].toFixed(1)} of ${cores}`, percent: false, color: m.load[0] > cores ? "--critical" : null,
      tip: `Processes on or waiting for a core, the average of the last minute; 5 min ${m.load[1].toFixed(1)}, 15 min ${m.load[2].toFixed(1)}. Above ${cores}, processes wait.` }) : null,
    m.memory ? ovShare("Memory", m.memory.used, m.memory.total, { display: `${fmtGB(m.memory.used)} of ${fmtGB(m.memory.total)} GB` }) : null,
    m.disk ? ovShare("Disk", m.disk.used, m.disk.total, { display: `${fmtGB(m.disk.used)} of ${fmtGB(m.disk.total)} GB`, tip: `The disk that holds ${m.disk.path}` }) : null,
  ];
  const plan = data.schedule?.error ? null : data.schedule;
  const upcoming = infoJobs().filter((job) => job.next).sort((a, b) => a.next.localeCompare(b.next)).slice(0, 3);
  const timers = infoJobs().filter((job) => job.running);
  const runs = data.runs;
  box.replaceChildren(
    ovSection("This machine", ovList(machine.filter(Boolean))),
    ovSection(plan?.live ? "Up next" : "Up next on the VM",
      plan ? ovList(upcoming.map((job) => ovFigure(fmtUntil(job.next), job.label, { title: `${fmtCalendar(job.calendar)}; ${fmtDateTime(job.next)} your time` })), "words")
        : h("div", { class: "notice", style: "margin:0" }, data.schedule?.error || "–"),
      plan && !plan.live ? h("small", { class: "ov-note" }, "This machine runs no timers") : null),
    ovSection(h("span", { title: "Runs started from this page, the timers of this machine, the MCP server and the database. A crawl or make index started in a terminal shows only as a process, under Running." }, "Running now"), ovList([
      ovFigure(runs.crawl ? "running" : "none", "crawler run", { cls: runs.crawl ? "on" : "zero", title: runs.crawl?.command ?? null, onclick: runs.crawl ? () => infoShowRun(runs.crawl.id) : null }),
      ovFigure(runs.index ? "running" : "none", "indexer", { cls: runs.index ? "on" : "zero", title: runs.index?.command ?? null, onclick: runs.index ? infoShowIndexer : null }),
      infoTranscription(data.database?.transcription),
      plan?.live ? ovFigure(timers.length ? fmtCount(timers.length) : "none", timers.length === 1 ? "timer job" : "timer jobs", { cls: timers.length ? "on" : "zero", title: timers.map((job) => job.label).join(", ") || null }) : null,
      ovFigure(data.mcp.running ? "up" : "down", "MCP server", { cls: data.mcp.running ? "on" : plan?.live ? "bad" : "zero", title: data.mcp.url }),
      ovFigure(data.database?.up ? "up" : "down", "database", { cls: data.database?.up ? "on" : "bad", title: data.database?.up ? data.database.target : data.database?.error ?? null }),
    ], "words")),
  );
}

// The indexer run started from this page, with its log on the Index overview.
function infoShowIndexer() {
  ix.tab = "log";
  showScreen("index");
}

// The transcription job: a service of its own, set on the Index overview.
function infoTranscription(job) {
  const reading = job?.running && job.workers > 0, stopped = Boolean(job && !job.running && job.wanted > 0);
  return ovFigure(reading ? plural(job.workers, "file") : stopped ? "down" : job?.running ? "off" : "none", "transcription", {
    cls: reading ? "on" : stopped ? "bad" : "zero",
    title: !job ? "No transcription job has run on this database" : `${plural(job.wanted, "file")} at once set on the Index overview; ${job.running ? `the job reads ${job.workers}` : "no job reports"}`,
    onclick: () => { ix.tab = "transcription"; showScreen("index"); },
  });
}

function infoResult(job) {
  if (job.running) return h("span", { class: "pill plain" }, "running");
  if (!job.result) return h("span", { class: "muted" }, "–");
  return job.result === "success" ? h("span", { class: "pill ok" }, "ok") : h("span", { class: "pill failed", title: `systemd result: ${job.result}` }, "failed");
}

function renderInfoSchedule() {
  const data = info.data;
  if (!data) { $("#info-schedule").replaceChildren(); return; }
  const plan = data.schedule, live = infoLive();
  const timers = plan?.error ? h("div", { class: "notice", style: "margin:0" }, plan.error) : h("div", { class: "panel" },
    h("h3", {}, "Timers", h("small", {}, live ? "systemd on this machine" : "Planned for the VM by deploy/vm-setup.sh. This machine runs no timers: the next runs are worked out from the plan.")),
    h("table", {},
      h("thead", {}, h("tr", {}, ...["Job", "When", "Next", ...(live ? ["Last run", "Took", "Result"] : [])].map((label) => h("th", {}, label)))),
      h("tbody", {}, ...plan.jobs.map((job) => h("tr", { title: live ? `Log: journalctl -u ${job.unit.replace(/\.service$/, "")}` : null },
        h("td", {}, job.label, h("div", { class: "small muted mono" }, job.unit)),
        h("td", { class: "when", title: job.calendar }, fmtCalendar(job.calendar)),
        h("td", { class: "when", title: job.next ? `${fmtDateTime(job.next)} your time` : null }, job.running ? "running now" : fmtUntil(job.next)),
        ...(live ? [
          h("td", { class: "when", title: fmtDateTime(job.last_start || job.last) }, fmtAgo(job.last_start || job.last)),
          h("td", { class: "when" }, job.last_start && job.last_end && job.last_end > job.last_start ? fmtSpan(new Date(job.last_end) - new Date(job.last_start)) : "–"),
          h("td", {}, infoResult(job)),
        ] : []))))));
  $("#info-schedule").replaceChildren(timers, infoStoredPanel(data));
}

// What this database holds, whoever put it there: a timer, Store in the database, make index.
function infoStoredPanel(data) {
  const database = data.database;
  if (!database?.up) return h("div", { class: "panel" }, h("h3", {}, "In this database"), h("div", { class: "panel-body muted" }, database?.error || "Not loaded"));
  const crawls = new Map((database.crawls || []).map((run) => [run.source, run]));
  const sources = [...new Set([...Object.keys(SOURCE_LABEL), ...crawls.keys()])];
  const row = (what, note, iso, result = null) => h("tr", {}, h("td", {}, what, note ? h("div", { class: "small muted" }, note) : null),
    h("td", { class: "when", title: iso ? fmtDateTime(iso) : null }, iso ? fmtAgo(iso) : "never"), h("td", {}, result));
  // A crawl stores one run per topic: the result is that of the newest run of every topic.
  const result = (run) => {
    if (!run.topics) return h("span", { class: `pill ${run.ok ? "ok" : "failed"}` }, run.ok ? "ok" : "failed");
    const failed = run.failed_topics, all = plural(run.topics, "topic");
    return h("span", { class: `pill ${failed ? "failed" : "ok"}`, title: failed ? `The newest stored run of ${failed} of the ${all} failed or was stopped; the next crawl runs them again` : `The newest stored run of each of the ${all} succeeded` },
      failed ? `${failed} of ${all} failed` : "ok");
  };
  const rows = sources.map((source) => {
    const run = crawls.get(source);
    return row(SOURCE_LABEL[source] || source, null, run?.finished_at, run ? result(run) : null);
  });
  rows.push(row("Keyword index", "the last full text indexed", database.indexed));
  const backups = data.backups && !data.backups.error ? data.backups : null;
  if (backups) rows.push(row("Backup", backups.newest ? `${backups.newest.name}, ${fmtSize(backups.newest.size)}; ${plural(backups.count, "dump")} kept` : null, backups.newest?.at));
  return h("div", { class: "panel" },
    h("h3", {}, "In this database", h("small", {}, `${database.target}: the newest stored run per source, from a timer or from Store in the database`)),
    h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Source"), h("th", {}, "Last stored run"), h("th", {}, "Result"))), h("tbody", {}, ...rows)));
}

function renderInfoRunning() {
  const data = info.data;
  if (!data) { $("#info-running").replaceChildren(); return; }
  const runs = data.runs, live = infoLive();
  const line = (main, detail, action = null) => h("div", { class: "info-line" }, h("span", {}, main), detail ? h("small", { class: "muted" }, detail) : null, action);
  const show = (onclick) => h("button", { type: "button", class: "link-button", onclick }, "Show");
  const panel = (title, note, ...body) => h("div", { class: "panel" }, h("h3", {}, title, note ? h("small", {}, note) : null), h("div", { class: "panel-body" }, ...body));
  const started = [
    runs.crawl && line(h("span", { class: "mono" }, runs.crawl.command), `for ${fmtAgo(runs.crawl.started_at).replace(/ ago$/, "")}${runs.crawl.store ? ", with Store" : ""}`, show(() => infoShowRun(runs.crawl.id))),
    runs.index && line(h("span", { class: "mono" }, runs.index.command), `for ${fmtAgo(runs.index.started_at).replace(/ ago$/, "")}`, show(infoShowIndexer)),
  ].filter(Boolean);
  const timers = infoJobs().filter((job) => job.running);
  const database = data.database;
  const containers = data.containers, processes = data.processes;
  $("#info-running").replaceChildren(
    h("div", { class: "notice quiet", style: "margin:0" }, "This page sees the runs started here, the timers of this machine, Docker containers and processes. A crawl or make index started in a terminal shows only as a process."),
    panel("Started from this page", null, ...(started.length ? started : [h("span", { class: "muted" }, "Nothing started from this page runs.")])),
    panel("Timers", null, ...(!live ? [h("span", { class: "muted" }, "This machine runs no timers.")]
      : timers.length ? timers.map((job) => line(job.label, `for ${fmtAgo(job.last_start).replace(/ ago$/, "")} · ${job.unit}`))
      : [h("span", { class: "muted" }, "No timer job runs right now.")])),
    panel("Services", null,
      line("MCP server", `${data.mcp.url} · ${data.mcp.running ? "up" : "down"}${data.schedule?.mcp_service ? ` · systemd ${data.schedule.mcp_service}` : ""}`),
      line("Transcription job", `${database?.transcription?.running ? `reads ${plural(database.transcription.workers, "file")} at once, ${database.transcription.wanted} set` : "not running"}${data.schedule?.transcribe_service ? ` · systemd ${data.schedule.transcribe_service}` : ""}`,
        show(() => { ix.tab = "transcription"; showScreen("index"); })),
      line("Database", database?.up ? `${database.target} · ${fmtSize(database.size)} · ${plural(database.connections, "session")}` : database?.error || "down")),
    panel("Docker containers", null, ...(Array.isArray(containers) ? (containers.length
      ? [h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Container"), h("th", {}, "Status"))), h("tbody", {}, ...containers.map((item) => h("tr", {}, h("td", { class: "mono" }, item.name), h("td", { class: "small" }, item.status)))))]
      : [h("span", { class: "muted" }, "No container runs.")])
      : [h("span", { class: "muted" }, containers?.error || "Docker is not available to this server.")])),
    panel("Busiest processes", "CPU since the last probe, at most 30 s ago; 100 % is one core", ...(Array.isArray(processes)
      ? [h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Process"), h("th", { class: "num" }, "PID"), h("th", { class: "num" }, "CPU"), h("th", { class: "num" }, "Memory"))),
          h("tbody", {}, ...processes.map((item) => h("tr", {}, h("td", {}, item.name), h("td", { class: "num small" }, item.pid), h("td", { class: `num${item.cpu == null ? " muted" : ""}`, title: item.cpu == null ? "Needs a second probe" : null }, item.cpu == null ? "–" : `${Math.round(item.cpu)} %`), h("td", { class: "num small" }, item.memory != null ? fmtSize(item.memory) : "–")))))]
      : [h("span", { class: "muted" }, processes?.error || "Needs the Python package psutil.")])),
  );
}

function infoShowTopics() {
  const topics = state.meta?.topics || [];
  $("#info-topics-count").textContent = topics.length;
  const facets = db.overview?.documents?.topics;
  if (!info.docCounts && facets) info.docCounts = new Map(facets.map((facet) => [facet.value, facet.count]));
  if (!info.docCounts && !info.countsAsked) {
    info.countsAsked = true;
    api("/api/db").then((overview) => {
      info.docCounts = new Map((overview.documents?.topics || []).map((facet) => [facet.value, facet.count]));
      renderInfoTopicList();
    }).catch(() => { /* no database: the list shows no counts */ });
  }
  renderInfoTopicList();
  if (!info.topic && topics.length) infoOpenTopic(topics[0].id);
}

function renderInfoTopicList() {
  const needle = $("#info-topic-filter").value.trim().toLowerCase();
  const topics = (state.meta?.topics || []).filter((topic) => !needle || topic.label.toLowerCase().includes(needle) || topic.id.includes(needle)
    || (topic.terms || []).some((term) => term.toLowerCase().includes(needle)));
  $("#info-topic-list").replaceChildren(...(topics.length ? topics.map((topic) => {
    const documents = info.docCounts?.get(topic.id);
    return h("li", { class: topic.id === info.topic ? "active" : null, title: topic.error || null, onclick: () => infoOpenTopic(topic.id) },
      h("span", {}, topic.label),
      // with the database: the documents a search of the topic found; else the topic's queries
      h("small", { title: info.docCounts ? "Documents in this database that a search of this topic found" : null }, topic.error ? "error" : info.docCounts ? `${fmtCount(documents ?? 0)} docs` : `${topic.queries} queries`));
  }) : [h("li", { class: "empty" }, "No topic file matches")]));
}

async function infoOpenTopic(id) {
  info.topic = id;
  renderInfoTopicList();
  let topic = info.topics.get(id);
  if (!topic) {
    $("#info-topic").replaceChildren(h("div", { class: "muted" }, "Loading …"));
    try {
      topic = await api(`/api/topics/${encodeURIComponent(id)}`);
      info.topics.set(id, topic);
    } catch (error) {
      if (info.topic === id) $("#info-topic").replaceChildren(h("div", { class: "notice", style: "margin:0" }, error.message));
      return;
    }
  }
  if (info.topic === id) { $("#info-topic").replaceChildren(...infoTopicDetail(topic)); $("#info-topic").scrollTop = 0; }
}

function infoTopicDetail(topic) {
  const section = (title, count, ...content) => h("section", { class: "topic-section" }, h("h4", {}, title, count != null ? h("small", {}, fmtCount(count)) : null), ...content);
  const chips = (items) => h("div", { class: "chips" }, ...items.map((item) => h("span", { class: "term" }, item)));
  const queries = (topic.queries || []).reduce((sum, group) => sum + group.queries.length, 0);
  return [
    h("div", { class: "topic-head" }, h("h3", {}, topic.label), h("small", { class: "muted mono" }, topic.file)),
    topic.error ? h("div", { class: "notice", style: "margin:0" }, topic.error) : null,
    topic.terms ? section("Filter terms", topic.terms.length, h("p", {}, "A cited paper is kept only if it contains one of them."), chips(topic.terms)) : null,
    topic.queries ? section("Queries", queries, h("p", {}, "The searches of PubMed, arXiv and Zenodo."), ...topic.queries.map((group) => h("div", { class: "topic-group" }, group.name ? h("small", {}, group.name) : null, chips(group.queries)))) : null,
    topic.channels?.length ? section("YouTube channels", topic.channels.length, h("ul", { class: "topic-links" }, ...topic.channels.map((channel) => h("li", {}, h("a", { href: channel.url, target: "_blank", rel: "noopener" }, channel.name))))) : null,
    topic.podcasts?.length ? section("Podcast feeds", topic.podcasts.length, h("ul", { class: "topic-links" }, ...topic.podcasts.map((feed) => h("li", {},
      h("a", { href: feed.url, target: "_blank", rel: "noopener" }, feed.name), h("small", { class: "muted" }, ` ${feed.publisher}, for ${feed.audience}`))))) : null,
    h("details", { class: "topic-file" }, h("summary", {}, "The file as it is"), h("pre", {}, topic.yaml)),
  ].filter(Boolean);
}

for (const button of document.querySelectorAll("#info-tabs button")) button.addEventListener("click", () => infoSwitchTab(button.dataset.infotab));
$("#info-refresh").addEventListener("click", () => infoRefresh(true));
$("#info-topic-filter").addEventListener("input", renderInfoTopicList);
setInterval(() => { if (state.screen === "info" && $("#info-auto").checked && document.visibilityState === "visible") infoRefresh(); }, 5000);
