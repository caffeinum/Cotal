/**
 * E2E smoke test for @cotal-ai/tmux.
 * Run from the repo root: pnpm exec tsx extensions/tmux/smoke.ts
 * Uses a real tmux session; cleans up on pass or fail.
 */
import * as tmux from "./src/driver.js";
import { TmuxRuntime, tmuxRuntimeProvider, tmuxTerminalProvider } from "./src/runtime.js";
import { registry } from "@cotal-ai/core";
import { execFileSync } from "node:child_process";

const SESSION = "cotal-tmux-smoke";
let passed = 0;
let failed = 0;

function ok(label: string, val: unknown) {
  if (val) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function throws(label: string, fn: () => unknown) {
  try {
    fn();
    console.error(`  ✗ FAIL: ${label} — expected throw, got none`);
    failed++;
  } catch {
    console.log(`  ✓ ${label}`);
    passed++;
  }
}

function cleanup() {
  try {
    execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });
  } catch { /* already gone */ }
}

cleanup(); // start fresh

console.log("\n── driver ──────────────────────────────────────");

ok("available() returns true", tmux.available());

console.log(`\n── session: ${SESSION} ──────────────────────────`);
tmux.ensureSession(SESSION, "/tmp");
ok("ensureSession creates session", true);

// openWindow returns a stable window ID (@N), not session:name
const windowId = tmux.openWindow(SESSION, "test-win", "sleep 10", "/tmp", { focus: false });
ok(`openWindow returns a window ID (starts with @)`, windowId.startsWith("@"));
ok("windowAlive returns true for open window", tmux.windowAlive(SESSION, "test-win"));

// listWindows / windowRefs
const wins = tmux.listWindows(SESSION);
ok("listWindows includes test-win", wins.includes("test-win"));

const refs = tmux.windowRefs(SESSION, "test-win");
ok("windowRefs returns one entry", refs.length >= 1);
ok("windowRefs entry starts with @", refs[0]!.startsWith("@"));

// send / sendKey
tmux.send("echo hello", `${SESSION}:test-win`);
tmux.sendKey("Enter", `${SESSION}:test-win`);
ok("send + sendKey don't throw", true);

// closeWindow by stable ID
tmux.closeWindow(windowId);
ok("windowAlive returns false after closeWindow", !tmux.windowAlive(SESSION, "test-win"));

// idempotent close
tmux.closeWindow(windowId);
ok("closeWindow is idempotent (no throw on already-gone)", true);

console.log("\n── runtime ─────────────────────────────────────");

const runtime = new TmuxRuntime(SESSION);
const handle = runtime.spawn("smoke-agent", {
  command: "sleep",
  args: ["30"],
  env: { TEST_VAR: "hello" },
}, "/tmp");
ok(`handle.name = "smoke-agent"`, handle.name === "smoke-agent");
ok(`handle.kind = "tmux"`, handle.kind === "tmux");
ok("handle.status() = running", handle.status() === "running");
ok("window alive after spawn", tmux.windowAlive(SESSION, "smoke-agent"));

handle.interrupt();
ok("interrupt() doesn't throw", true);

throws("attach() throws", () => handle.attach());

handle.stop({ graceful: false });
await new Promise(r => setTimeout(r, 200));
ok("window gone after hard stop", !tmux.windowAlive(SESSION, "smoke-agent"));

console.log("\n── registry registration ────────────────────────");

const resolvedRuntime = registry.resolve("runtime", "tmux");
ok("tmuxRuntimeProvider registered as 'runtime/tmux'", resolvedRuntime != null);
ok("tmuxRuntimeProvider.available() returns true", tmuxRuntimeProvider.available());

const resolvedTerminal = registry.resolve("terminal", "tmux");
ok("tmuxTerminalProvider registered as 'terminal/tmux'", resolvedTerminal != null);
ok("tmuxTerminalProvider.available() returns true", tmuxTerminalProvider.available());

// refs() throws when not in tmux (no $TMUX env)
throws("refs() throws when not in tmux", () => tmuxTerminalProvider.refs("anything"));

console.log("\n── command builders ─────────────────────────────");

const isolated = tmux.isolatedCommand({ FOO: "bar baz", X: "1" }, "/usr/bin/env", ["sh"]);
ok("isolatedCommand starts with 'env -i'", isolated.startsWith("env -i"));
ok("isolatedCommand contains FOO=", isolated.includes("FOO="));
ok("isolatedCommand contains quoted command", isolated.includes("'/usr/bin/env'"));

const merged = tmux.mergedCommand({ FOO: "bar" }, "echo", ["hello"]);
ok("mergedCommand starts with 'env'", merged.startsWith("env"));
ok("mergedCommand does NOT contain '-i'", !merged.includes("env -i"));

console.log("\n────────────────────────────────────────────────");
console.log(`\n${passed} passed, ${failed} failed\n`);

cleanup();

if (failed > 0) process.exit(1);
