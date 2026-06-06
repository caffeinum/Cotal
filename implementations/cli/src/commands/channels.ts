import { parseArgs } from "node:util";
import {
  SwarlEndpoint,
  isReachable,
  DEFAULT_SERVER,
  deliveryOf,
  type SwarlMessage,
} from "@swarl/core";
import { c } from "../ui.js";
import { agentColor } from "../render.js";

interface ChannelInfo {
  channel: string;
  messages: number;
  latest?: number;
}

function text(msg: SwarlMessage): string {
  return msg.parts.map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ");
}

async function fetchChannels(
  ep: SwarlEndpoint,
  space: string,
): Promise<ChannelInfo[]> {
  try {
    return await ep.listChannels();
  } catch {
    return [];
  }
}

async function fetchHistory(
  nc: SwarlEndpoint,
  space: string,
  channel: string,
  limit = 200,
): Promise<SwarlMessage[]> {
  try {
    const msgs = await nc.channelHistory(channel, { limit });
    return msgs;
  } catch {
    return [];
  }
}

export async function channels(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: "string" },
      server: { type: "string" },
      plain: { type: "boolean" },
    },
  });
  const space = values.space ?? "demo";
  const server = values.server ?? DEFAULT_SERVER;
  if (!(await isReachable(server))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: pnpm swarl up`));
    process.exit(1);
  }

  if (values.plain || process.stdout.isTTY !== true) {
    await runPlain(space, server);
  } else {
    try {
      await runTUI(space, server);
    } catch (e: any) {
      console.error(c.red("TUI error: " + e.message));
      console.error(e.stack);
      process.exit(1);
    }
  }
}

async function runPlain(space: string, server: string): Promise<void> {
  const ep = new SwarlEndpoint({
    space,
    servers: server,
    channels: [],
    registerPresence: false,
    watchPresence: false,
    consume: false,
    card: { name: "channels", kind: "endpoint" },
  });
  await ep.start();
  const chs = await fetchChannels(ep, space);
  if (!chs.length) {
    console.log(c.dim("No channels found in space " + space));
    await ep.stop();
    return;
  }
  console.log(c.bold(`Channels in ${space}:`));
  for (const ch of chs) {
    console.log(`  ${c.cyan("#" + ch.channel)}  ${c.dim(ch.messages + " msg" + (ch.messages !== 1 ? "s" : ""))}`);
  }
  await ep.stop();
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}
function padVis(s: string, width: number): string {
  const v = visLen(s);
  return v >= width ? s : s + " ".repeat(width - v);
}
function clipVis(s: string, width: number): string {
  if (width <= 0) return "";
  let len = 0;
  let out = "";
  let i = 0;
  while (i < s.length && len < width) {
    if (s[i] === "\x1b") {
      const j = s.indexOf("m", i);
      if (j === -1) break;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else {
      out += s[i];
      len++;
      i++;
    }
  }
  return out;
}

async function runTUI(space: string, server: string): Promise<void> {
  const ep = new SwarlEndpoint({
    space,
    servers: server,
    channels: [],
    registerPresence: false,
    watchPresence: false,
    consume: false,
    card: { name: "channels", kind: "endpoint" },
  });

  let channelList: ChannelInfo[] = [];
  let selectedIdx = 0;
  let history: SwarlMessage[] = [];
  let scroll = 0;
  let dirty = true;
  let scheduled = false;
  const mark = () => {
    dirty = true;
    if (!scheduled) {
      scheduled = true;
      setImmediate(() => { scheduled = false; render(); });
    }
  };

  const liveMessages: SwarlMessage[] = [];
  ep.on("error", (e: Error) => { process.stderr.write(c.red(`! ${e.message}\n`)); mark(); });

  await ep.start();

  ep.tap((subject, msg) => {
    if (!msg) return;
    if (deliveryOf(subject) === "chat") {
      liveMessages.push(msg);
      if (liveMessages.length > 500) liveMessages.shift();
      const ch = msg.channel;
      if (ch) {
        const entry = channelList.find((c) => c.channel === ch);
        if (entry) {
          entry.messages++;
          entry.latest = msg.ts;
        } else {
          channelList.push({ channel: ch, messages: 1, latest: msg.ts });
          channelList.sort((a, b) => a.channel.localeCompare(b.channel));
        }
        if (channelList[selectedIdx]?.channel === ch) {
          history.push(msg);
          if (history.length > 500) history.shift();
        }
        mark();
      }
    }
  });

  channelList = await fetchChannels(ep, space);
  if (channelList.length > 0) {
    fetchHistory(ep, space, channelList[0].channel).then((msgs) => {
      history = msgs;
      mark();
    });
  }
  mark();

  const refreshChannels = async () => {
    channelList = await fetchChannels(ep, space);
    if (selectedIdx >= channelList.length) selectedIdx = Math.max(0, channelList.length - 1);
    if (channelList.length > 0) {
      fetchHistory(ep, space, channelList[selectedIdx].channel).then((msgs) => {
        history = msgs;
        scroll = 0;
        mark();
      });
    } else {
      history = [];
    }
    mark();
  };

  const refreshTimer = setInterval(refreshChannels, 30000);

  let lastMaxScroll = 0;
  let lastRoom = 1;
  const SIDEBAR_W = 24;
  const out = process.stdout;

  out.write("\x1b[?1049h\x1b[?25l");

  const render = () => {
    if (!dirty) return;
    dirty = false;
    const cols = out.columns ?? 80;
    const rows = out.rows ?? 24;

    const header = `${c.bold("SWARL CHANNELS")} ${c.dim("· " + space)}`;
    const help = c.dim("↑↓ select · Enter open · r refresh · q quit");
    const lines: string[] = [
      header + " ".repeat(Math.max(0, cols - visLen(header) - visLen(help))) + help,
    ];

    const bodyRows = rows - 3;
    const feedCols = Math.max(20, cols - SIDEBAR_W - 3);

    const sidebar: string[] = [];
    const maxSidebarRows = bodyRows;
    const startIdx = Math.max(0, Math.min(selectedIdx - maxSidebarRows + 1, selectedIdx));

    for (let i = startIdx; i < Math.min(channelList.length, startIdx + maxSidebarRows); i++) {
      const ch = channelList[i];
      const sel = i === selectedIdx;
      const name = clipVis(ch.channel, SIDEBAR_W - 7);
      const count = String(ch.messages);
      const line = ` ${sel ? c.bold("▶") : " "} ${sel ? c.bold(c.cyan(name)) : c.cyan(name)}${" ".repeat(Math.max(0, SIDEBAR_W - 7 - visLen(name)))}${c.dim(count.padStart(4))}`;
      sidebar.push(sel ? c.bold("\x1b[7m" + line + "\x1b[27m") : line);
    }
    if (!channelList.length) sidebar.push(c.dim("  (no channels)"));

    const feed: string[] = [];
    const selChannel = channelList[selectedIdx];
    if (selChannel) {
      feed.push(c.bold(`  #${selChannel.channel}`) + c.dim(` — ${selChannel.messages} messages`));
      feed.push(c.dim("  " + "─".repeat(Math.max(0, feedCols - 2))));
      for (const msg of history) {
        const who = agentColor(msg.from?.name ?? "?")(msg.from?.name ?? "?");
        const ts = c.dim(new Date(msg.ts).toLocaleTimeString());
        const body = text(msg);
        feed.push(`  ${ts} ${who}:`);
        const maxW = Math.max(8, feedCols - 4);
        for (const rawLine of body.split(/\r?\n/)) {
          let cur = "";
          let curLen = 0;
          for (const word of rawLine.split(" ")) {
            const wl = visLen(word);
            if (curLen === 0) { cur = word; curLen = wl; }
            else if (curLen + 1 + wl <= maxW) { cur += " " + word; curLen += 1 + wl; }
            else { feed.push("    " + cur); cur = word; curLen = wl; }
          }
          feed.push("    " + cur);
        }
      }
      if (!history.length) feed.push(c.dim("  (no messages)"));
    } else {
      feed.push(c.dim("  Select a channel to view messages"));
    }

    const maxScroll = Math.max(0, feed.length - bodyRows);
    if (scroll > 0 && feed.length > 0) scroll = Math.min(scroll, maxScroll);
    else scroll = 0;
    lastMaxScroll = maxScroll;
    lastRoom = bodyRows;

    const visibleFeed = feed.slice(
      Math.max(0, feed.length - bodyRows - scroll),
      feed.length - scroll,
    );

    for (let row = 0; row < bodyRows; row++) {
      const left = row < sidebar.length ? padVis(sidebar[row], SIDEBAR_W) : " ".repeat(SIDEBAR_W);
      const right = row < visibleFeed.length ? clipVis(visibleFeed[row], feedCols) : " ".repeat(feedCols);
      lines.push(left + c.dim(" │ ") + right);
    }

    const footer = scroll > 0
      ? c.dim("──") + c.yellow(` ↑ ${scroll} more · End to follow `) + c.dim("─".repeat(Math.max(0, cols - 30)))
      : c.dim("─".repeat(cols));
    lines.push(footer);

    out.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\r\n") + "\x1b[J");
  };

  const selectChannel = async (idx: number) => {
    if (idx < 0 || idx >= channelList.length) return;
    selectedIdx = idx;
    scroll = 0;
    history = [];
    mark();
    fetchHistory(ep, space, channelList[idx].channel).then((msgs) => {
      history = msgs;
      mark();
    });
  };

  const setScroll = (v: number) => {
    const next = Math.max(0, Math.min(v, lastMaxScroll));
    if (next === scroll) return;
    scroll = next;
    dirty = true;
    render();
  };

  render();

  const tick = setInterval(() => { dirty = true; render(); }, 2000);
  out.on("resize", () => { scroll = 0; mark(); });

  const stdin = process.stdin;
  const shutdown = async () => {
    clearInterval(tick);
    clearInterval(refreshTimer);
    if (stdin.isTTY) {
      stdin.setRawMode(false);
      stdin.pause();
      out.write("\x1b[?1007l");
    }
    out.write("\x1b[?25h\x1b[?1049l");
    await ep.stop();
    process.exit(0);
  };

  if (stdin.isTTY) {
    out.write("\x1b[?1007h");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", (buf: Buffer) => {
      const s = buf.toString("latin1");
      if (s.includes("\x03") || s === "q") return void shutdown();
      if (s === "\x1b[A" || s === "k") { if (selectedIdx > 0) selectChannel(selectedIdx - 1); }
      else if (s === "\x1b[B" || s === "j") { if (selectedIdx < channelList.length - 1) selectChannel(selectedIdx + 1); }
      else if (s === "\x1b[5~") setScroll(scroll + (lastRoom - 1));
      else if (s === "\x1b[6~") setScroll(scroll - (lastRoom - 1));
      else if (s === "\x1b[F" || s === "\x1b[4~" || s === "G") setScroll(0);
      else if (s === "\x1b[H" || s === "\x1b[1~" || s === "g") setScroll(lastMaxScroll);
      else if (s === "\r" || s === "\n") selectChannel(selectedIdx);
      else if (s === "r") refreshChannels();
    });
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
}
