/**
 * Standalone sidecar entry — bundled (esbuild → dist/standalone.cjs) and spawned by the Python
 * plugin when a user runs their OWN Hermes (`hermes plugins install cotal-ai/<repo> --enable`).
 *
 * In that mode there is no Cotal launcher: the enabled plugin sees COTAL_SPACE / COTAL_NAME /
 * COTAL_SERVERS but no bridge socket, so it derives the socket/file paths, sets them in the
 * sidecar's env, and spawns this. We just bring up the mesh + bridge + control + tools file and
 * stay alive for the gateway's lifetime — the gateway itself is already running around us, so
 * (unlike launch.ts) we never spawn a `hermes` child.
 */
import { startSidecar } from "./sidecar.js";

function log(msg: string): void {
  process.stderr.write(`[cotal-hermes/standalone] ${msg}\n`);
}

const sidecar = startSidecar();
log(`mesh sidecar up for ${sidecar.config.name} in space ${sidecar.config.space}`);

let stopping = false;
const stop = async (code: number): Promise<void> => {
  if (stopping) return;
  stopping = true;
  try {
    await sidecar.stop();
  } finally {
    process.exit(code);
  }
};

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
