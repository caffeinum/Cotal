import { userInfo } from "node:os";
import { readFileSync } from "node:fs";
import { DEFAULT_SERVER, loadAgentFile, parseJoinLink, type AgentDef, type EndpointKind } from "@swarl/core";

/**
 * How a connector instance presents itself on the mesh. Everything is read from
 * the environment so the *launcher* (the manager spawning an agent, or a human
 * running `swarl join` / their own terminal) decides identity once and both the
 * MCP server and the lifecycle hooks inherit it.
 */
export interface AgentConfig {
  space: string;
  /** Stable agent id (nkey public key) from the launcher; falls back to a random
   *  uuid in the endpoint when absent (unmanaged sessions). */
  id?: string;
  /** Minted creds file content (auth mode); the endpoint authenticates with it. */
  creds?: string;
  name: string;
  role?: string;
  description?: string;
  tags?: string[];
  servers: string;
  channels: string[];
  kind: EndpointKind;
  token?: string;
  user?: string;
  pass?: string;
  tls: boolean;
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True iff the env carries a Swarl identity — i.e. this is a launcher-spawned
 *  session, not an operator's plain `claude`. `SWARL_LINK` / `SWARL_AGENT_FILE`
 *  count: setting either is itself the explicit opt-in. The connector stays
 *  inert otherwise. */
export function hasIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SWARL_NAME?.trim() || env.SWARL_LINK?.trim() || env.SWARL_AGENT_FILE?.trim());
}

/** Build an {@link AgentConfig} from `SWARL_*` environment variables. Two refs
 *  fill many fields at once: `SWARL_LINK` (swarl://token@host/space) supplies the
 *  *where* (server, auth, space); `SWARL_AGENT_FILE` (.swarl/agents/<name>.md)
 *  supplies the *who* (name, role, kind, channels, description, tags).
 *  Individual `SWARL_*` vars override both. Identity is NOT silently defaulted
 *  unless a link is present — guard with {@link hasIdentity} first. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const link = env.SWARL_LINK?.trim() ? parseJoinLink(env.SWARL_LINK.trim()) : undefined;
  const def: AgentDef | undefined = env.SWARL_AGENT_FILE?.trim()
    ? loadAgentFile(env.SWARL_AGENT_FILE.trim())
    : undefined;
  const name = env.SWARL_NAME?.trim() || def?.name || (link ? userInfo().username : undefined);
  if (!name)
    throw new Error("SWARL_NAME, SWARL_AGENT_FILE or SWARL_LINK is required — a Swarl session needs an explicit identity from its launcher");
  const channels = splitList(env.SWARL_CHANNELS);
  const credsPath = env.SWARL_CREDS?.trim();
  return {
    space: env.SWARL_SPACE?.trim() || link?.space || "demo",
    id: env.SWARL_ID?.trim() || undefined,
    creds: credsPath ? readFileSync(credsPath, "utf8") : undefined,
    name,
    role: env.SWARL_ROLE?.trim() || def?.role || undefined,
    description: def?.description,
    tags: def?.tags,
    servers: env.SWARL_SERVERS?.trim() || link?.servers || DEFAULT_SERVER,
    channels: channels.length ? channels : (def?.channels ?? link?.channels ?? ["general"]),
    kind: (env.SWARL_KIND?.trim() as EndpointKind) || def?.kind || "agent",
    token: env.SWARL_TOKEN?.trim() || link?.token,
    user: link?.user,
    pass: link?.pass,
    tls: env.SWARL_TLS?.trim() === "1" || link?.tls || false,
  };
}
