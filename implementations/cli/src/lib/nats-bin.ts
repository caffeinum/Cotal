import { spawnSync } from "node:child_process";

/** Platform-package prefix the bundled binary ships under. Swapping providers
 *  (e.g. to our own @cotal-ai/nats-server-*) is a one-line change here. */
const BUNDLED_PKG_PREFIX = "@eplightning/nats-server";

/** Resolve the nats-server binary: PATH first (an operator-installed server always
 *  wins), then the bundled platform package. Throws when neither is available. */
export async function resolveNatsServer(): Promise<{ bin: string; source: "path" | "bundled" }> {
  const onPath = spawnSync("nats-server", ["--version"], { stdio: "ignore" });
  if (!onPath.error && onPath.status === 0) return { bin: "nats-server", source: "path" };

  const pkg = `${BUNDLED_PKG_PREFIX}-${process.platform}-${process.arch}`;
  try {
    const mod = (await import(pkg)) as { getBinaryPath(): string };
    return { bin: mod.getBinaryPath(), source: "bundled" };
  } catch {
    throw new Error(
      `nats-server not found on PATH and no bundled binary for ${process.platform}/${process.arch} (${pkg}). ` +
        "Install nats-server (https://github.com/nats-io/nats-server/releases) and put it on PATH.",
    );
  }
}
