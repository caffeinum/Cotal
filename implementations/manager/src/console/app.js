// Swarl console client: one xterm pane per managed agent, each wired straight to
// the manager's attach WebSocket (addon-attach). We discover agents over HTTP
// (the manager's /agents list, which it cross-references with mesh presence) and
// stream the actual terminal bytes over the direct socket — never the mesh.
const { Terminal } = window;
const { FitAddon } = window.FitAddon;
const { AttachAddon } = window.AttachAddon;

const grid = document.getElementById("grid");
const empty = document.getElementById("empty");
const meta = document.getElementById("meta");
const panes = new Map(); // name -> { el, term, fit, ws, status }

function wsUrl(name) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/attach/${encodeURIComponent(name)}`;
}

function layout() {
  const n = panes.size;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  for (const p of panes.values()) p.fit.fit();
}

function addPane(agent) {
  const el = document.createElement("div");
  el.className = "pane";
  el.innerHTML = `<div class="bar"><span class="dot"></span><span class="name"></span><span class="role"></span></div><div class="term"></div>`;
  el.querySelector(".name").textContent = agent.name;
  el.querySelector(".role").textContent = agent.role ? `· ${agent.role}` : "";
  grid.appendChild(el);

  const term = new Terminal({
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    cursorBlink: true,
    theme: { background: "#000000" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector(".term"));

  const ws = new WebSocket(wsUrl(agent.name));
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    term.loadAddon(new AttachAddon(ws));
    fit.fit();
    sendResize(ws, term);
  };
  // addon-attach forwards keystrokes; resize is our own text frame (r:cols,rows).
  term.onResize(() => sendResize(ws, term));

  const pane = { el, term, fit, ws, status: agent.status };
  panes.set(agent.name, pane);
  empty.style.display = "none";
  layout();
}

function sendResize(ws, term) {
  if (ws.readyState === WebSocket.OPEN) ws.send(`r:${term.cols},${term.rows}`);
}

function removePane(name) {
  const p = panes.get(name);
  if (!p) return;
  try { p.ws.close(); } catch {}
  p.term.dispose();
  p.el.remove();
  panes.delete(name);
  if (panes.size === 0) empty.style.display = "";
  layout();
}

function setStatus(name, status) {
  const p = panes.get(name);
  if (!p) return;
  p.status = status;
  p.el.querySelector(".dot").className = `dot ${status === "running" ? "running" : "exited"}`;
}

async function poll() {
  try {
    const agents = await (await fetch("/agents")).json();
    meta.textContent = `${agents.length} agent${agents.length === 1 ? "" : "s"} · space ${agents[0]?.space ?? ""}`.trim();
    const seen = new Set();
    for (const a of agents) {
      seen.add(a.name);
      if (!panes.has(a.name)) addPane(a);
      setStatus(a.name, a.status);
    }
    for (const name of [...panes.keys()]) if (!seen.has(name)) removePane(name);
  } catch (e) {
    meta.textContent = "manager unreachable";
  }
}

window.addEventListener("resize", layout);
poll();
setInterval(poll, 2000);
