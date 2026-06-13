import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SERVER, DEFAULT_SPACE, authDir, isReachable, loadSpaceAuth } from "@cotal-ai/core";
import { resolveNatsServer } from "./nats-bin.js";

export interface MeshStatus {
  reachable: boolean;
  server: string;
  space: string; // from .cotal/auth if present, else the default
  auth: boolean; // auth mode (trust material on disk) vs open
}

/** Cheap, connectionless-ish snapshot of the mesh for this folder: is a server up,
 *  and what space/auth does the local `.cotal/` describe. */
export async function meshStatus(cwd: string): Promise<MeshStatus> {
  const server = DEFAULT_SERVER;
  const auth = loadSpaceAuth(authDir(cwd));
  return {
    reachable: await isReachable(server),
    server,
    space: auth?.space ?? DEFAULT_SPACE,
    auth: Boolean(auth),
  };
}

export interface MachineStatus {
  nats: "path" | "bundled" | "missing";
  claudePlugin: boolean;
  agents: { claude: boolean; codex: boolean; opencode: boolean };
}

/** Machine-level readiness: the once-per-machine setup pieces. */
export async function machineStatus(): Promise<MachineStatus> {
  let nats: MachineStatus["nats"] = "missing";
  try {
    nats = (await resolveNatsServer()).source;
  } catch {
    nats = "missing";
  }
  return {
    nats,
    claudePlugin: claudePluginInstalled(),
    agents: {
      claude: onPath("claude"),
      codex: onPath("codex"),
      opencode: onPath("opencode"),
    },
  };
}

export function onPath(bin: string): boolean {
  const r = spawnSync(bin, ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

function claudePluginInstalled(): boolean {
  if (!onPath("claude")) return false;
  const r = spawnSync("claude", ["plugin", "list"], { encoding: "utf8" });
  return r.status === 0 && /cotal@cotal-mesh/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

/** True once the machine-level setup has completed at least once. */
export function hasLocalMesh(cwd: string): boolean {
  return existsSync(resolve(cwd, ".cotal", "auth", "auth.json")) || existsSync(resolve(cwd, ".cotal", "nats"));
}
