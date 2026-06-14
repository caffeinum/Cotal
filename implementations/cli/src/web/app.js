// Cotal observability client: a read-only god-view of one space. Presence + channel
// list + DM history come over HTTP; the live stream (roster + every chat/unicast/anycast
// message) arrives via SSE (/feed). This page never publishes to the mesh.
//
// Three centre views, one consistent skeleton (left = navigation, centre = content,
// right = NEEDS YOU, always): the Monitor (all-activity feed), a Channel view (message
// list; members fold into the header), and a Direct-messages lens (per-peer roll-up in
// the sidebar → a thread in the centre). `?demo` renders the fixed reference scene.

const $ = (id) => document.getElementById(id);
const STATUS = ["working", "waiting", "idle", "offline"];
// Status as shape *and* colour (never colour alone) — see research/multi-agent-ux.md.
const GLYPH = { working: "●", waiting: "◐", idle: "○", offline: "⊘" };
const MODES = ["chat", "unicast", "anycast"];
const isDemo = new URLSearchParams(location.search).has("demo");

let roster = [];
let channels = new Map(); // name -> total message count
let unread = new Map(); // name -> messages seen since last viewed
let dms = []; // raw DM messages (god-view), grouped client-side
let selected = "*"; // "*" = all activity, else a channel name (null when a DM is open)
let dmSel = null; // { peer, with } when a Direct-messages thread is open
let agentSel = null; // peer id when an Agent Detail drill-down is open (else selected/dmSel drive the view)
let activity = []; // {mode, msg} ring buffer for the all-activity view
let channelMsgs = []; // messages for the selected channel
let modes = new Set(MODES); // delivery modes currently shown
let paused = false; // freeze auto-scroll so a value can be read

const esc = (s) =>
  String(s).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const bodyText = (msg) =>
  (msg.parts || []).map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ");
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const agoShort = (ts) => (ago(ts) === "just now" ? "now" : ago(ts));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function setConn(live) {
  const el = $("conn");
  el.className = "pill" + (live ? "" : " down");
  el.querySelector(".t").textContent = live ? "live" : "disconnected";
}

// ── Header: golden-signal tiles ───────────────────────────────────────────────
function renderTiles(counts, oldest) {
  const tiles = [
    ["working", counts.working],
    ["waiting", counts.waiting],
    ["idle", counts.idle],
    ["offline", counts.offline],
    ["oldest", oldest, "oldest unattended"],
  ];
  $("tiles").innerHTML = tiles
    .map(
      ([k, n, lbl]) => `<div class="tile ${k}">
        <span class="bar"></span>
        <div class="c"><span class="n">${n}</span><span class="lbl">${lbl ?? k}</span></div>
      </div>`,
    )
    .join("");
}

// ── Sidebar: roster ───────────────────────────────────────────────────────────
function peerRow(p) {
  return `<div class="peer ${p.status}">
    <span class="dot ${p.status}">${GLYPH[p.status] ?? "○"}</span>
    <div class="c">
      <div class="l1">
        <span class="name">${esc(p.name)}</span>
        ${p.role ? `<span class="role">${esc(p.role)}</span>` : ""}
        ${p.tag ? `<span class="tag">${esc(p.tag)}</span>` : ""}
      </div>
      ${p.act ? `<div class="act" title="${esc(p.act)}">${esc(p.act)}</div>` : ""}
    </div>
  </div>`;
}
function renderRoster(list) {
  $("roster").innerHTML = list.length
    ? list.map(peerRow).join("")
    : `<div class="empty">no peers</div>`;
}

// ── Sidebar: channels ─────────────────────────────────────────────────────────
function chanRow(ch) {
  const sel = !dmSel && ch.key === selected;
  const lead = ch.all ? `<span class="glyph">✸</span>` : `<span class="hash">#</span>`;
  return `<div class="chan${sel ? " sel" : ""}${ch.muted ? " muted" : ""}" data-ch="${esc(ch.key)}">
    <span class="l">${lead}<span class="name">${esc(ch.label)}</span></span>
    ${ch.mention ? `<span class="mention">${ch.mention}</span>` : ""}
    <span class="count">${ch.count}</span>
  </div>`;
}
function renderChannels() {
  const names = [...channels.keys()]; // insertion order (curated in demo, server order live)
  const total = [...channels.values()].reduce((a, b) => a + b, 0);
  const rows = [{ key: "*", all: true, label: "all activity", count: total }].concat(
    names.map((n) => ({
      key: n,
      label: n,
      count: channels.get(n),
      mention: unread.get(n) || 0,
      muted: channels.get(n) === 0,
    })),
  );
  $("channels").innerHTML = rows.map(chanRow).join("");
  for (const el of $("channels").querySelectorAll(".chan")) el.onclick = () => select(el.dataset.ch);
}

