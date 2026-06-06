import { DEFAULT_SERVER, type EndpointKind } from "@swarl/core";

/**
 * How a connector instance presents itself on the mesh. Everything is read from
 * the environment so the *launcher* (the manager spawning an agent, or a human
 * running `swarl join` / their own terminal) decides identity once and both the
 * MCP server and the lifecycle hooks inherit it.
 */
export interface AgentConfig {
  space: string;
  name: string;
  role?: string;
  servers: string;
  channels: string[];
  kind: EndpointKind;
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True iff the env carries a Swarl identity — i.e. this is a launcher-spawned
 *  session, not an operator's plain `claude`. The connector stays inert otherwise. */
export function hasIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SWARL_NAME?.trim());
}

/** Build an {@link AgentConfig} from `SWARL_*` environment variables. Identity is
 *  NOT defaulted: `SWARL_NAME` is required so a plain `claude` (no env) never
 *  silently joins the mesh as a stray peer — guard with {@link hasIdentity} first. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const name = env.SWARL_NAME?.trim();
  if (!name) throw new Error("SWARL_NAME is required — a Swarl session needs an explicit identity from its launcher");
  const channels = splitList(env.SWARL_CHANNELS);
  return {
    space: env.SWARL_SPACE?.trim() || "demo",
    name,
    role: env.SWARL_ROLE?.trim() || undefined,
    servers: env.SWARL_SERVERS?.trim() || DEFAULT_SERVER,
    channels: channels.length ? channels : ["general"],
    kind: (env.SWARL_KIND?.trim() as EndpointKind) || "agent",
  };
}
