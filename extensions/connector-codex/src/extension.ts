import { fileURLToPath } from "node:url";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@swarl/core";

/** The MCP server runs straight from source via tsx (Codex has no plugin copy-install, so
 *  there's no build step) — both paths resolved relative to this file. */
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const MCP_ENTRY = fileURLToPath(new URL("./mcp.ts", import.meta.url));

/** A TOML basic-string literal. Escapes the only interpolated values (absolute paths + identity)
 *  so a value containing a quote or backslash can't break — or inject into — the `-c` override. */
const toml = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The Codex connector: launches `codex` with the swarl MCP server injected via `-c` overrides,
 * so the session joins the mesh as a lateral peer. Codex is **pull-only** — it sandboxes
 * lifecycle hooks (they can't reach the connector's control socket), so there are no hooks: the
 * agent reads its inbox with `swarl_inbox` and reports presence with `swarl_status`. The overrides
 * live in memory only — the operator's `~/.codex` (auth, model, their own servers) is never
 * written. Self-registers on import; the manager resolves it by agent type "codex".
 */
export const codexConnector: Connector = {
  kind: "connector",
  name: "codex",
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    const env: Record<string, string> = { SWARL_SPACE: opts.space, SWARL_NAME: opts.name };
    if (opts.role) env.SWARL_ROLE = opts.role;
    if (opts.servers) env.SWARL_SERVERS = opts.servers;

    // Codex does not forward custom env to MCP servers, so identity goes in the server's `env`
    // table (escaped). approval_policy + sandbox make a spawned agent autonomous — it would
    // otherwise hang on the first approval prompt; default_tools_approval_mode auto-approves the
    // swarl tools so the agent can use the mesh without a human in the loop.
    const args = [
      "-c", `mcp_servers.swarl.command=${toml(TSX)}`,
      "-c", `mcp_servers.swarl.args=[${toml(MCP_ENTRY)}]`,
      "-c", `mcp_servers.swarl.default_tools_approval_mode="auto"`,
      "-c", `mcp_servers.swarl.env.SWARL_SPACE=${toml(opts.space)}`,
      "-c", `mcp_servers.swarl.env.SWARL_NAME=${toml(opts.name)}`,
      "-c", `approval_policy="never"`,
      "-c", `sandbox_mode="workspace-write"`,
    ];
    if (opts.role) args.push("-c", `mcp_servers.swarl.env.SWARL_ROLE=${toml(opts.role)}`);
    if (opts.servers) args.push("-c", `mcp_servers.swarl.env.SWARL_SERVERS=${toml(opts.servers)}`);
    return { command: "codex", args, env };
  },
};

registry.register(codexConnector);
