import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  CotalEndpoint,
  DEFAULT_SERVER,
  agentFilePath,
  authDir,
  clearSpaceHistory,
  findCotalRoot,
  loadAgentFile,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
  provisionAgent,
  registry,
  saveAgentFile,
  CONTROL_PRIVILEGED,
  CONTROL_SELF_SERVICE,
} from "@cotal-ai/core";
import type { AgentDef, Connector, ControlReply, ControlRequest, ControlTier, SpaceAuth } from "@cotal-ai/core";
import {
  createRuntime,
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

/** A spawn request, typed. The control-plane `start` op parses one of these out of an
 *  untyped request; roster boot constructs them directly. Both funnel into {@link Manager.startAgent}. */
export interface StartAgentOpts {
  name: string;
  /** Connector / agent type — resolved from the registry. Defaults to `"cotal"`. */
  agent?: string;
  role?: string;
  /** Explicit agent-file name-or-path; otherwise `.cotal/agents/<name>.md` is discovered if present. */
  config?: string;
  /** Mirror the session's transcript to `tr-<name>`. Defaults to on; `false` (the
   *  `--no-transcript` flag) disables it. */
  transcript?: boolean;
}

interface ManagedAgent {
  name: string;
  role?: string;
  agent: string;
  /** Stable id (nkey public key) the manager assigned this agent at spawn. */
  id: string;
  /** Private nkey seed, kept so a later step can mint matching creds for this id. */
  seed: string;
  /** Authenticated id of the peer that requested this spawn (the control-plane `req.from.id`),
   *  or the manager's own id for roster/pre-spawn. Non-forgeable — set by `handle()`. The spawner
   *  ledger (P4b) keys own-children despawn + reap-on-parent-exit off this. */
  spawner: string;
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
  private ep!: CotalEndpoint;
  /** Space trust material when the mesh runs in auth mode (`.cotal/auth` present);
   *  the manager mints per-agent creds from it at spawn. Undefined when the mesh is open. */
  private auth?: SpaceAuth;

  constructor(opts: ManagerOptions) {
    this.space = opts.space;
    this.servers = opts.servers;
    this.name = opts.name ?? "manager";
    this.workspaceRoot = opts.workspaceRoot ?? findCotalRoot();
    this.runtime = createRuntime(opts.runtime ?? "auto", `cotal-${this.space}`);
    this.attach = new AttachEndpoint(
      (name) => this.agents.get(name)?.handle,
      () => this.list(),
      // Initial /feed replay for a connecting console: the current peer roster.
      () => [{ event: "roster", data: this.ep?.getRoster() ?? [] }],
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
    // In auth mode the manager is just another user in the space's account — it mints
    // itself creds from the same signing key it uses for the agents it spawns.
    this.auth = loadSpaceAuth(authDir(this.workspaceRoot));
    let creds: string | undefined;
    let id: string | undefined;
    if (this.auth) {
      const identity = newIdentity();
      id = identity.id;
      // Privileged profile — the manager pre-creates others' DM durables and serves ctl;
      // minting it as "agent" would silently strip those once step 5 scopes "agent".
      creds = await mintCreds(this.auth, identity, "manager");
    }
    this.ep = new CotalEndpoint({
      space: this.space,
      servers: this.servers,
      channels: [],
      creds,
      // The supervisor serves control + watches presence; it never consumes chat/dm/task
      // (no message handler). consume:false avoids binding consumers it doesn't use — and
      // under auth avoids trying to bind its own DM/task durables that nothing pre-created.
      // It still pre-creates OTHERS' durables via provisionDmInbox/provisionTaskQueue (lazy jsm).
      consume: false,
      card: { id, name: this.name, role: "manager", kind: "endpoint" },
    });
    // Surface endpoint errors (incl. NATS permission denials) — without a listener an
    // emitted "error" would crash the supervisor.
    this.ep.on("error", (e: Error) => console.error(`! manager endpoint: ${e.message}`));
    await this.ep.start();
    await this.ep.setActivity(`supervisor (${this.runtime.kind})`);
    // Serve both control tiers (P2a): the privileged subject (start/purge/definePersona/named
    // stop) and the self-service subject (self stop/despawn). The cred layer grants self-service
    // to every agent and privileged only to spawn-capable ones (default-deny); the handler then
    // routes by op↔tier (fail-closed on mismatch) so a privileged op on the self-service subject
    // — or a self op on the privileged subject — is rejected before anything acts.
    this.ep.serveControl(CONTROL_PRIVILEGED, (req) => this.handle(req, CONTROL_PRIVILEGED));
    this.ep.serveControl(CONTROL_SELF_SERVICE, (req) => this.handle(req, CONTROL_SELF_SERVICE));
  }

  async stop(): Promise<void> {
    await this.ep.stop();
    await this.attach.stop();
  }

  private async handle(req: ControlRequest, tier: ControlTier): Promise<ControlReply> {
    const args = req.args ?? {};
    // `req.from.id` is non-forgeable in auth mode: serveControl rejects any request whose payload
    // `from.id` doesn't match the subject sender (endpoint.ts). In open mode there are no creds, so
    // from.id is self-asserted — the spawner ledger + this routing are auth-mode guarantees,
    // advisory in open mode (consistent with "open = single-trusted-host"). Thread it to every op
    // so authz (P2c) and the spawner ledger (P4b) can act on it.
    const caller = req.from.id;
    // Op↔tier binding — the real enforcement per the split. The cred gates WHO can reach each
    // subject; this gates WHAT each subject will honor, fail-closed. A privileged op arriving on
    // the self-service subject (publishable by all) must be rejected or the split does nothing.
    if (tier === CONTROL_SELF_SERVICE) {
      // Self-service honors ONLY a no-name stop (self-despawn). Any other op — including a named
      // stop (belongs on privileged) — is a misroute and rejected.
      if (req.op !== "stop") return { ok: false, error: `op "${req.op}" not allowed on self-service control subject` };
      const name = String(args.name ?? "").trim();
      if (name) return { ok: false, error: "named stop not allowed on self-service subject; send it on the privileged subject" };
      return this.opStopSelf(caller, args);
    }
    // Privileged tier. A no-name stop is a self-op and belongs on the self-service subject.
    switch (req.op) {
      case "start":
        return this.opStart(args, caller);
      case "stop": {
        const name = String(args.name ?? "").trim();
        if (!name) return { ok: false, error: "self-stop not allowed on privileged subject; send it on the self-service subject" };
        return this.opStop(args, caller);
      }
      case "definePersona":
        return this.opDefinePersona(args, caller);
      case "purge":
        return this.opPurge(args, caller);
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

  /** Self-despawn (P2b): stop the managed agent whose id == the authenticated caller. The
   *  no-name self-op can only ever resolve to the caller's OWN managed entry (ids are unique
   *  per spawn + non-forgeable in auth mode), never a peer — so it's structurally incapable of
   *  hitting another agent. Non-managed callers (human CLI, the manager itself, observers) find
   *  no match and get a loud error, not a silent no-op. */
  private opStopSelf(callerId: string, args: Record<string, unknown>): ControlReply {
    const target = [...this.agents.values()].find((a) => a.id === callerId);
    if (!target) return { ok: false, error: `self-stop: caller ${callerId} is not a managed agent` };
    const graceful = args.graceful !== false;
    target.handle.stop({ graceful });
    this.agents.delete(target.name);
    return { ok: true, data: { name: target.name, stopped: true, graceful } };
  }

  /** Agent names become `.cotal/agents/<name>.md` paths and mesh identities, so they must be bare
   *  tokens, never a path — blocks traversal / arbitrary writes from a model-supplied name. */
  private nameError(name: string): string | undefined {
    return /^[A-Za-z0-9_-]+$/.test(name)
      ? undefined
      : `unsafe name ${JSON.stringify(name)} (allowed: letters, digits, _ -)`;
  }

  /** Spawn a teammate by name (loads `.cotal/agents/<name>.md`), as if a peer asked via the
   *  control plane. Used to pre-spawn the demo's experts at startup so the manager owns them. */
  async startByName(name: string): Promise<ControlReply> {
    return this.startAgent({ name });
  }

  /** Resolve once `name` shows up on the mesh roster (presence registered), or after `timeoutMs`.
   *  Lets the pre-spawn loop stagger heavy agent cold-starts so they don't all boot at once. */
  async waitForPresence(name: string, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.ep.getRoster().some((p) => p.card.name === name)) return true;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return false;
  }

  /** Parse an untyped control-plane `start` request into {@link StartAgentOpts}. */
  private opStart(args: Record<string, unknown>, caller: string): Promise<ControlReply> {
    return this.startAgent(
      {
        name: String(args.name ?? "").trim(),
        agent: args.agent ? String(args.agent) : undefined,
        role: args.role ? String(args.role) : undefined,
        config: args.config ? String(args.config) : undefined,
        transcript: typeof args.transcript === "boolean" ? args.transcript : undefined,
      },
      caller,
    );
  }

  /** Spawn and supervise one agent. The single spawn path: both the control-plane
   *  `start` op and declarative roster boot call this. Mints scoped creds in auth mode,
   *  resolves the agent file, launches via the connector + runtime, and records the handle.
   *  `spawner` is the authenticated id of the peer that requested the spawn (`req.from.id`),
   *  defaulting to the manager's own id for roster/pre-spawn — recorded for the spawner
   *  ledger (own-children despawn + reap-on-parent-exit). */
  async startAgent(opts: StartAgentOpts, spawner?: string): Promise<ControlReply> {
    const name = opts.name.trim();
    if (!name) return { ok: false, error: "name required" };
    const nameErr = this.nameError(name);
    if (nameErr) return { ok: false, error: nameErr };
    if (this.agents.has(name)) return { ok: false, error: `agent "${name}" already running` };
    const agent = opts.agent ?? "cotal";

    // Resolve an agent file from the manager's own workspace — an explicit
    // --config must exist; otherwise discover .cotal/agents/<name>.md if present.
    let configPath: string | undefined;
    if (opts.config) {
      configPath = agentFilePath(this.workspaceRoot, opts.config);
      if (!existsSync(configPath)) return { ok: false, error: `agent file not found: ${configPath}` };
    } else {
      const f = agentFilePath(this.workspaceRoot, name);
      if (existsSync(f)) configPath = f;
    }
    // --role overrides the file; the file fills it in for bookkeeping otherwise.
    let role = opts.role;
    // A stable nkey identity assigned at spawn: the public key is the agent's card.id
    // (threaded via COTAL_ID); the seed is retained to mint matching creds later.
    const identity = newIdentity();
    let handle: AgentHandle;
    try {
      const connector = registry.resolve<Connector>("connector", agent);
      const def = configPath ? loadAgentFile(configPath) : undefined;
      if (!role) role = def?.role;
      // In auth mode, mint the agent's creds from the space signing key and write them
      // where the spawned session reads them (COTAL_CREDS path). Open mesh → no creds.
      // The publish allow-list is the file's `publish:`, falling back to `channels:`.
      let credsPath: string | undefined;
      if (this.auth) {
        // Pre-create the agent's bind-only DM (+ role TASK) durables and mint its scoped
        // creds — the shared onboarding step (provisionAgent), the manager just supplies its
        // own connected endpoint as the privileged provisioner.
        const creds = await provisionAgent(this.ep, this.auth, identity, {
          channels: def?.publish ?? def?.channels,
          role,
          capabilities: def?.capabilities,
        });
        credsPath = join(authDir(this.workspaceRoot), "creds", `${name}.creds`);
        mkdirSync(dirname(credsPath), { recursive: true });
        writeFileSync(credsPath, creds, { mode: 0o600 });
      }
      const spec = connector.buildLaunch({
        space: this.space,
        name,
        role,
        id: identity.id,
        creds: credsPath,
        servers: this.servers,
        configPath,
        transcript: opts.transcript,
      });
      handle = this.runtime.spawn(name, spec, this.workspaceRoot);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    this.agents.set(name, {
      name,
      role,
      agent,
      id: identity.id,
      seed: identity.seed,
      spawner: spawner ?? this.ep.ref().id,
      startedAt: Date.now(),
      handle,
    });
    return { ok: true, data: { name, role, agent, id: identity.id, mode: handle.kind } };
  }

  private opStop(args: Record<string, unknown>, _caller: string): ControlReply {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    const graceful = args.graceful !== false;
    a.handle.stop({ graceful });
    this.agents.delete(name);
    return { ok: true, data: { name, stopped: true, graceful } };
  }

  /** Purge the space's retained message backlog (chat, optionally DMs). Privileged — the
   *  manager mints its own "manager" creds (same as `cotal history clear`); regular agents are
   *  denied STREAM.PURGE under auth. Cleanup only: leaves live agents and the TASK queue alone. */
  private async opPurge(args: Record<string, unknown>, _caller: string): Promise<ControlReply> {
    const includeDms = args.includeDms === true;
    try {
      const creds = this.auth ? await mintCreds(this.auth, newIdentity(), "manager") : undefined;
      const result = await clearSpaceHistory({
        servers: this.servers ?? DEFAULT_SERVER,
        space: this.space,
        creds,
        includeDms,
      });
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Persist a peer-defined persona as config. After this, `start name` auto-discovers
   *  .cotal/agents/<name>.md and the connector applies its persona/model at spawn. */
  private opDefinePersona(args: Record<string, unknown>, _caller: string): ControlReply {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "name required" };
    const nameErr = this.nameError(name);
    if (nameErr) return { ok: false, error: nameErr };
    const persona = String(args.persona ?? "").trim();
    if (!persona) return { ok: false, error: "persona required" };
    const def: AgentDef = {
      name,
      role: args.role ? String(args.role) : undefined,
      model: args.model ? String(args.model) : undefined,
      persona,
    };
    const path = agentFilePath(this.workspaceRoot, name);
    try {
      saveAgentFile(path, def);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return { ok: true, data: { name, path } };
  }

  private opAttach(args: Record<string, unknown>): ControlReply {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    // Only pty streams over the WS attach endpoint. tmux/cmux are watched natively, and
    // each handle's attach() throws with the right per-runtime guidance (tmux attach … /
    // switch to the cmux tab) — surface that instead of assuming tmux.
    if (a.handle.kind !== "pty") {
      try {
        a.handle.attach();
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
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
