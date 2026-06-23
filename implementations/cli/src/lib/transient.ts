import { readFileSync } from "node:fs";
import { CotalEndpoint, mintCreds, newIdentity } from "@cotal-ai/core";
import { c } from "../ui.js";
import { preflightOrExit, resolveTargetOrExit } from "./connect.js";

/**
 * A one-shot, write-capable connection for the headless commands that touch the live mesh
 * (`dm`/`msg`/`ask`, and `personas list --running`). Resolves WHICH mesh + creds via the shared
 * `resolveMeshTarget` (so these work from any directory, not just inside the project), opens a
 * transient endpoint that never joins the roster, does the one thing, stops. Fail-loud throughout —
 * an unresolved/ambiguous registry or an unreachable/auth-mismatched broker exits, never degrades.
 */

export interface ConnectValues {
  space?: string;
  server?: string;
  creds?: string;
}

/** Resolve where to connect and with what credentials: an explicit `--creds` wins; else self-mint
 *  from the resolved mesh's `.cotal/auth` so an AUTH-mode mesh admits us; else connect bare on an
 *  open mesh. Preflights the broker (one-sentence exit on unreachable / auth mismatch). */
export async function resolveConnect(
  values: ConnectValues,
): Promise<{ server: string; space: string; creds?: string }> {
  const target = await resolveTargetOrExit({ server: values.server, space: values.space });
  const creds = values.creds
    ? readFileSync(values.creds, "utf8")
    : target.auth
      ? await mintCreds(target.auth, newIdentity(), "manager")
      : undefined;
  await preflightOrExit(target, creds);
  return { server: target.server, space: target.space, creds };
}

/** Open a transient endpoint: it watches presence (so name→id resolution and the live roster work)
 *  but never registers itself, binds no inbox, and consumes no channels. The caller stops it. */
export async function openTransient(
  values: ConnectValues,
  name: string,
): Promise<{ ep: CotalEndpoint; space: string }> {
  const { server, space, creds } = await resolveConnect(values);
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    card: { name, kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  return { ep, space };
}