// ── Sidebar: direct messages (per-peer roll-up → drill) ───────────────────────
const SEP = "";
function roleOf(name) {
  const r = roster.find((x) => x.card?.name === name);
  return r?.card?.role;
}
function rosterStatus(name) {
  const r = roster.find((x) => x.card?.name === name);
  return r ? r.status : "offline";
}
// Group raw DMs into per-peer rows; each peer lists its counterparties (conversations).
// O(peers-with-DMs), never the n² pair cross-product — only pairs that actually talked.
function dmPeers() {
  if (isDemo) return DEMO.dmPeers;
  // `from` is a full card (has a name); `to` is the recipient's identity id. Build an
  // id→name map from cards we've seen so recipients show a name, not a pubkey.
  const idName = new Map();
  for (const p of roster) if (p.card?.id) idName.set(p.card.id, p.card.name);
  for (const m of dms) if (m.from?.id && m.from?.name) idName.set(m.from.id, m.from.name);
  const nameOf = (x) => {
    if (!x) return "?";
    if (typeof x === "object") return x.name || nameOf(x.id);
    if (idName.has(x)) return idName.get(x);
    return /^[A-Z2-7]{32,}$/.test(x) ? x.slice(0, 6) + "…" : x; // unknown identity → short id
  };
  const conv = new Map();
  for (const m of dms) {
    const a = nameOf(m.from),
      b = nameOf(m.to);
    if (a === "?" || b === "?" || a === b) continue;
    const key = [a, b].sort().join(SEP);
    if (!conv.has(key)) conv.set(key, { parts: [a, b].sort(), msgs: [] });
    conv.get(key).msgs.push({ ts: time(m.ts), who: a, status: rosterStatus(a), body: bodyText(m), _ts: m.ts });
  }
  const peers = new Map();
  for (const c of conv.values()) {
    c.msgs.sort((x, y) => x._ts - y._ts);
    const last = c.msgs.length ? c.msgs[c.msgs.length - 1]._ts : 0;
    for (const p of c.parts) {
      const other = c.parts[0] === p ? c.parts[1] : c.parts[0];
      if (!peers.has(p)) peers.set(p, { name: p, conversations: [], last: 0 });
      const pe = peers.get(p);
      pe.conversations.push({ with: other, role: roleOf(other), status: rosterStatus(other), unread: 0, last, msgs: c.msgs });
      pe.last = Math.max(pe.last, last);
    }
  }
  return [...peers.values()]
    .map((p) => ({
      name: p.name,
      role: roleOf(p.name),
      status: rosterStatus(p.name),
      unread: 0,
      threads: p.conversations.length,
      conversations: p.conversations.sort((a, b) => b.last - a.last),
      last: p.last,
    }))
    .sort((a, b) => b.last - a.last);
}
function dmPeerRow(p, expanded) {
  return `<div class="dm${expanded ? " sel" : ""}" data-dm="${esc(p.name)}">
    <span class="caret">${expanded ? "▾" : "▸"}</span>
    <span class="l">
      <span class="dot ${p.status}">${GLYPH[p.status] ?? "○"}</span>
      <span class="nm">${esc(p.name)}</span>
      ${p.role ? `<span class="role">${esc(p.role)}</span>` : ""}
    </span>
    ${p.unread ? `<span class="mention">${p.unread}</span>` : ""}
    ${expanded ? "" : `<span class="threads">${plural(p.threads, "thread")}</span>`}
  </div>`;
}
function dmSubRow(peer, c) {
  const sel = dmSel && dmSel.peer === peer && dmSel.with === c.with;
  return `<div class="dm sub${sel ? " sel" : ""}" data-dm="${esc(peer)}${SEP}${esc(c.with)}">
    <span class="ln">↳</span>
    <span class="l">
      <span class="dot ${c.status}">${GLYPH[c.status] ?? "○"}</span>
      <span class="nm">${esc(c.with)}</span>
      ${c.role ? `<span class="role">${esc(c.role)}</span>` : ""}
    </span>
    ${c.unread ? `<span class="mention">${c.unread}</span>` : ""}
  </div>`;
}
function renderDMs() {
  const peers = dmPeers();
  if (!peers.length) {
    $("dms").innerHTML = `<div class="empty">no direct messages</div>`;
    return;
  }
  let html = "";
  for (const p of peers) {
    const expanded = !!dmSel && dmSel.peer === p.name;
    html += dmPeerRow(p, expanded);
    if (expanded) for (const c of p.conversations) html += dmSubRow(p.name, c);
  }
  $("dms").innerHTML = html;
  for (const el of $("dms").querySelectorAll("[data-dm]")) {
    el.onclick = () => {
      const [peer, w] = el.dataset.dm.split(SEP);
      selectDM(peer, w || null);
    };
  }
}
function renderSidebarNav() {
  renderChannels();
  renderDMs();
}

