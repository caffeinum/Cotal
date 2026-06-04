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

/** Build an {@link AgentConfig} from `SWARL_*` environment variables. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const channels = splitList(env.SWARL_CHANNELS);
  return {
    space: env.SWARL_SPACE?.trim() || "demo",
    name: env.SWARL_NAME?.trim() || `claude-${process.pid}`,
    role: env.SWARL_ROLE?.trim() || undefined,
    servers: env.SWARL_SERVERS?.trim() || DEFAULT_SERVER,
    channels: channels.length ? channels : ["general"],
    kind: (env.SWARL_KIND?.trim() as EndpointKind) || "agent",
  };
}
