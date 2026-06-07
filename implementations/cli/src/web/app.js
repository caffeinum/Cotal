// Swarl observability client: a read-only view of one space. Presence + channel
// list come over HTTP; the live message stream and roster updates arrive via SSE
// (/feed). Everything is observation — this page never publishes to the mesh.

const $ = (id) => document.getElementById(id);
// Status order (priority for sorting) + shape glyph. Shape + color, never color
// alone — the glyph alone tells working/waiting/idle/offline apart.
const STATUS = ["working", "waiting", "idle", "offline"];
const GLYPH = { working: "●", waiting: "◐", idle: "○", offline: "⊘" };

let roster = [];
let channels = new Map(); // name -> total message count
let unread = new Map(); // name -> messages seen since last viewed
let selected = "*"; // "*" = all activity, else a channel name
let activity = []; // {mode, msg} ring buffer for the all-activity view
let channelMsgs = []; // messages for the selected channel
let filter = "";
let paused = false; // freeze auto-scroll so a value can be read

const esc = (s) =>
  String(s).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
const time = (ts) => new Date(ts).toLocaleTimeString();
const bodyText = (msg) =>
  (msg.parts || []).map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ");

function setConn(live) {
  const el = $("conn");
  el.className = "conn " + (live ? "live" : "down");
  el.textContent = live ? "live" : "disconnected";
}

// "What's happening now" — one count per status, waiting emphasized when nonzero.
function renderSignals() {
  const counts = { working: 0, waiting: 0, idle: 0, offline: 0 };
  for (const p of roster) counts[p.status] = (counts[p.status] ?? 0) + 1;
  const sig = (k) =>
    `<div class="sig ${k}${k === "waiting" && counts[k] ? " hot" : ""}">
      <span class="n">${counts[k]}</span><span class="lbl">${k}</span>
    </div>`;
  $("signals").innerHTML =
    STATUS.map(sig).join("") +
    `<div class="sig spacer">${channels.size} channel${channels.size === 1 ? "" : "s"}</div>`;
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
            (p) => `<div class="row" title="${esc(p.card.id)}">
              <span class="dot ${p.status}">${GLYPH[p.status]}</span>
              <span class="name">${esc(p.card.name)}</span>
              ${p.card.role ? `<span class="role">${esc(p.card.role)}</span>` : ""}
              ${p.activity ? `<span class="activity">${esc(p.activity)}</span>` : ""}
            </div>`,
          )
          .join("");
  const online = roster.filter((p) => p.status !== "offline").length;
  $("space").textContent = `· ${online} online`;
}

// Channels are hierarchical (dotted) — indent by depth, label is the last segment,
// total dimmed, unread shown as an accent pill.
function renderChannels() {
  const names = [...channels.keys()].sort();
  const item = (key, label, depth, count, isAll) => {
    const sel = selected === key ? " sel" : "";
    const u = unread.get(key) ?? 0;
    return `<div class="row chan${sel}" data-ch="${esc(key)}" style="padding-left:${14 + depth * 14}px">
      <span class="name">${isAll ? "✸ " : "#"}${esc(label)}</span>
      ${u ? `<span class="pill">${u}</span>` : count != null ? `<span class="count">${count}</span>` : ""}
    </div>`;
  };
  $("channels").innerHTML =
    item("*", "all activity", 0, null, true) +
    (names.length
      ? names
          .map((n) => {
            const segs = n.split(".");
            return item(n, segs[segs.length - 1], segs.length - 1, channels.get(n));
          })
          .join("")
      : `<div class="empty">no channels yet</div>`);
  for (const el of $("channels").querySelectorAll(".chan"))
    el.onclick = () => select(el.dataset.ch);
}

// "What needs me" — agents blocked/waiting, with what they're waiting on.
function renderAttention() {
  const waiting = roster.filter((p) => p.status === "waiting");
  $("attn-count").textContent = waiting.length || "";
  $("attention").innerHTML = waiting.length
    ? waiting
        .map(
          (p) => `<div class="card" title="${esc(p.card.id)}">
            <div class="who">${esc(p.card.name)}${p.card.role ? `<span class="role"> ${esc(p.card.role)}</span>` : ""}</div>
            <div class="why">${esc(p.activity || "waiting — no detail")}</div>
          </div>`,
        )
        .join("")
    : `<div class="empty calm">nothing waiting — all clear ✓</div>`;
}

function msgRow(entry) {
  const { mode, msg } = entry;
  const who = `${esc(msg.from?.name ?? "?")}${msg.from?.role ? `<span class="role">/${esc(msg.from.role)}</span>` : ""}`;
  const target =
    mode === "chat"
      ? `#${esc(msg.channel ?? "")}`
      : mode === "unicast"
        ? `→ ${esc(msg.to ?? "")}`
        : `→ @${esc(msg.toService ?? "")}`;
  const badge = `<span class="badge ${mode}">${mode}</span>`;
  return `<div class="msg"><span class="ts">${time(msg.ts)}</span> ${badge}<span class="who">${who}</span> <span class="role">${target}</span>: ${esc(bodyText(msg))}</div>`;
}

function matches(entry) {
  if (!filter) return true;
  const { msg } = entry;
  return (
    bodyText(msg).toLowerCase().includes(filter) ||
    (msg.from?.name ?? "").toLowerCase().includes(filter) ||
    (msg.channel ?? msg.to ?? msg.toService ?? "").toLowerCase().includes(filter)
  );
}

function renderFeed() {
  const feed = $("feed");
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const rows =
    selected === "*"
      ? activity.filter(matches)
      : channelMsgs.map((msg) => ({ mode: "chat", msg })).filter(matches);
  if (selected === "*") {
    $("feed-title").textContent = "All activity";
    $("feed-sub").textContent = `${rows.length}${filter ? " matched" : " recent"}`;
  } else {
    $("feed-title").textContent = `#${selected}`;
    $("feed-sub").textContent = `${rows.length} message${rows.length === 1 ? "" : "s"}`;
  }
  feed.innerHTML = rows.length
    ? rows.map(msgRow).join("")
    : `<div class="empty">${filter ? "no matches" : selected === "*" ? "waiting for messages…" : "no messages"}</div>`;
  if (atBottom && !paused) feed.scrollTop = feed.scrollHeight;
}

async function select(key) {
  selected = key;
  unread.set(key, 0);
  renderChannels();
  if (key !== "*") {
    channelMsgs = [];
    renderFeed();
    channelMsgs = await (await fetch(`/api/channels/${encodeURIComponent(key)}/history?limit=200`)).json();
  }
  renderFeed();
}

async function refresh() {
  roster = await (await fetch("/api/roster")).json();
  renderRoster();
  renderSignals();
  renderAttention();
  const list = await (await fetch("/api/channels")).json();
  channels = new Map(list.map((c) => [c.channel, c.messages]));
  renderChannels();
  renderSignals();
  if (selected !== "*") select(selected);
}

function onMessage(entry) {
  const { msg } = entry;
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
    renderSignals();
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
    renderRoster();
    renderSignals();
    renderAttention();
  });
  es.addEventListener("message", (e) => onMessage(JSON.parse(e.data)));
  es.addEventListener("error", () => setConn(false));
}

$("filter").addEventListener("input", (e) => {
  filter = e.target.value.trim().toLowerCase();
  renderFeed();
});
$("pause").addEventListener("click", () => {
  paused = !paused;
  $("pause").classList.toggle("on", paused);
  $("pause").textContent = paused ? "paused" : "pause";
  if (!paused) renderFeed();
});

refresh();
connect();
