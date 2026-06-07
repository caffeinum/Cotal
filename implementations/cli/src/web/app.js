// Swarl observability client: a read-only view of one space. Presence + channel
// list come over HTTP; the live message stream and roster updates arrive via SSE
// (/feed). Everything is observation — this page never publishes to the mesh.

const $ = (id) => document.getElementById(id);
// Status order (sort priority) + shape glyph. Shape + color, never color alone.
const STATUS = ["working", "waiting", "idle", "offline"];
const GLYPH = { working: "●", waiting: "◐", idle: "○", offline: "⊘" };
const MODES = ["chat", "unicast", "anycast"];

let roster = [];
let channels = new Map(); // name -> total message count
let unread = new Map(); // name -> messages seen since last viewed
let selected = "*"; // "*" = all activity, else a channel name
let activity = []; // {mode, msg} ring buffer for the all-activity view
let channelMsgs = []; // messages for the selected channel
let modes = new Set(MODES); // delivery modes currently shown
let paused = false; // freeze auto-scroll so a value can be read

const esc = (s) =>
  String(s).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const bodyText = (msg) =>
  (msg.parts || []).map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ");
function rel(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function setConn(live) {
  const el = $("conn");
  el.className = "conn " + (live ? "live" : "down");
  el.textContent = live ? "live" : "disconnected";
}

// "What's happening now" — one tile per status, waiting emphasized when nonzero.
function renderTiles() {
  const counts = { working: 0, waiting: 0, idle: 0, offline: 0 };
  for (const p of roster) counts[p.status] = (counts[p.status] ?? 0) + 1;
  $("tiles").innerHTML = STATUS.map(
    (k) => `<div class="tile ${k}${k === "waiting" && counts[k] ? " hot" : ""}">
      <span class="n">${counts[k]}</span><span class="lbl">${k}</span>
    </div>`,
  ).join("");
  const online = roster.filter((p) => p.status !== "offline").length;
  $("online-c").textContent = online;
}

function renderRoster() {
  const sorted = [...roster].sort(
    (a, b) =>
      STATUS.indexOf(a.status) - STATUS.indexOf(b.status) ||
      a.card.name.localeCompare(b.card.name),
  );
  $("roster").innerHTML =
    roster.length === 0
      ? `<div class="empty">no peers</div>`
      : sorted
          .map(
            (p) => `<div class="peer ${p.status}" title="${esc(p.card.id)}">
              <span class="dot ${p.status}">${GLYPH[p.status]}</span>
              <div class="meta">
                <div class="l1">
                  <span class="name">${esc(p.card.name)}</span>
                  ${p.card.role ? `<span class="role">${esc(p.card.role)}</span>` : ""}
                  ${p.status === "waiting" ? `<span class="tag">needs input</span>` : ""}
                </div>
                ${p.activity ? `<div class="act" title="${esc(p.activity)}">${esc(p.activity)}</div>` : ""}
              </div>
            </div>`,
          )
          .join("");
}

// Channels: flat dotted names (the hierarchy reads fine inline), unread pill before
// the dimmed total.
function renderChannels() {
  const names = [...channels.keys()].sort();
  const total = [...channels.values()].reduce((a, b) => a + b, 0);
  const row = (key, inner, count, unreadN) => {
    const sel = selected === key ? " sel" : "";
    return `<div class="chan${sel}" data-ch="${esc(key)}">
      ${inner}
      ${unreadN ? `<span class="unread">${unreadN}</span>` : ""}
      <span class="count">${count}</span>
    </div>`;
  };
  $("channels").innerHTML =
    row("*", `<span class="name">✸ all activity</span>`, total, 0) +
    (names.length
      ? names
          .map((n) =>
            row(n, `<span class="hash">#</span><span class="name">${esc(n)}</span>`, channels.get(n), unread.get(n) ?? 0),
          )
          .join("")
      : `<div class="empty">no channels yet</div>`);
  for (const el of $("channels").querySelectorAll(".chan")) el.onclick = () => select(el.dataset.ch);
}

// "What needs you" — agents blocked/waiting, newest first, with how long.
function renderAttention() {
  const waiting = [...roster]
    .filter((p) => p.status === "waiting")
    .sort((a, b) => b.ts - a.ts);
  $("attn-n").style.display = waiting.length ? "" : "none";
  $("attn-n").textContent = waiting.length;
  $("attention").innerHTML = waiting.length
    ? waiting
        .map(
          (p) => `<div class="card" title="${esc(p.card.id)}">
            <div class="ch"><span class="cat">WAITING</span><span class="when">${rel(p.ts)}</span></div>
            <div class="title">${esc(p.card.name)} is blocked</div>
            <div class="desc">${esc(p.activity || "waiting for input")}</div>
          </div>`,
        )
        .join("") + `<div class="rail-foot">Everything else stays quiet in the feed.</div>`
    : `<div class="empty">nothing waiting — all clear ✓</div>`;
}

function msgRow(entry) {
  const { mode, msg } = entry;
  const who = `${esc(msg.from?.name ?? "?")}${msg.from?.role ? `<span class="tgt">/${esc(msg.from.role)}</span>` : ""}`;
  const tgt =
    mode === "chat"
      ? `#${esc(msg.channel ?? "")}`
      : mode === "unicast"
        ? `→ ${esc(msg.to ?? "")}`
        : `→ @${esc(msg.toService ?? "")}`;
  return `<div class="msg ${mode}">
    <div class="top">
      <span class="ts">${time(msg.ts)}</span>
      <span class="badge ${mode}">${mode}</span>
      <span class="who">${who}</span><span class="tgt">${tgt}</span>
    </div>
    <div class="body">${esc(bodyText(msg))}</div>
  </div>`;
}

function renderFeed() {
  const feed = $("feed");
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const rows = (selected === "*" ? activity : channelMsgs.map((msg) => ({ mode: "chat", msg }))).filter(
    (e) => modes.has(e.mode),
  );
  if (selected === "*") {
    $("feed-title").textContent = "All activity";
    $("feed-sub").textContent = `${rows.length} shown · live`;
  } else {
    $("feed-title").textContent = `#${selected}`;
    $("feed-sub").textContent = `${rows.length} message${rows.length === 1 ? "" : "s"}`;
  }
  feed.innerHTML = rows.length
    ? rows.map(msgRow).join("")
    : `<div class="empty">${selected === "*" ? "waiting for messages…" : "no messages"}</div>`;
  if (atBottom && !paused) feed.scrollTop = feed.scrollHeight;
}

let loadSeq = 0;
async function select(key) {
  selected = key;
  unread.set(key, 0);
  renderChannels();
  if (key !== "*") {
    const seq = ++loadSeq;
    channelMsgs = [];
    renderFeed();
    const msgs = await (await fetch(`/api/channels/${encodeURIComponent(key)}/history?limit=200`)).json();
    if (seq !== loadSeq) return; // a newer selection superseded this load
    channelMsgs = msgs;
  }
  renderFeed();
}

async function refresh() {
  roster = await (await fetch("/api/roster")).json();
  renderTiles();
  renderRoster();
  renderAttention();
  const list = await (await fetch("/api/channels")).json();
  channels = new Map(list.map((c) => [c.channel, c.messages]));
  renderChannels();
  if (selected !== "*") {
    select(selected);
  } else {
    // Seed the all-activity feed with recent channel history, then live tails it.
    const recent = await (await fetch("/api/activity?limit=200")).json();
    activity = recent.map((msg) => ({ mode: "chat", msg }));
    renderFeed();
  }
}

function onMessage(entry) {
  const { msg } = entry;
  if (activity.some((e) => e.msg.id === msg.id)) return; // dedupe backfill vs live
  activity.push(entry);
  if (activity.length > 500) activity.shift();
  if (msg.channel) {
    channels.set(msg.channel, (channels.get(msg.channel) ?? 0) + 1);
    if (selected === msg.channel) {
      channelMsgs.push(msg);
      if (channelMsgs.length > 500) channelMsgs.shift();
    } else {
      unread.set(msg.channel, (unread.get(msg.channel) ?? 0) + 1);
    }
    renderChannels();
  }
  renderFeed();
}

function connect() {
  const es = new EventSource("/feed");
  es.addEventListener("open", () => {
    setConn(true);
    refresh();
  });
  es.addEventListener("roster", (e) => {
    roster = JSON.parse(e.data);
    renderTiles();
    renderRoster();
    renderAttention();
  });
  es.addEventListener("message", (e) => onMessage(JSON.parse(e.data)));
  es.addEventListener("error", () => setConn(false));
}

// Delivery-mode chips toggle which kinds of traffic the feed shows.
for (const chip of document.querySelectorAll(".chip[data-mode]")) {
  chip.onclick = () => {
    const m = chip.dataset.mode;
    if (modes.has(m)) modes.delete(m);
    else modes.add(m);
    chip.classList.toggle("on", modes.has(m));
    renderFeed();
  };
}
$("pause").onclick = () => {
  paused = !paused;
  $("pause").classList.toggle("on", paused);
  $("pause").textContent = paused ? "paused" : "pause";
  if (!paused) renderFeed();
};

fetch("/api/meta")
  .then((r) => r.json())
  .then((m) => {
    $("space").textContent = `· ${m.space}`;
    document.title = `Swarl · ${m.space}`;
  });

refresh();
connect();
