import WebSocket from "ws";

/** Detach key — Ctrl-] (0x1d), as in telnet/ssh escape conventions. */
const DETACH = 0x1d;

/**
 * Drive a manager's attach endpoint from the terminal: raw-mode stdin streams to
 * the PTY, PTY output streams to stdout, and SIGWINCH-style resizes are forwarded.
 * Ctrl-] detaches without killing the agent.
 */
export function attachClient(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;

    const sendResize = () =>
      ws.send(`r:${process.stdout.columns ?? 80},${process.stdout.rows ?? 24}`);
    const onInput = (d: Buffer) => {
      if (d.length === 1 && d[0] === DETACH) {
        ws.close();
        return;
      }
      ws.send(d);
    };
    const cleanup = () => {
      stdin.off("data", onInput);
      process.stdout.off("resize", sendResize);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    ws.on("open", () => {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      sendResize();
      process.stdout.on("resize", sendResize);
      stdin.on("data", onInput);
    });
    ws.on("message", (data: Buffer) => process.stdout.write(data));
    ws.on("close", () => {
      cleanup();
      resolve();
    });
    ws.on("error", (e) => {
      cleanup();
      reject(e);
    });
  });
}
