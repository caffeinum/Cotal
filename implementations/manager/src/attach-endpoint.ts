import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentHandle } from "./runtime/index.js";

/**
 * A local HTTP+WebSocket endpoint the manager hosts to stream an agent's PTY to
 * `swarl attach` (and, later, the browser console). PTY frames go over this
 * direct socket — never the mesh — so owning the terminal keeps the manager off
 * the message hot path. Bound to loopback only.
 *
 * Protocol: server → client sends raw terminal bytes (binary). client → server:
 * binary frames are keystrokes; a text frame `r:<cols>,<rows>` resizes.
 */
export class AttachEndpoint {
  #http: Server;
  #wss: WebSocketServer;
  #port = 0;

  constructor(private readonly lookup: (name: string) => AgentHandle | undefined) {
    this.#http = createServer();
    this.#wss = new WebSocketServer({ server: this.#http });
    this.#wss.on("connection", (ws, req) => this.#onConnection(ws, req.url ?? "/"));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#http.listen(0, "127.0.0.1", resolve));
    const addr = this.#http.address();
    if (addr && typeof addr === "object") this.#port = addr.port;
  }

  async stop(): Promise<void> {
    for (const ws of this.#wss.clients) ws.terminate();
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  /** The ws URL a client uses to attach to `name`. */
  url(name: string): string {
    return `ws://127.0.0.1:${this.#port}/${encodeURIComponent(name)}`;
  }

  #onConnection(ws: WebSocket, path: string): void {
    const name = decodeURIComponent(path.replace(/^\//, ""));
    const handle = this.lookup(name);
    if (!handle || handle.status() !== "running") {
      ws.close();
      return;
    }
    const session = handle.attach();

    const backlog = session.backlog();
    if (backlog.length) ws.send(backlog);

    const offData = session.onData((chunk) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    const offExit = session.onExit(() => ws.close());

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        session.write((data as Buffer).toString("utf8"));
        return;
      }
      const text = data.toString();
      const m = /^r:(\d+),(\d+)$/.exec(text);
      if (m) session.resize(Number(m[1]), Number(m[2]));
      else session.write(text);
    });
    ws.on("close", () => {
      offData();
      offExit();
    });
  }
}
