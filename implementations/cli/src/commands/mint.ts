import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  authDir,
  agentFilePath,
  loadAgentFile,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
  type Profile,
} from "@cotal-ai/core";
import { cotalRoot } from "../lib/paths.js";
import { c } from "../ui.js";

/** Out-of-band cred minting: generate an identity, sign a profile-scoped user JWT with the
 *  space's account signing key, and write a creds file the agent/observer loads to join. */
export async function mint(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { profile: { type: "string" }, out: { type: "string" } },
  });
  const name = positionals[0];
  if (!name) {
    console.error(c.red("usage: cotal mint <name> --profile <agent|observer|admin> [--out <path>]"));
    process.exit(1);
  }
  const profile = (values.profile ?? "agent") as Profile;
  if (profile !== "agent" && profile !== "observer" && profile !== "admin") {
    console.error(c.red(`unknown profile "${profile}" — expected agent, observer, or admin`));
    process.exit(1);
  }
  const dir = authDir(cotalRoot());
  const auth = loadSpaceAuth(dir);
  if (!auth) {
    console.error(c.red("no space auth found here — run `cotal up` first"));
    process.exit(1);
  }
  // For agents, derive the publish allow-list AND role from the agent file if one exists
  // (publish: ?? channels: for channels; role scopes the TASK-queue consumer to svc_<role>).
  // observers/managers ignore both.
  let channels: string[] | undefined;
  let role: string | undefined;
  if (profile === "agent") {
    const f = agentFilePath(cotalRoot(), name);
    if (existsSync(f)) {
      const def = loadAgentFile(f);
      channels = def.publish ?? def.channels;
      role = def.role;
    }
  }
  const identity = newIdentity();
  const creds = await mintCreds(auth, identity, profile, { channels, role });
  const out = resolve(values.out ?? join(dir, "creds", `${name}.creds`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, creds, { mode: 0o600 });
  console.log(c.green(`✓ minted ${profile} creds for "${name}"`));
  console.log(c.dim(`  id:    ${identity.id}`));
  console.log(c.dim(`  creds: ${out}`));
}