// ── Feed rows (all-activity) ──────────────────────────────────────────────────
function rowHTML(e) {
  if (e.type === "sys") return `<div class="sys">${esc(e.text)}</div>`;
  if (e.type === "rollup")
    return `<div class="rollup"><span class="ar">⌄</span><span class="t">${esc(e.text)}</span></div>`;
  const intent = e.type === "intent";
  const badgeClass = intent ? "intent" : e.mode;
  const badgeText = intent ? "⟶ intent" : e.mode;
  const tgt = intent ? e.note : e.target;
  return `<div class="msg${intent ? " intent" : ""}">
    <span class="ts">${esc(e.ts)}</span>
    <span class="badge ${badgeClass}">${esc(badgeText)}</span>
    <div class="c">
      <div class="l1">
        <span class="who">${esc(e.who)}</span>
        ${e.role ? `<span class="role">${esc(e.role)}</span>` : ""}
        ${tgt ? `<span class="tgt">${esc(tgt)}</span>` : ""}
        ${e.sub ? `<span class="subpill">${esc(e.sub)}</span>` : ""}
      </div>
      <div class="body">${esc(e.body)}</div>
    </div>
  </div>`;
}
function liveEntry(mode, msg) {
  const target =
    mode === "chat"
      ? `#${msg.channel ?? ""}`
      : mode === "unicast"
        ? `→ ${msg.to ?? ""}`
        : `→ @${msg.toService ?? ""}`;
  return {
    type: "msg",
    mode,
    ts: time(msg.ts),
    who: msg.from?.name ?? "?",
    role: msg.from?.role,
    target,
    body: bodyText(msg),
  };
}

function renderAllActivity() {
  const center = $("center");
  const prev = center.querySelector(".feed");
  const atBottom = prev ? prev.scrollHeight - prev.scrollTop - prev.clientHeight < 40 : true;
  const rows = (isDemo ? DEMO.activity : activity.map((e) => liveEntry(e.mode, e.msg))).filter(
    (e) => !e.mode || modes.has(e.mode),
  );
  const sub = isDemo ? "112 recent · live" : `${rows.length} recent · live`;
  center.innerHTML = `
    <div class="feed-head">
      <span class="h">✸ All activity</span>
      <span class="sub">${esc(sub)}</span>
      <span class="ctrls">
        ${MODES.map((m) => `<span class="chip mode${modes.has(m) ? " on" : ""}" data-mode="${m}">${m}</span>`).join("")}
        <span class="chip pause${paused ? " on" : ""}" id="pause">${paused ? "▶ resume" : "⏸ pause"}</span>
        <span class="chip static">muted · 2</span>
      </span>
    </div>
    <div class="feed">${rows.length ? rows.map(rowHTML).join("") : `<div class="empty">waiting for messages…</div>`}</div>`;
  for (const chip of center.querySelectorAll(".chip[data-mode]"))
    chip.onclick = () => {
      const m = chip.dataset.mode;
      modes.has(m) ? modes.delete(m) : modes.add(m);
      renderAllActivity();
    };
  const pause = center.querySelector("#pause");
  if (pause) pause.onclick = () => ((paused = !paused), renderAllActivity());
  const feed = center.querySelector(".feed");
  if (atBottom && !paused) feed.scrollTop = feed.scrollHeight;
}

