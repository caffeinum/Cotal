// Swarl observability client: a read-only view of one space. Presence + channel
// list come over HTTP; the live message stream and roster updates arrive via SSE
// (/feed). Everything is observation — this page never publishes to the mesh.

const $ = (id) => document.getElementById(id);
const STATUS = ["working", "waiting", "idle", "offline"];

let roster = [];
let channels = new Map(); // name -> count
let selected = "*"; // "*" = all activity, else a channel name
let activity = []; // {mode, msg} ring buffer for the all-activity view
let channelMsgs = []; // messages for the selected channel

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

function renderRoster() {
  const online = roster.filter((p) => p.status !== "offline");
  const sorted = [...roster].sort(
    (a, b) => STATUS.indexOf(a.status) - STATUS.indexOf(b.status) || a.card.name.localeCompare(b.card.name),
  );
  $("roster").innerHTML =
    roster.length === 0
      ? `<div class="empty">no peers</div>`
      : sorted
          .map(
            (p) => `<div class="row" title="${esc(p.card.id)}">
              <span class="dot ${p.status}">●</span>
              <span class="name">${esc(p.card.name)}</span>
              ${p.card.role ? `<span class="role">${esc(p.card.role)}</span>` : ""}
              ${p.activity ? `<span class="activity">${esc(p.activity)}</span>` : ""}
            </div>`,
          )
          .join("");
  $("space").textContent = `· ${onlineLabel(online.length)}`;
}

function onlineLabel(n) {
  return `${n} online`;
}

function renderChannels() {
  const names = [...channels.keys()].sort();
  const item = (key, label, count, isAll) => {
    const sel = selected === key ? " sel" : "";
    return `<div class="row chan${sel}" data-ch="${esc(key)}">
      <span class="name">${isAll ? "✸ " : "#"}${esc(label)}</span>
      ${count != null ? `<span class="count">${count}</span>` : ""}
    </div>`;
  };
  $("channels").innerHTML =
    item("*", "all activity", null, true) +
    (names.length
      ? names.map((n) => item(n, n, channels.get(n))).join("")
      : `<div class="empty">no channels yet</div>`);
  for (const el of $("channels").querySelectorAll(".chan"))
    el.onclick = () => select(el.dataset.ch);
}

function msgRow(entry) {
  const { mode, msg } = entry;
  const who = `${esc(msg.from?.name ?? "?")}${msg.from?.role ? `<span class="role">/${esc(msg.from.role)}</span>` : ""}`;
  const target =
    mode === "chat" ? `#${esc(msg.channel ?? "")}` : mode === "unicast" ? `→ ${esc(msg.to ?? "")}` : `→ @${esc(msg.toService ?? "")}`;
  const badge = `<span class="badge ${mode}">${mode}</span>`;
  return `<div class="msg"><span class="ts">${time(msg.ts)}</span> ${badge}<span class="who">${who}</span> <span class="role">${target}</span>: ${esc(bodyText(msg))}</div>`;
}

function renderFeed() {
  const feed = $("feed");
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  if (selected === "*") {
    $("feed-head").innerHTML = `All activity<span class="sub" id="feed-sub">${activity.length} recent</span>`;
    feed.innerHTML = activity.length
      ? activity.map(msgRow).join("")
      : `<div class="empty">waiting for messages…</div>`;
  } else {
    $("feed-head").innerHTML = `#${esc(selected)}<span class="sub">${channelMsgs.length} messages</span>`;
    feed.innerHTML = channelMsgs.length
      ? channelMsgs.map((msg) => msgRow({ mode: "chat", msg })).join("")
      : `<div class="empty">no messages</div>`;
  }
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

async function select(key) {
  selected = key;
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
  const list = await (await fetch("/api/channels")).json();
  channels = new Map(list.map((c) => [c.channel, c.messages]));
  renderChannels();
  if (selected !== "*") select(selected);
}

function onMessage(entry) {
  const { msg } = entry;
  activity.push(entry);
  if (activity.length > 500) activity.shift();
  if (msg.channel) {
    channels.set(msg.channel, (channels.get(msg.channel) ?? 0) + 1);
    renderChannels();
    if (selected === msg.channel) {
      channelMsgs.push(msg);
      if (channelMsgs.length > 500) channelMsgs.shift();
    }
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
  });
  es.addEventListener("message", (e) => onMessage(JSON.parse(e.data)));
  es.addEventListener("error", () => setConn(false));
}

refresh();
connect();
