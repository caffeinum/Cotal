import { fileURLToPath } from "node:url";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";

/** The MCP server, lifecycle hooks, and host loop are run via tsx (Codex has no plugin
 *  copy-install). Each is resolved to the sibling that actually exists next to THIS module: the
 *  compiled `.js` when loaded from the built `dist/`, the `.ts` source in dev (run-from-src). tsx
 *  runs either; `../node_modules/.bin/tsx` sits at the package root, correct from dist or src alike. */
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const inDist = import.meta.url.includes("/dist/");
const entry = (base: string): string =>
  fileURLToPath(new URL(`./${base}.${inDist ? "js" : "ts"}`, import.meta.url));
const MCP_ENTRY = entry("mcp");
const HOOK_ENTRY = entry("hook");
const HOST_ENTRY = entry("host-main");

/** A TOML basic-string literal. Escapes the only interpolated values (absolute paths + identity)
 *  so a value containing a quote or backslash can't break — or inject into — the `-c` override. */
const toml = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Lifecycle events we relay to the connector's control socket → presence + inbox injection.
 *  Codex's hooks framework mirrors Claude Code's; the relay entry (hook.ts) is harness-agnostic. */
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop"];

/**
 * The Codex connector: launches `codex` with the cotal MCP server injected via `-c` overrides,
 * plus lifecycle hooks that relay to the connector's control socket — so the session joins the
 * mesh as a lateral peer WITH deterministic presence + inbox injection (Codex's hooks framework
 * mirrors Claude Code's). The overrides live in memory only — the operator's `~/.codex` (auth,
 * model, their own servers) is never written. Self-registers; the manager resolves it by type "codex".
 */
export const codexConnector: Connector = {
  kind: "connector",
  name: "codex",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = { COTAL_SPACE: opts.space, COTAL_NAME: opts.name };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;

    // Codex does not forward custom env to MCP servers, so identity goes in the server's `env`
    // table (escaped). approval_policy + sandbox make a spawned agent autonomous — it would
    // otherwise hang on the first approval prompt; default_tools_approval_mode auto-approves the
    // cotal tools so the agent can use the mesh without a human in the loop.
    const args = [
      "-c", `mcp_servers.cotal.command=${toml(TSX)}`,
      "-c", `mcp_servers.cotal.args=[${toml(MCP_ENTRY)}]`,
      "-c", `mcp_servers.cotal.default_tools_approval_mode="auto"`,
      "-c", `mcp_servers.cotal.env.COTAL_SPACE=${toml(opts.space)}`,
      "-c", `mcp_servers.cotal.env.COTAL_NAME=${toml(opts.name)}`,
      "-c", `approval_policy="never"`,
      "-c", `sandbox_mode="workspace-write"`,
    ];
    if (opts.role) args.push("-c", `mcp_servers.cotal.env.COTAL_ROLE=${toml(opts.role)}`);
    if (opts.servers) args.push("-c", `mcp_servers.cotal.env.COTAL_SERVERS=${toml(opts.servers)}`);
    // Identity + auth ride in the server's env table too (Codex forwards no process env to MCP
    // servers): the provisioned id, the minted creds, and the agent file. Without COTAL_CREDS the
    // endpoint can't authenticate to an auth-by-default mesh, so the agent would never join.
    if (opts.id) args.push("-c", `mcp_servers.cotal.env.COTAL_ID=${toml(opts.id)}`);
    if (opts.creds) args.push("-c", `mcp_servers.cotal.env.COTAL_CREDS=${toml(opts.creds)}`);
    if (opts.configPath)
      args.push("-c", `mcp_servers.cotal.env.COTAL_AGENT_FILE=${toml(opts.configPath)}`);

    // Lifecycle hooks → control socket (presence + inbox injection). The hook command runs the
    // relay via tsx; it inherits COTAL_SPACE/COTAL_NAME from the codex *process* env (above, not
    // the MCP env table) to find the right socket. `--dangerously-bypass-hook-trust` lets a
    // supervised spawn run them without the one-time trust prompt. Each handler is a single
    // `command` string — Codex's hook schema has no args array (unlike Claude's plugin hooks.json)
    // — so this assumes the tsx + entry paths contain no spaces (true for an installed package).
    const hookCmd = `${TSX} ${HOOK_ENTRY}`;
    for (const ev of HOOK_EVENTS)
      args.push("-c", `hooks.${ev}=[{ hooks = [{ type = "command", command = ${toml(hookCmd)} }] }]`);
    args.push("--dangerously-bypass-hook-trust");

    return { command: "codex", args, env };
  },
};

/**
 * The Codex host-mode connector: launches an embedded Cotal peer that drives a headless
 * `codex app-server` over JSON-RPC. A mesh message becomes a real user turn — wake an idle
 * session (turn/start), steer one already mid-turn (turn/steer), or interrupt it
 * (turn/interrupt); presence is read off the app-server event stream rather than self-reported.
 * No native TUI (the human view comes via the manager's attach). Mirrors the embed shape of
 * @cotal-ai/openai-agents. Self-registers; the manager resolves it by agent type "codex-app-server".
 */
export const codexAppServerConnector: Connector = {
  kind: "connector",
  name: "codex-app-server",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = { COTAL_SPACE: opts.space, COTAL_NAME: opts.name };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;
    return { command: TSX, args: [HOST_ENTRY], env };
  },
};

registry.register(codexConnector, codexAppServerConnector);
