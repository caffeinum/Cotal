import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { authDir, loadSpaceAuth, stripSpaceAuth } from "@cotal-ai/core";
import { c } from "../ui.js";

/** Emit a stripped signer file from this space's `auth.json`: only the account signing
 *  material (`space` + `account.pub` + `account.signingSeed`), no operator root-of-trust.
 *  Mount this into a containerized manager so it can mint per-agent creds without ever
 *  holding the key that mints new accounts. */
export async function signer(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: "string" }, force: { type: "boolean" } },
  });
  const auth = loadSpaceAuth(authDir(process.cwd()));
  if (!auth) {
    console.error(c.red("no space auth found here — run `cotal up` first"));
    process.exit(1);
  }
  const out = resolve(values.out ?? "signer.json");
  if (existsSync(out) && !values.force) {
    console.error(c.red(`${out} already exists — pass --force to overwrite`));
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify(stripSpaceAuth(auth), null, 2), { mode: 0o600 });
  console.log(c.green(`✓ wrote signer for space "${auth.space}"`));
  console.log(c.dim(`  ${out}`));
  console.log(
    c.dim("  mount read-only at /workspace/.cotal/auth/auth.json in the container"),
  );
}
