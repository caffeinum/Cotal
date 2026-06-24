/**
 * Manager control-command server-resolution smoke — proves `cotal ps` / `start` / `stop` / `attach`
 * resolve their broker from the mesh registry (the same way the rest of the CLI does), instead of
 * silently assuming `DEFAULT_SERVER` (:4222). That silent default was the bug: `ps --space <mesh>`
 * for a mesh on another port hit :4222 and got an auth violation.
 *
 * No broker, no manager: it drives the pure `resolveManagerTarget` against a SANDBOXED registry
 * (`COTAL_HOME` → a tmpdir) and a cwd with no `.cotal` ancestor, so the result is environment-
 * independent. Run: pnpm smoke:server-resolution
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVER, recordMesh } from "@cotal-ai/core";
import { resolveManagerTarget } from "../src/commands.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — got ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

// Sandbox the registry so we never touch the real ~/.cotal, and run from a dir with no `.cotal`
// up-tree so the bare (no-flags) case falls through to the registry rather than a local project.
const home = mkdtempSync(join(tmpdir(), "cotal-ps-resolve-home-"));
const cwd = mkdtempSync(join(tmpdir(), "cotal-ps-resolve-cwd-"));
const projectRoot = mkdtempSync(join(tmpdir(), "cotal-ps-resolve-root-"));
process.env.COTAL_HOME = home;
process.chdir(cwd);

const OTHER = "nats://127.0.0.1:14999";
const OVERRIDE = "nats://127.0.0.1:7777";

// An OPEN mesh registered on a NON-default port (open ⇒ no creds to mint — keeps the smoke broker-free).
recordMesh({ space: "team-alpha", server: OTHER, root: projectRoot, mode: "open", ts: new Date(0).toISOString() });

// 1. The fix: `--space` resolves the registry-recorded broker, NOT DEFAULT_SERVER.
const bySpace = await resolveManagerTarget({ space: "team-alpha" });
check("--space resolves the registry-recorded broker", bySpace.server === OTHER, bySpace.server);
check("did NOT fall back to DEFAULT_SERVER (:4222)", bySpace.server !== DEFAULT_SERVER, bySpace.server);
check("open mesh ⇒ no creds minted", bySpace.creds === undefined, bySpace.creds);
check("resolved space is preserved", bySpace.space === "team-alpha", bySpace.space);

// 2. Bare (no flags) with a single registered mesh → still resolves that mesh's broker.
const bare = await resolveManagerTarget({});
check("bare resolves the single registered mesh", bare.server === OTHER, bare.server);

// 3. `--server` stays an explicit override, even when `--space` is registered elsewhere.
const override = await resolveManagerTarget({ space: "team-alpha", server: OVERRIDE });
check("--server overrides the registry", override.server === OVERRIDE, override.server);

// 4. Raw OPEN off-registry escape hatch (parity with connectOrExit): `--server` + an UNregistered
//    `--space` → a bare connection, no registry lookup, no creds.
const rawOpen = await resolveManagerTarget({ server: OTHER, space: "not-registered" });
check(
  "--server + unregistered --space → raw open (no creds, no registry)",
  rawOpen.server === OTHER && rawOpen.space === "not-registered" && rawOpen.creds === undefined,
  rawOpen,
);

rmSync(home, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });
rmSync(projectRoot, { recursive: true, force: true });
console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
process.exit(failures ? 1 : 0);
