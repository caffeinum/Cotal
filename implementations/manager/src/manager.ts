import { existsSync } from "node:fs";
import { SwarlEndpoint, agentFilePath, loadAgentFile, registry } from "@swarl/core";
import type { Connector, ControlReply, ControlRequest } from "@swarl/core";
import {
  createRuntime,
  findWorkspaceRoot,
  type AgentHandle,
  type Runtime,
  type RuntimeMode,
} from "./runtime/index.js";
import { AttachEndpoint } from "./attach-endpoint.js";

export interface ManagerOptions {
  space: string;
  servers?: string;
  name?: string;
  /** Spawn backend. `auto` (default) → pty, or tmux when already inside tmux. */
  runtime?: RuntimeMode;
  workspaceRoot?: string;
  /** Port for the console + attach HTTP/WS endpoint (loopback). 0 → ephemeral. */
  consolePort?: number;
}

interface ManagedAgent {
  name: string;
  role?: string;
  agent: string;
  startedAt: number;
  handle: AgentHandle;
}

/**
 * The agent supervisor: a long-lived mesh node that owns agent process lifecycle.
 * It serves control requests on the "manager" service and spawns/kills agents
 * through a pluggable {@link Runtime} (pty by default). It does NOT proxy agent
 * mesh traffic — terminal I/O streams over its own attach endpoint instead.
 */
export class Manager {
  private readonly space: string;
  private readonly servers: string | undefined;
  private readonly name: string;
  private readonly workspaceRoot: string;
  private readonly runtime: Runtime;
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly attach: AttachEndpoint;
  private ep!: SwarlEndpoint;

  constructor(opts: ManagerOptions) {
    this.space = opts.space;
    this.servers = opts.servers;
    this.name = opts.name ?? "manager";
    this.workspaceRoot = opts.workspaceRoot ?? findWorkspaceRoot();
    this.runtime = createRuntime(opts.runtime ?? "auto", `swarl-${this.space}`);
    this.attach = new AttachEndpoint(
      (name) => this.agents.get(name)?.handle,
      () => this.list(),
      opts.consolePort ?? 0,
    );
  }

  get runtimeKind(): string {
    return this.runtime.kind;
  }

  /** The console page URL (manager-hosted, loopback). */
  get consoleUrl(): string {
    return this.attach.consoleUrl();
  }

  async start(): Promise<void> {
    await this.attach.start();
    this.ep = new SwarlEndpoint({
      space: this.space,
      servers: this.servers,
      channels: [],
      card: { name: this.name, role: "manager", kind: "endpoint" },
    });
    await this.ep.start();
    await this.ep.setActivity(`supervisor (${this.runtime.kind})`);
    this.ep.serveControl("manager", (req) => this.handle(req));
  }

  async stop(): Promise<void> {
    await this.ep.stop();
    await this.attach.stop();
  }

  private async handle(req: ControlRequest): Promise<ControlReply> {
    const args = req.args ?? {};
    switch (req.op) {
      case "start":
        return this.opStart(args);
      case "stop":
        return this.opStop(args);
      case "attach":
        return this.opAttach(args);
      case "ps":
        return { ok: true, data: this.list() };
      case "status": {
        const name = String(args.name ?? "");
        const a = this.list().find((x) => x.name === name);
        return a ? { ok: true, data: a } : { ok: false, error: `no agent "${name}"` };
      }
      default:
        return { ok: false, error: `unknown op: ${req.op}` };
    }
  }

  private opStart(args: Record<string, unknown>): ControlReply {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "name required" };
    if (this.agents.has(name)) return { ok: false, error: `agent "${name}" already running` };
    const agent = args.agent ? String(args.agent) : "swarl";

    // Resolve an agent file from the manager's own workspace — an explicit
    // --config must exist; otherwise discover .swarl/agents/<name>.md if present.
    let configPath: string | undefined;
    if (args.config) {
      configPath = agentFilePath(this.workspaceRoot, String(args.config));
      if (!existsSync(configPath)) return { ok: false, error: `agent file not found: ${configPath}` };
    } else {
      const f = agentFilePath(this.workspaceRoot, name);
      if (existsSync(f)) configPath = f;
    }
    // --role overrides the file; the file fills it in for bookkeeping otherwise.
    let role = args.role ? String(args.role) : undefined;
    let handle: AgentHandle;
    try {
      const connector = registry.resolve<Connector>("connector", agent);
      if (configPath && !role) role = loadAgentFile(configPath).role;
      const spec = connector.buildLaunch({
        space: this.space,
        name,
        role,
        servers: this.servers,
        configPath,
      });
      handle = this.runtime.spawn(name, spec, this.workspaceRoot);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    this.agents.set(name, { name, role, agent, startedAt: Date.now(), handle });
    return { ok: true, data: { name, role, agent, mode: handle.kind } };
  }

  private opStop(args: Record<string, unknown>): ControlReply {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    a.handle.stop();
    this.agents.delete(name);
    return { ok: true, data: { name, stopped: true } };
  }

  private opAttach(args: Record<string, unknown>): ControlReply {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    if (this.runtime.kind !== "pty") {
      return {
        ok: false,
        error: `attach needs the pty runtime; under tmux run \`tmux attach -t swarl-${this.space}:${name}\``,
      };
    }
    return { ok: true, data: { ws: this.attach.url(name) } };
  }

  /** Managed agents cross-referenced with live presence (the manager sees the roster). */
  private list() {
    const roster = new Map(this.ep.getRoster().map((p) => [p.card.name, p]));
    return [...this.agents.values()].map((a) => ({
      name: a.name,
      role: a.role,
      agent: a.agent,
      space: this.space,
      mode: a.handle.kind,
      status: a.handle.status(),
      uptimeMs: Date.now() - a.startedAt,
      mesh: roster.get(a.name)?.status ?? "absent",
    }));
  }
}
