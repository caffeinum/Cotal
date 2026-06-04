import { join } from "node:path";
import { SwarlEndpoint } from "@swarl/core";
import type { Connector, ControlReply, ControlRequest, Registry, Runtime } from "@swarl/core";
import {
  findWorkspaceRoot,
  killDetached,
  killTmux,
  spawnDetached,
  spawnTmux,
  tmuxAvailable,
  type Spawned,
} from "./spawn.js";

export interface ManagerOptions {
  space: string;
  /** Extension registry the manager resolves connectors (agent types) from. */
  registry: Registry;
  servers?: string;
  name?: string;
  /**
   * "auto" (default) uses tmux when available, else detached. "tmux"/"detached" pick a
   * built-in. Any other value is a runtime extension name resolved from the registry.
   */
  spawnMode?: string;
  workspaceRoot?: string;
}

interface ManagedAgent {
  name: string;
  role?: string;
  agent: string;
  startedAt: number;
  spawned: Spawned;
}

/**
 * The agent supervisor: a long-lived mesh node that owns agent process lifecycle.
 * It serves control requests on the "manager" service and spawns/kills agents as
 * child processes (tmux panes or detached). It does NOT proxy agent mesh traffic.
 */
export class Manager {
  private readonly space: string;
  private readonly registry: Registry;
  private readonly servers: string | undefined;
  private readonly name: string;
  private readonly workspaceRoot: string;
  private readonly mode: string;
  private readonly session: string;
  private readonly agents = new Map<string, ManagedAgent>();
  private ep!: SwarlEndpoint;

  constructor(opts: ManagerOptions) {
    this.space = opts.space;
    this.registry = opts.registry;
    this.servers = opts.servers;
    this.name = opts.name ?? "manager";
    this.workspaceRoot = opts.workspaceRoot ?? findWorkspaceRoot();
    const want = opts.spawnMode ?? "auto";
    if (want === "detached") {
      this.mode = "detached";
    } else if (want === "auto" || want === "tmux") {
      this.mode = tmuxAvailable() ? "tmux" : "detached";
    } else {
      // A runtime extension name — must be registered (no silent fallback).
      this.registry.resolve<Runtime>("runtime", want);
      this.mode = want;
    }
    this.session = `swarl-${this.space}`;
  }

  get spawnMode(): string {
    return this.mode;
  }

  async start(): Promise<void> {
    this.ep = new SwarlEndpoint({
      space: this.space,
      servers: this.servers,
      channels: [],
      card: { name: this.name, role: "manager", kind: "endpoint" },
    });
    await this.ep.start();
    await this.ep.setActivity(`supervisor (${this.mode})`);
    this.ep.serveControl("manager", (req) => this.handle(req));
  }

  async stop(): Promise<void> {
    await this.ep.stop();
  }

  private async handle(req: ControlRequest): Promise<ControlReply> {
    const args = req.args ?? {};
    switch (req.op) {
      case "start":
        return this.opStart(args);
      case "stop":
        return this.opStop(args);
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
    const role = args.role ? String(args.role) : undefined;
    const agent = args.agent ? String(args.agent) : "swarl";
    let spawned: Spawned;
    try {
      const connector = this.registry.resolve<Connector>("connector", agent);
      const spec = connector.buildLaunch({
        space: this.space,
        name,
        role,
        servers: this.servers,
      });
      if (this.mode === "tmux") {
        spawned = spawnTmux(this.session, name, spec, this.workspaceRoot);
      } else if (this.mode === "detached") {
        spawned = spawnDetached(
          spec,
          this.workspaceRoot,
          join(this.workspaceRoot, ".swarl", "logs", `${name}.log`),
        );
      } else {
        // Runtime extension (e.g. cmux) resolved by name from the registry.
        const runtime = this.registry.resolve<Runtime>("runtime", this.mode);
        const handle = runtime.spawn(name, spec, { cwd: this.workspaceRoot });
        spawned = { mode: this.mode, handle };
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    this.agents.set(name, { name, role, agent, startedAt: Date.now(), spawned });
    return { ok: true, data: { name, role, agent, mode: spawned.mode } };
  }

  private opStop(args: Record<string, unknown>): ControlReply {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    if (a.spawned.mode === "tmux" && a.spawned.session && a.spawned.window) {
      killTmux(a.spawned.session, a.spawned.window);
    } else if (a.spawned.pid) {
      killDetached(a.spawned.pid);
    } else if (a.spawned.handle) {
      this.registry.resolve<Runtime>("runtime", a.spawned.mode).stop(a.spawned.handle);
    }
    this.agents.delete(name);
    return { ok: true, data: { name, stopped: true } };
  }

  /** Managed agents cross-referenced with live presence (the manager sees the roster). */
  private list() {
    const roster = new Map(this.ep.getRoster().map((p) => [p.card.name, p]));
    return [...this.agents.values()].map((a) => ({
      name: a.name,
      role: a.role,
      agent: a.agent,
      mode: a.spawned.mode,
      uptimeMs: Date.now() - a.startedAt,
      mesh: roster.get(a.name)?.status ?? "absent",
    }));
  }
}
