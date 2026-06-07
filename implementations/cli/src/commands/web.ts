import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SwarlEndpoint,
  isReachable,
  DEFAULT_SERVER,
  deliveryOf,
  parseSubject,
  spaceWildcard,
  authDir,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
  type SwarlMessage,
} from "@swarl/core";
import { c } from "../ui.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE: Record<string, { path: string; type: string }> = {
  "/": { path: join(here, "../web/index.html"), type: "text/html; charset=utf-8" },
  "/app.js": { path: join(here, "../web/app.js"), type: "text/javascript; charset=utf-8" },
};

/** A live observability dashboard for a space, served over HTTP + SSE. A read-only
 *  observer endpoint (invisible to peers) feeds the page presence, channel history,
 *  and a live message stream — no manager required. Bound to loopback. */
export async function web(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: "string" },
      server: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      creds: { type: "string" },
    },
  });
  const space = values.space ?? "demo";
  const server = values.server ?? DEFAULT_SERVER;
  const port = values.port ? Number(values.port) : 7799;
  // The dashboard is always an admin god-view (no read-only viewer mode) so it can show DMs
  // and anycast. Auth mode (`.swarl/auth` present): self-mint an `admin` cred so it joins the
  // authed mesh with no manual --creds — like `swarl spawn`, it holds the space signing key.
  // An explicit --creds still wins. Open mode (no auth): connect bare.
  let creds = values.creds ? readFileSync(values.creds, "utf8") : undefined;
  if (!creds) {
    const auth = loadSpaceAuth(authDir(process.cwd()));
    if (auth) {
      if (auth.space !== space) {
        console.error(
          c.red(`Auth here is for space "${auth.space}", not "${space}". Use --space ${auth.space} (or pass --creds).`),
        );
        process.exit(1);
      }
      creds = await mintCreds(auth, newIdentity(), "admin");
    }
  }
  if (!(await isReachable(server, { creds }))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: pnpm swarl up`));
    process.exit(1);
  }

  // Observer: never registers presence, never consumes an inbox — invisible to peers.
  const ep = new SwarlEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false, // observer: reads via tap + history + presence-watch, binds no durables
    registerPresence: false,
    watchPresence: true,
    card: { name: "web", kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();

  const clients = new Set<ServerResponse>();
  const send = (res: ServerResponse, event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event: string, data: unknown) => {
    for (const res of clients) if (!res.writableEnded) send(res, event, data);
  };

  // Presence changes → push the whole roster; the client just re-renders it.
  ep.on("presence", () => broadcast("roster", ep.getRoster()));
  // Every comm on the mesh (chat / unicast / anycast) → push to the live feed. The admin cred
  // allows the whole space, so the observer taps everything — DMs + anycast included.
  const tapSubject = spaceWildcard(space);
  ep.tap((subject, msg) => {
    const mode = deliveryOf(subject);
    if (!mode || !msg) return;
    // senderId is the subject's sender token — the *verified* publisher (the server
    // policed who could publish it), vs the advisory `from` in the payload.
    const senderId = parseSubject(subject)?.sender;
    broadcast("message", { mode, senderId, msg });
  }, { subject: tapSubject });

  const httpServer = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");

    if (path === "/feed") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clients.add(res);
      send(res, "roster", ep.getRoster());
      req.on("close", () => clients.delete(res));
      return;
    }
    if (path === "/api/meta") return json(res, { space });
    if (path === "/api/roster") return json(res, ep.getRoster());
    if (path === "/api/channels") return json(res, await ep.listChannels());
    if (path === "/api/activity") {
      // Backfill the all-activity feed: merge recent channel history with DM history (the live
      // SSE tap only carries messages from after a client connects). Entries are mode-tagged
      // ({mode, msg}) to match the live feed so DMs render as DMs.
      const limit = query.get("limit") ? Number(query.get("limit")) : 200;
      const chans = await ep.listChannels();
      const chat = (
        await Promise.all(chans.map((ch) => ep.channelHistory(ch.channel, { limit })))
      )
        .flat()
        .map((msg) => ({ mode: "chat" as const, msg }));
      const dms = (await ep.dmHistory({ limit })).map((msg) => ({ mode: "unicast" as const, msg }));
      const all = [...chat, ...dms].sort((a, b) => a.msg.ts - b.msg.ts);
      return json(res, all.slice(-limit));
    }
    if (path === "/api/dms") {
      // DM history for the Direct-messages lens (god-view); the client groups it by peer/pair.
      const limit = query.get("limit") ? Number(query.get("limit")) : 500;
      return json(res, await ep.dmHistory({ limit }));
    }
    if (path.startsWith("/api/channels/") && path.endsWith("/history")) {
      const name = decodeURIComponent(path.slice("/api/channels/".length, -"/history".length));
      const limit = query.get("limit") ? Number(query.get("limit")) : 200;
      return json(res, await ep.channelHistory(name, { limit }));
    }

    const file = PAGE[path];
    if (file) {
      res.writeHead(200, { "content-type": file.type });
      res.end(readFileSync(file.path));
      return;
    }
    res.writeHead(404).end("not found");
  });

  // Comment ping keeps idle SSE connections alive through proxies.
  const ping = setInterval(() => {
    for (const res of clients) if (!res.writableEnded) res.write(": ping\n\n");
  }, 20_000);

  httpServer.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") console.error(c.red(`Port ${port} is in use. Pass --port <n>.`));
    else console.error(c.red("! " + e.message));
    process.exit(1);
  });

  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port}/`;
  console.log(`${c.bold("Swarl web")} — observing space ${c.bold(space)}`);
  console.log(c.dim("  god-view — DMs + anycast visible"));
  console.log(`  ${c.cyan(url)}  ${c.dim("(Ctrl-C to stop)")}`);
  if (!values["no-open"]) openBrowser(url);

  const shutdown = async () => {
    clearInterval(ping);
    for (const res of clients) res.end();
    httpServer.close();
    await ep.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Best-effort open of the dashboard in the default browser. The URL is already
 *  printed, so a failure here is harmless — never block startup on it. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no opener on this platform — the printed URL is the fallback */
  }
}
