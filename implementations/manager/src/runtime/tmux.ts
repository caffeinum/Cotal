import { execFileSync } from "node:child_process";
import type { AgentHandle, LaunchSpec, Runtime } from "@cotal/core";

export function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Grace window for a clean exit before a graceful stop kills the window. */
const GRACE_MS = 1_500;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function hasSession(session: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function windowAlive(session: string, name: string): boolean {
  try {
    const out = execFileSync("tmux", ["list-windows", "-t", session, "-F", "#W"], {
      encoding: "utf8",
    });
    return out.split("\n").includes(name);
  } catch {
    return false;
  }
}

/**
 * Opt-in runtime for users already living in a multiplexer: each agent gets a
 * tmux window in a shared per-space session. You watch / drive it natively
 * (`tmux attach -t <session>:<name>`), so `attach()` here points you there
 * rather than streaming — the PTY runtime is the streamable default.
 */
export class TmuxRuntime implements Runtime {
  readonly kind = "tmux" as const;

  constructor(private readonly session: string) {}

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (!hasSession(this.session)) {
      execFileSync("tmux", ["new-session", "-d", "-s", this.session, "-c", cwd], {
        stdio: "ignore",
      });
    }
    const envPrefix = Object.entries(spec.env ?? {}).map(
      ([k, v]) => `${k}=${shellQuote(v)}`,
    );
    const cmd = [...envPrefix, spec.command, ...spec.args.map(shellQuote)].join(" ");
    execFileSync(
      "tmux",
      ["new-window", "-t", this.session, "-n", name, "-c", cwd, cmd],
      { stdio: "ignore" },
    );

    const target = `${this.session}:${name}`;
    return {
      name,
      kind: "tmux",
      status: () => (windowAlive(this.session, name) ? "running" : "exited"),
      stop: (opts) => {
        const kill = () => {
          try {
            execFileSync("tmux", ["kill-window", "-t", target], { stdio: "ignore" });
          } catch {
            /* already gone */
          }
        };
        if (opts?.graceful === false) return kill();
        // Graceful: type `/exit` so the session leaves the mesh cleanly, then
        // kill the window after a grace window in case it's still up.
        try {
          execFileSync("tmux", ["send-keys", "-t", target, "/exit", "Enter"], { stdio: "ignore" });
        } catch {
          /* window already gone */
        }
        setTimeout(kill, GRACE_MS);
      },
      interrupt: () => {
        execFileSync("tmux", ["send-keys", "-t", target, "C-c"], { stdio: "ignore" });
      },
      attach: () => {
        throw new Error(`tmux runtime: attach natively with \`tmux attach -t ${target}\``);
      },
    };
  }
}