// ── Channel view (centre; members fold into the header) ───────────────────────
function cmsgHTML(m) {
  if (m.type === "unread")
    return `<div class="unread-mark"><span class="line"></span><span class="t">${esc(m.text)}</span><span class="line"></span></div>`;
  return `<div class="cmsg">
    <span class="ts">${esc(m.ts)}</span>
    <span class="dot ${m.status}">${GLYPH[m.status] ?? "●"}</span>
    <div class="c">
      <div class="l1"><span class="who">${esc(m.who)}</span>${m.role ? `<span class="role">${esc(m.role)}</span>` : ""}</div>
      <div class="body">${esc(m.body)}</div>
      ${m.thread ? `<span class="thread">${esc(m.thread)}</span>` : ""}
    </div>
  </div>`;
}
function channelMembers(msgs) {
  const seen = new Map();
  for (const msg of msgs) {
    const n = msg.from?.name;
    if (!n || seen.has(n)) continue;
    seen.set(n, { name: n, role: msg.from?.role, status: rosterStatus(n) });
  }
  return [...seen.values()];
}
function renderChannel() {
  const name = selected;
  let items, memberCount, msgCount, desc;
  if (isDemo) {
    items = DEMO.cv.messages;
    memberCount = DEMO.cv.members.length;
    msgCount = channels.get(name) ?? 51;
    desc = name === "team.backend" ? "Backend coordination — channels, endpoint, NATS.  ·  " : "";
  } else {
    items = channelMsgs.map((msg) => ({
      ts: time(msg.ts),
      status: rosterStatus(msg.from?.name),
      who: msg.from?.name ?? "?",
      role: msg.from?.role,
      body: bodyText(msg),
    }));
    memberCount = channelMembers(channelMsgs).length;
    msgCount = channels.get(name) ?? items.length;
    desc = "";
  }
  const sub = name.includes(".") ? `subtree of ${name.split(".")[0]}.>` : "";
  $("center").innerHTML = `
    <div class="ch-head">
      <div class="row">
        <div class="title"><span class="h"># ${esc(name)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div>
        <div class="ctrls">
          <span class="chip mode on">👥 ${plural(memberCount, "member")}</span>
          <span class="chip mode on">✦ summarize</span>
          <span class="chip static">🔕 mute</span>
          ${isDemo ? "" : `<span class="chip danger" id="ch-del" title="Delete this channel and all its messages">🗑 delete</span>`}
        </div>
      </div>
      <div class="purpose">${esc(desc)}${plural(memberCount, "member")}  ·  ${plural(msgCount, "message")}</div>
    </div>
    <div class="clist">${items.length ? items.map(cmsgHTML).join("") : `<div class="empty">no messages</div>`}</div>`;
  const list = $("center").querySelector(".clist");
  list.scrollTop = list.scrollHeight;
  const del = $("center").querySelector("#ch-del");
  if (del) del.onclick = () => deleteChannel(name);
}

