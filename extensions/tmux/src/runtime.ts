import {
  registry,
  type AgentHandle,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
  type Tab,
  type TerminalLayout,
} from "@cotal-ai/core";
import * as tmux from "./driver.js";

/** Grace window for a clean exit before a graceful stop force-closes the window. */
const GRACE_MS = 1_500;

/**
 * Spawns each agent into its own new tmux window in a shared per-space session, so
 * spawned teammates get room rather than crowding the spawner. Opened unfocused so the
 * human stays in their current window; switch to `session:name` to watch the worker.
 * Like cmux, you watch natively, so `attach()` throws — but teardown is real: the window
 * target is kept so it can be driven and closed.
 */
export class TmuxRuntime implements Runtime {
  readonly kind = "tmux" as const;

  constructor(private readonly session: string) {}

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new Error(
        `tmux runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`,
      );
    if (!tmux.available())
      throw new Error("tmux runtime: tmux is not available — is tmux installed and on PATH?");

    tmux.ensureSession(this.session, cwd);
    // P3: env -i strips the tmux server's inherited environment; only the connector-declared
    // env reaches the spawned agent (identity, model key, OS allow-list).
    const command = tmux.isolatedCommand(spec.env ?? {}, spec.command, spec.args);
    tmux.openWindow(this.session, name, command, cwd, { focus: false });

    const target = `${this.session}:${name}`;

    if (spec.confirm) {
      // Auto-press Enter a few times to clear a one-time confirmation prompt the agent
      // may show on startup (e.g. Claude's dev-channels prompt).
      for (let i = 1; i <= 5; i++) {
        setTimeout(() => {
          try {
            tmux.sendKey("Enter", target);
          } catch {
            /* window may be gone — ignore */
          }
        }, i * 1_000);
      }
    }

    return {
      name,
      kind: "tmux",
      status: () => (tmux.windowAlive(this.session, name) ? "running" : "exited"),
      stop: (opts) => {
        const kill = () => tmux.closeWindow(target);
        if (opts?.graceful === false) return kill();
        // Graceful: type `/exit` so the Claude session shuts down cleanly (its SessionEnd
        // hook leaves the mesh), then close the now-idle window regardless.
        try {
          tmux.send("/exit", target);
          tmux.sendKey("Enter", target);
        } catch {
          /* window already gone — still ensure it's closed below */
        }
        setTimeout(kill, GRACE_MS);
      },
      interrupt: () => {
        tmux.sendKey("C-c", target);
      },
      attach: () => {
        throw new Error(`tmux runtime: attach natively with \`tmux attach -t ${target}\``);
      },
    };
  }
}

/** Self-registering runtime provider — `import "@cotal-ai/tmux"` makes the manager's
 *  `tmux` runtime available without the manager depending on this package. */
export const tmuxRuntimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "tmux",
  available: () => tmux.available(),
  create: (opts) => new TmuxRuntime(opts.session),
};

registry.register(tmuxRuntimeProvider);

/** Translate a backend-agnostic {@link Tab} into a sequence of tmux commands on `session`.
 *  One pane → a bare window; several → a window + splits. These panes inherit the caller's
 *  env (setup panes run further `cotal` subcommands), so no `-i` isolation here. */
function tmuxLayout(session: string, label: string, tab: Tab): void {
  const [first, ...rest] = tab.panes;
  if (!first) throw new Error(`tmux layout "${label}": tab has no panes`);

  const firstCmd = tmux.mergedCommand(first.env ?? {}, first.command, first.args ?? []);
  tmux.openWindow(session, label, firstCmd, first.cwd ?? ".", { focus: false });

  if (rest.length > 0 && !tab.split)
    throw new Error(
      `tmux layout "${label}": ${tab.panes.length} panes need a split (direction + ratio)`,
    );

  const target = `${session}:${label}`;
  for (const pane of rest) {
    const cmd = tmux.mergedCommand(pane.env ?? {}, pane.command, pane.args ?? []);
    tmux.splitWindow(target, cmd, pane.cwd ?? ".", tab.split!.direction, tab.split!.ratio);
  }
}

/** Self-registering terminal-layout provider — lets a caller (e.g. `cotal setup`) open/close
 *  tmux windows by resolving `registry.resolve("terminal","tmux")`, so an implementation
 *  drives tmux without importing this package. The session is detected from the ambient `$TMUX`
 *  environment (the caller must be running inside tmux). */
export const tmuxTerminalProvider: TerminalLayout = {
  kind: "terminal",
  name: "tmux",
  available: () => tmux.available(),
  open: (label, tab, opts) => {
    const session = tmux.currentSession();
    tmuxLayout(session, label, tab);
    const target = `${session}:${label}`;
    if (opts?.focus) tmux.selectWindow(target);
    return target;
  },
  close: (ref) => tmux.closeWindow(ref),
  refs: (label) => {
    try {
      return tmux.windowRefs(tmux.currentSession(), label);
    } catch {
      return [];
    }
  },
};

registry.register(tmuxTerminalProvider);
