// The page: switching screens and their links, the theme, the info tooltips and the start.
"use strict";
function renderEnv() {
  const env = state.meta?.env || {};
  const labels = {
    NCBI_ENTREZ_EMAIL: "NCBI email", NCBI_API_KEY: "NCBI key", OPENALEX_API_KEY: "OpenAlex",
    SEMANTIC_SCHOLAR_API_KEY: "Semantic Scholar", YOUTUBE_API_KEY: "YouTube",
  };
  const chips = Object.entries(labels).map(([key, label]) => {
    if (!(key in env)) return h("span", { class: "chip", title: `Restart make debug to check ${key}` }, `? ${label}`);
    return h("span", { class: `chip ${env[key] ? "on" : ""}`, title: `${key} is ${env[key] ? "set" : "not set"}` }, `${env[key] ? "✓" : "–"} ${label}`);
  });
  const database = Boolean(state.meta?.database);
  chips.push(h("span", { class: `chip ${database ? "on" : ""}`, title: `DATABASE_URL is ${database ? "set" : "not set"}` }, `${database ? "✓" : "–"} Database`));
  if (state.meta && !state.meta.env_file_exists) chips.push(h("span", { class: "hint", title: state.meta.env_file }, "crawler/.env missing (cd crawler && cp .env.example .env)"));
  $("#env").replaceChildren(...chips);
  const store = $("#store");
  store.disabled = !database;
  store.parentElement.title = database ? "" : "Needs DATABASE_URL in crawler/.env";
  updateCommand();
}

document.addEventListener("keydown", (event) => { if (event.key === "Escape") { if (state.screen === "runs") closeDetail(); else if (state.screen === "graph") grCloseDetail(); else dbCloseDetail(); } });
// Info icons: one fixed tooltip, so the side panel's scroll area cannot clip it.
function showTip(icon) {
  const tip = $("#tip");
  tip.textContent = icon.dataset.tip;
  tip.style.display = "block";
  const rect = icon.getBoundingClientRect();
  const left = Math.min(rect.right + 8, window.innerWidth - tip.offsetWidth - 8);
  const top = Math.min(rect.top - 6, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}
for (const icon of document.querySelectorAll(".info")) {
  icon.addEventListener("mouseenter", () => showTip(icon));
  icon.addEventListener("focus", () => showTip(icon));
  icon.addEventListener("mouseleave", () => { $("#tip").style.display = "none"; });
  icon.addEventListener("blur", () => { $("#tip").style.display = "none"; });
  icon.addEventListener("click", (event) => event.preventDefault());
}

// The Index screens: the overview, then one per approach (hash #index, #index-keyword, …).
const SCREENS = { runs: "#runs-view", db: "#db-view", index: "#index-view", keyword: "#keyword-view", graph: "#graph-view", ai: "#ai-view", match: "#match-view", info: "#info-view" };

const narrowScreen = window.matchMedia("(max-width: 760px)");
const controlsToggle = $("#controls-toggle");

function setControlsVisible(visible) {
  document.body.classList.toggle("controls-hidden", !visible);
  controlsToggle.setAttribute("aria-expanded", String(visible));
  controlsToggle.textContent = visible ? "Hide controls" : "Show controls";
  controlsToggle.title = controlsToggle.textContent;
  if (state.screen === "runs" && state.tab === "graph") resizeCanvas();
}
setControlsVisible(!narrowScreen.matches);
controlsToggle.addEventListener("click", () => setControlsVisible(document.body.classList.contains("controls-hidden")));
narrowScreen.addEventListener("change", () => setControlsVisible(!narrowScreen.matches));

// Light or dark: the system's until the toggle picks the other one; picking the system's again
// forgets the choice, so the page follows the system from then on.
const themeToggle = $("#theme-toggle");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  themeToggle.setAttribute("aria-label", themeToggle.title);
  graph.dirty = true; // the citation graph reads the colours when it draws
}
applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
themeToggle.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try {
    if (theme === (systemDark.matches ? "dark" : "light")) localStorage.removeItem("theme");
    else localStorage.setItem("theme", theme);
  } catch { /* no storage: the choice lasts until the page reloads */ }
  applyTheme(theme);
});
systemDark.addEventListener("change", () => {
  let stored = null;
  try { stored = localStorage.getItem("theme"); } catch { /* no storage: follow the system */ }
  if (!stored) applyTheme(systemDark.matches ? "dark" : "light");
});

function showScreen(screen) {
  state.screen = screen;
  controlsToggle.setAttribute("aria-controls", `${screen}-controls`);
  for (const button of document.querySelectorAll("#views button")) {
    const active = button.dataset.screen === screen;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const [name, view] of Object.entries(SCREENS)) $(view).hidden = name !== screen;
  if (screen === "db") { dbSwitchTab(db.tab, false); dbRefresh(); }
  else if (screen === "index") { ixSwitchTab(ix.tab); ixRefresh(); txRefresh(); }
  else if (screen === "keyword") { kwSwitchTab(kw.tab); ixRefresh(); txRefresh(); }
  else if (screen === "graph") { grShow(); ixRefresh(); }
  else if (screen === "ai") history.replaceState(null, "", "#index-ai");
  else if (screen === "match") mtShow();
  else if (screen === "info") infoShow();
  else switchTab(state.tab);
}

for (const button of document.querySelectorAll("#views button")) button.addEventListener("click", () => showScreen(button.dataset.screen));
async function init() {
  state.meta = await api("/api/meta");
  renderEnv();
  updateForm();
  await refreshRuns();
  scheduleRender();
  if (state.meta.running) { setRunning(true); viewRun(state.meta.running, false); }
  else if (state.runs.length) viewRun(state.runs[0].id, false);
  setInterval(async () => { if (!state.liveStart) { try { state.meta = await api("/api/meta"); renderEnv(); } catch (error) { /* server restarting */ } } }, 10000);
  const hash = location.hash.slice(1);
  if (hash === "db" || hash.startsWith("db-")) {
    if (["runs", "schema"].includes(hash.slice(3))) db.tab = hash.slice(3);
    showScreen("db");
  } else if (hash === "index" || hash.startsWith("index-")) {
    // #index-transcription, #index-keyword-terms, #index-graph-entities, #index-ai …
    const [, screen = "index", tab] = /^index(?:-(keyword|graph|ai))?(?:-([a-z]+))?$/.exec(hash) || [];
    if (screen === "index" && tab === "transcription") ix.tab = tab;
    if (screen === "keyword" && ["log", "vocabulary", "terms"].includes(tab)) kw.tab = tab;
    if (screen === "graph" && ["entities", "statements", "skipped"].includes(tab)) gr.tab = tab;
    showScreen(screen);
  } else if (hash === "match" || hash.startsWith("match-")) {
    if (["rankings", "answer", "client"].includes(hash.slice(6))) mt.tab = hash.slice(6);
    showScreen("match");
  } else if (hash === "info" || hash.startsWith("info-")) {
    if (["running", "topics"].includes(hash.slice(5))) info.tab = hash.slice(5);
    showScreen("info");
  } else if (["live", "docs", "graph", "failures"].includes(hash)) switchTab(hash);
  requestAnimationFrame(frame);
}
init().catch((error) => { $("#log").replaceChildren(h("div", { class: "err" }, `Server not reachable: ${error.message}`)); });