// Delete the channel and its content (steward action). Confirm first — purging the chat
// stream is irreversible. On success the channel drops from the sidebar and the view falls
// back to all-activity; a stray live message would recreate it (deletion clears, not bans).
async function deleteChannel(name) {
  if (!name || name === "*") return;
  if (!confirm(`Delete #${name} and all its messages?\n\nThis purges the channel's history and cannot be undone.`)) return;
  try {
    const r = await fetch("/api/channel/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: name }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    channels.delete(name);
    unread.delete(name);
    activity = activity.filter((e) => e.msg.channel !== name); // drop its rows from all-activity
    select("*");
  } catch (e) {
    alert(`Couldn't delete #${name}: ${e.message}`);
  }
}

// ── Direct-messages thread (centre) ───────────────────────────────────────────
function dmMsgHTML(m, peer, withName) {
  const to = m.who === peer ? withName : peer;
  return `<div class="cmsg">
    <span class="ts">${esc(m.ts)}</span>
    <span class="dot ${m.status}">${GLYPH[m.status] ?? "●"}</span>
    <div class="c">
      <div class="l1"><span class="who">${esc(m.who)}</span><span class="dir">→ ${esc(to)}</span></div>
      <div class="body">${esc(m.body)}</div>
    </div>
  </div>`;
}
function renderDMThread() {
  const peer = dmSel.peer;
  const pe = dmPeers().find((p) => p.name === peer);
  const conv = pe && (pe.conversations.find((c) => c.with === dmSel.with) || pe.conversations[0]);
  const withName = conv ? conv.with : dmSel.with;
  const msgs = conv ? conv.msgs : []; // display-ready (ts, who, status, body) for demo + live
  $("center").innerHTML = `
    <div class="ch-head">
      <div class="row">
        <div class="title"><span class="h">${esc(peer)} ↔ ${esc(withName)}</span><span class="dtag">direct</span></div>
        <div class="ctrls"><span class="chip static">🔕 mute</span></div>
      </div>
      <div class="purpose">unicast · private to the two of them  ·  ${plural(msgs.length, "message")}</div>
    </div>
    <div class="clist">${msgs.length ? msgs.map((m) => dmMsgHTML(m, peer, withName)).join("") : `<div class="empty">no messages</div>`}</div>`;
  const list = $("center").querySelector(".clist");
  list.scrollTop = list.scrollHeight;
}

// ── NEEDS YOU rail (always on the right) ──────────────────────────────────────
function cardHTML(c) {
  const nav = c.id ? ` nav${c.id === agentSel ? " sel" : ""}` : "";
  return `<div class="card tone-${c.tone}${nav}"${c.id ? ` data-agent="${esc(c.id)}"` : ""}>
    <div class="top">
      <div class="cat-l"><span class="cdot"></span><span class="cat">${esc(c.cat)}</span></div>
      <span class="age">${esc(c.age)}</span>
    </div>
    <div class="title">${esc(c.title)}${c.role ? `<span class="crole">${esc(c.role)}</span>` : ""}</div>
    <div class="desc">${esc(c.desc)}</div>
    ${c.primary ? `<div class="btns"><span class="btn primary">${esc(c.primary)}</span>${c.secondary ? `<span class="btn secondary">${esc(c.secondary)}</span>` : ""}</div>` : ""}
  </div>`;
}
function waitingCards() {
  return roster
    .filter((p) => p.status === "waiting")
    .sort((a, b) => b.ts - a.ts)
    .map((p) => ({
      tone: "amber",
      cat: "WAITING",
      age: ago(p.ts),
      title: `${p.card.name} is waiting`,
      role: p.card.role,
      // p.activity is the Claude Code Notification text (the actual blocking prompt/permission).
      desc: p.activity || "waiting for input",
      id: p.card.id, // makes the card a clickable drill-down into the Agent Detail view
    }));
}
function renderRail() {
  const cards = isDemo ? DEMO.cards : waitingCards();
  $("rail").className = "rail";
  $("rail").innerHTML =
    `<div class="rail-head"><span class="t">NEEDS YOU</span>${cards.length ? `<span class="n">${cards.length}</span>` : ""}</div>` +
    (cards.length
      ? cards.map(cardHTML).join("") +
        `<div class="rail-foot">Everything else stays quiet in the feed.</div>`
      : `<div class="empty">nothing waiting — all clear ✓</div>`);
  for (const el of $("rail").querySelectorAll(".card[data-agent]"))
    el.onclick = () => selectAgent(el.dataset.agent);
}

// ── Agent Detail drill-down (centre) — the forward-looking per-agent frame (docs/web.md) ──
function selectAgent(id) {
  agentSel = id;
  dmSel = null;
  selected = null;
  renderSidebarNav();
  renderCenter();
  renderRail();
}
function renderAgentDetail() {
  const p = roster.find((x) => x.card.id === agentSel);
  if (!p) {
    $("center").innerHTML = `<div class="detail"><div class="empty">agent no longer present — pick another from NEEDS YOU.</div></div>`;
    return;
  }
  const waiting = p.status === "waiting";
  const who = p.card.role ? `${esc(p.card.name)}<span class="crole">${esc(p.card.role)}</span>` : esc(p.card.name);
  const since = waiting ? `waiting ${esc(ago(p.ts))}` : `${esc(p.status)} · ${esc(ago(p.ts))}`;
  const blocked = waiting
    ? `<div class="d-label">Blocked on</div><div class="d-block">${esc(p.activity || "waiting for input")}</div>`
    : `<div class="d-block muted">${esc(p.activity || "no current activity")}</div>`;
  $("center").innerHTML = `
    <div class="detail${waiting ? " amber" : ""}">
      <div class="d-head">
        <span class="dot ${p.status}">${GLYPH[p.status] ?? "●"}</span>
        <span class="d-status">${esc(waiting ? "WAITING" : p.status)}</span>
        <span class="d-age">${since}</span>
      </div>
      <div class="d-who">${who}</div>
      <div class="d-id">${esc(p.card.id.slice(0, 8))}…</div>
      ${blocked}
    </div>`;
}

// ── View dispatch ─────────────────────────────────────────────────────────────
function renderCenter() {
  if (agentSel) return renderAgentDetail();
  if (dmSel) return renderDMThread();
  if (selected === "*") return renderAllActivity();
  return renderChannel();
}

function refreshDerived() {
  const counts = { working: 0, waiting: 0, idle: 0, offline: 0 };
  for (const p of roster) counts[p.status] = (counts[p.status] ?? 0) + 1;
  const waiting = roster.filter((p) => p.status === "waiting");
  const oldest = waiting.length ? agoShort(Math.min(...waiting.map((p) => p.ts))) : "—";
  renderTiles(counts, oldest);
  $("online-c").textContent = roster.filter((p) => p.status !== "offline").length;
  // The roster sidebar is the ONLINE list — offline peers drop out (their count still rides
  // in the header tiles). They reappear here the moment presence flips them back on.
  renderRoster(
    [...roster]
      .filter((p) => p.status !== "offline")
      .sort(
        (a, b) =>
          STATUS.indexOf(a.status) - STATUS.indexOf(b.status) ||
          a.card.name.localeCompare(b.card.name),
      )
      .map((p) => ({
        name: p.card.name,
        role: p.card.role,
        status: p.status,
        act: p.activity,
        tag: p.status === "waiting" ? "needs input" : null,
      })),
  );
  renderDMs(); // peer statuses may have changed
  renderRail();
  if (agentSel) renderCenter(); // keep an open Agent Detail live as the peer's status/activity changes
}

let loadSeq = 0;
async function select(key) {
  agentSel = null;
  dmSel = null;
  selected = key;
  if (key !== "*") unread.set(key, 0);
  renderSidebarNav();
  if (isDemo) return (renderCenter(), renderRail());
  if (key !== "*") {
    const seq = ++loadSeq;
    channelMsgs = [];
    renderCenter();
    const msgs = await (await fetch(`/api/channels/${encodeURIComponent(key)}/history?limit=200`)).json();
    if (seq !== loadSeq) return;
    channelMsgs = msgs;
  }
  renderCenter();
  renderRail();
}
function selectDM(peer, w) {
  agentSel = null;
  const pe = dmPeers().find((p) => p.name === peer);
  dmSel = { peer, with: w || (pe && pe.conversations[0] ? pe.conversations[0].with : null) };
  selected = null;
  renderSidebarNav();
  renderCenter();
  renderRail();
}

async function refresh() {
  roster = await (await fetch("/api/roster")).json();
  refreshDerived();
  const list = await (await fetch("/api/channels")).json();
  channels = new Map(list.map((c) => [c.channel, c.messages]));
  dms = await (await fetch("/api/dms?limit=500")).json();
  renderSidebarNav();
  if (agentSel) {
    renderCenter();
  } else if (dmSel) {
    renderCenter();
  } else if (selected !== "*") {
    select(selected);
  } else {
    activity = await (await fetch("/api/activity?limit=200")).json();
    renderCenter();
  }
}

function onMessage(entry) {
  const { mode, msg } = entry;
  if (!activity.some((e) => e.msg.id === msg.id)) {
    activity.push(entry);
    if (activity.length > 500) activity.shift();
  }
  if (mode === "unicast" && !dms.some((m) => m.id === msg.id)) {
    dms.push(msg);
    renderDMs();
  }
  if (msg.channel) {
    channels.set(msg.channel, (channels.get(msg.channel) ?? 0) + 1);
    if (!dmSel && selected === msg.channel) {
      channelMsgs.push(msg);
      if (channelMsgs.length > 500) channelMsgs.shift();
    } else {
      unread.set(msg.channel, (unread.get(msg.channel) ?? 0) + 1);
    }
    renderChannels();
  }
  if (dmSel ? mode === "unicast" : selected === "*" || selected === msg.channel) renderCenter();
}

function connect() {
  const es = new EventSource("/feed");
  es.addEventListener("open", () => {
    setConn(true);
    refresh();
  });
  es.addEventListener("roster", (e) => {
    roster = JSON.parse(e.data);
    refreshDerived();
  });
  es.addEventListener("message", (e) => onMessage(JSON.parse(e.data)));
  es.addEventListener("error", () => setConn(false));
}

// ── Demo scene (the Penpot reference frames) ──────────────────────────────────
const ab = [
  { ts: "10:47", who: "alice", status: "waiting", body: "can you take the API-key wiring while I'm blocked?" },
  { ts: "10:48", who: "bob", status: "working", body: "on it — grabbing the OPENAI_API_KEY wiring now" },
  { ts: "10:50", who: "alice", status: "waiting", body: "🙏 thanks — I'll keep drafting the auth outline" },
];
const ad = [
  { ts: "10:42", who: "dave", status: "working", body: "want me to stub the key so you can keep planning?" },
  { ts: "10:43", who: "alice", status: "waiting", body: "yes please — a no-op stub is perfect for now" },
];
const as = [{ ts: "10:40", who: "scout", status: "idle", body: "logged your block in #incidents" }];
const bd = [
  { ts: "10:09", who: "bob", status: "working", body: "merged your filter-subjects change" },
  { ts: "10:10", who: "dave", status: "working", body: "ty — running the suite now" },
];
const lm = [{ ts: "10:15", who: "maya", status: "idle", body: "sent the NATS v3 notes your way" }];
const DEMO = {
  roster: [
    { name: "alice", role: "planner", status: "waiting", tag: "needs input", act: "blocked — needs OPENAI_API_KEY" },
    { name: "linus", role: "reviewer", status: "working", act: "reviewing PR #42 · auth guards" },
    { name: "bob", role: "builder", status: "working", act: "writing tests · channels.ts" },
    { name: "dave", role: "builder", status: "working", act: "refactoring endpoint.ts" },
    { name: "maya", role: "researcher", status: "idle", act: "—" },
    { name: "scout", role: "observer", status: "idle", act: "watching #team.>" },
  ],
  activity: [
    { type: "sys", text: "— scout joined · observer —" },
    { type: "msg", mode: "chat", ts: "10:38", who: "dave", role: "builder", target: "#general", body: "anyone else hit the flaky CI test on channels.ts?" },
    { type: "rollup", text: "14 status updates · bob, dave, linus, maya" },
    { type: "msg", mode: "chat", ts: "10:41", who: "bob", role: "builder", target: "#team.backend", body: "pushed channels.ts tests — 12 green ✓" },
    { type: "intent", ts: "10:46", who: "linus", note: "about to act", body: "will merge PR #42 once the review check passes" },
    { type: "msg", mode: "unicast", ts: "10:47", who: "alice", role: "planner", target: "→ bob", body: "can you take the API-key wiring while I'm blocked?" },
    { type: "msg", mode: "anycast", ts: "10:49", who: "—", target: "→ @reviewer", sub: "unclaimed · 3m", body: "review needed on PR #51 (channels hierarchy)" },
    { type: "msg", mode: "chat", ts: "10:51", who: "linus", role: "reviewer", target: "#team.review", body: "left 2 comments on PR #42 — small nits" },
  ],
  cards: [
    { tone: "amber", cat: "WAITING", age: "4m", title: "alice is blocked", desc: "Needs OPENAI_API_KEY to keep planning the auth module.", primary: "Provide key", secondary: "Open thread" },
    { tone: "red", cat: "FAILED", age: "1m", title: "bob's task failed", desc: "2 tests failing in channels.ts after the refactor.", primary: "Inspect", secondary: "Retry" },
    { tone: "orange", cat: "UNCLAIMED", age: "3m", title: "Anycast request unhandled", desc: "@reviewer · review PR #51 — no peer has claimed it.", primary: "Assign…", secondary: "Claim" },
    { tone: "blue", cat: "APPROVAL", age: "just now", title: "dave requests approval", desc: "Wants to force-push to main — irreversible.", primary: "Approve", secondary: "Deny" },
  ],
  cv: {
    messages: [
      { ts: "09:58", status: "working", who: "bob", role: "builder", body: "scaffolded the hierarchical channel matcher — wildcard subtree works" },
      { ts: "10:05", status: "working", who: "dave", role: "builder", body: "endpoint.ts: collapsed the filter subjects, tests pass", thread: "💬 3 replies · last 2m" },
      { ts: "10:12", status: "idle", who: "maya", role: "researcher", body: "NATS v3 split transports cleanly — notes in #planning" },
      { type: "unread", text: "new since you were away · 4 messages" },
      { ts: "10:39", status: "working", who: "dave", role: "builder", body: "anyone seen the flaky CI test on channels.ts?" },
      { ts: "10:41", status: "working", who: "bob", role: "builder", body: "pushed channels.ts tests — 12 green ✓" },
      { ts: "10:44", status: "waiting", who: "alice", role: "planner", body: "drafted the auth outline; blocked on the API key though" },
    ],
    members: [
      { status: "working", name: "bob", role: "builder" },
      { status: "working", name: "dave", role: "builder" },
      { status: "waiting", name: "alice", role: "planner" },
      { status: "idle", name: "maya", role: "researcher" },
      { status: "idle", name: "scout", role: "observer" },
    ],
  },
  dmPeers: [
    { name: "alice", role: "planner", status: "waiting", unread: 2, threads: 3, conversations: [
      { with: "bob", role: "builder", status: "working", unread: 0, msgs: ab },
      { with: "dave", role: "builder", status: "working", unread: 1, msgs: ad },
      { with: "scout", role: "observer", status: "idle", unread: 1, msgs: as },
    ] },
    { name: "bob", role: "builder", status: "working", unread: 0, threads: 2, conversations: [
      { with: "alice", role: "planner", status: "waiting", unread: 0, msgs: ab },
      { with: "dave", role: "builder", status: "working", unread: 0, msgs: bd },
    ] },
    { name: "dave", role: "builder", status: "working", unread: 1, threads: 2, conversations: [
      { with: "alice", role: "planner", status: "waiting", unread: 1, msgs: ad },
      { with: "bob", role: "builder", status: "working", unread: 0, msgs: bd },
    ] },
    { name: "linus", role: "reviewer", status: "working", unread: 0, threads: 1, conversations: [
      { with: "maya", role: "researcher", status: "idle", unread: 0, msgs: lm },
    ] },
    { name: "maya", role: "researcher", status: "idle", unread: 0, threads: 1, conversations: [
      { with: "linus", role: "reviewer", status: "working", unread: 0, msgs: lm },
    ] },
  ],
};

function renderDemo() {
  $("space").textContent = "· demo";
  setConn(true);
  renderTiles({ working: 4, waiting: 1, idle: 2, offline: 1 }, "6m");
  $("online-c").textContent = "6";
  renderRoster(DEMO.roster);
  // Counts sum to 112 → the "all activity" total matches the reference.
  channels = new Map([
    ["general", 24],
    ["planning", 12],
    ["team.backend", 51],
    ["team.frontend", 18],
    ["team.review", 7],
    ["incidents", 0],
  ]);
  unread = new Map([["planning", 2], ["team.review", 1]]);
  renderSidebarNav();
  renderCenter();
  renderRail();
}

if (isDemo) {
  document.title = "Cotal · demo";
  renderDemo();
} else {
  fetch("/api/meta")
    .then((r) => r.json())
    .then((m) => {
      $("space").textContent = `· ${m.space}`;
      document.title = `Cotal · ${m.space}`;
    });
  refresh();
  connect();
}
