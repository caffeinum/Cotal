/**
 * Hermes launcher / supervisor — the `hermes` connector's command (run from source via tsx).
 *
 * Hermes is a long-lived gateway daemon that creates a fresh `AIAgent` per inbound message, so the
 * mesh endpoint must outlive every turn — it can't ride inside a per-turn MCP server the way it
 * does for Claude Code / Codex. This process therefore OWNS the single {@link MeshAgent} for the
 * gateway's whole life and supervises `hermes gateway run` as its child:
 *
 *   - connector-core **control socket** ← Python presence hooks (relay.ts pattern) → presence
 *   - **bridge socket** ⇄ Python gateway adapter + cotal_* tools (inbound wake/drive, outbound)
 *   - an isolated **HERMES_HOME** profile so the operator's own ~/.hermes is never touched
 *
 * The manager runs this in a PTY; stdio is inherited so the gateway's output is what you attach to.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentFile } from "@cotal-ai/core";
import {
  configFromEnv,
  hasIdentity,
  MeshAgent,
  controlSocketPath,
  startControlServer,
} from "@cotal-ai/connector-core";
import { hermesHookHandle } from "./hermes-hooks.js";
import { startBridgeServer } from "./bridge.js";

const ILLEGAL = /[^A-Za-z0-9_-]/g;
const tok = (s: string): string => s.trim().replace(ILLEGAL, "_").slice(0, 40) || "_";

/** This package's root (where pyproject.toml + plugin/ live), resolved from this source file. */
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_SRC = join(PKG_DIR, "plugin", "cotal");

/** The bridge socket — sibling of connector-core's control socket, same deterministic derivation. */
function bridgeSocketPath(space: string, name: string): string {
  return join(tmpdir(), `cotal-hermes-bridge-${tok(space)}-${tok(name)}.sock`);
}

function log(msg: string): void {
  process.stderr.write(`[cotal-hermes] ${msg}\n`);
}

/** A double-quoted YAML basic-string literal (escaped). */
const yamlStr = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Build the isolated Hermes profile (HERMES_HOME) so the operator's ~/.hermes is never touched.
 * Drops the cotal plugin into the profile's plugins dir and writes a minimal non-secret config.
 * NOTE: the config keys target the Hermes 0.16 line and are intentionally minimal — see
 * docs/hermes-integration.md; validate against your Hermes version.
 */
function setupProfile(home: string, opts: { model?: string; persona?: string }): void {
  mkdirSync(home, { recursive: true });
  const pluginDst = join(home, "plugins", "cotal");
  rmSync(pluginDst, { recursive: true, force: true });
  mkdirSync(join(home, "plugins"), { recursive: true });
  cpSync(PLUGIN_SRC, pluginDst, { recursive: true });

  const lines = [
    "# Cotal-managed Hermes profile — regenerated each launch; do not edit.",
    // An autonomous spawned gateway must not block on command approval (no human at the TUI).
    "approvals:",
    "  mode: off",
  ];
  if (opts.model) lines.push(`model: ${yamlStr(opts.model)}`);
  writeFileSync(join(home, "config.yaml"), lines.join("\n") + "\n");

  // Persona → SOUL.md (Hermes' personality file) — the one place a system prompt can be set.
  if (opts.persona) writeFileSync(join(home, "SOUL.md"), opts.persona.trim() + "\n");
}

async function main(): Promise<void> {
  // No identity → a plain run, not a launcher-spawned agent. Stay off the mesh.
  if (!hasIdentity()) {
    log("no COTAL_NAME — not a managed session; staying off the mesh");
    process.exit(0);
  }
  const config = configFromEnv();
  const agent = new MeshAgent(config);
  agent.start(); // background connect with retry

  const controlSock = controlSocketPath(config.space, config.name);
  const controlServer = startControlServer(agent, controlSock, hermesHookHandle);
  const bridgeSock = bridgeSocketPath(config.space, config.name);
  const bridge = startBridgeServer(agent, bridgeSock);

  const home = join(tmpdir(), `cotal-hermes-${tok(config.space)}-${tok(config.name)}`);
  const persona = process.env.COTAL_AGENT_FILE
    ? loadAgentFile(process.env.COTAL_AGENT_FILE).persona
    : undefined;
  setupProfile(home, { model: process.env.HERMES_MODEL, persona });

  // The gateway inherits identity + socket paths + the isolated profile. The cotal platform
  // auto-enables because its required env (COTAL_BRIDGE_SOCKET) is present at gateway startup.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_HOME: home,
    COTAL_CONTROL_SOCKET: controlSock,
    COTAL_BRIDGE_SOCKET: bridgeSock,
  };

  log(`launching hermes gateway as ${config.name}${config.role ? `/${config.role}` : ""} (HERMES_HOME=${home})`);
  const child = spawn("uv", ["run", "--project", PKG_DIR, "hermes", "gateway", "run"], {
    env: childEnv,
    stdio: "inherit",
  });

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    try {
      bridge.close();
    } catch {
      /* ignore */
    }
    try {
      controlServer.close();
    } catch {
      /* ignore */
    }
    try {
      await agent.stop();
    } finally {
      process.exit(code);
    }
  };

  child.on("exit", (code) => void shutdown(code ?? 0));
  child.on("error", (e) => {
    log(`failed to launch hermes gateway: ${e.message} — is uv (and hermes-agent) available?`);
    void shutdown(1);
  });
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
}

main().catch((e) => {
  log(`fatal: ${(e as Error).stack ?? String(e)}`);
  process.exit(1);
});
