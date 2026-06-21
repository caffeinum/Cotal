import { readFileSync } from "node:fs";
import {
  CotalEndpoint,
  isReachable,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  authDir,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
} from "@cotal-ai/core";
import { c } from "../ui.js";
import { cotalRoot } from "./paths.js";

/**
 * A one-shot, write-capable connection for the headless commands that touch the live mesh
 * (`dm`/`msg`/`ask`, and `personas list --running`). Resolve space/server/creds the same way
 * everywhere, open a transient endpoint that never joins the roster, do the one thing, stop.
 * Fail-loud throughout — an unreachable server or a space mismatch exits, never degrades.
 */

export interface ConnectValues {
  space?: string;
  server?: string;
  creds?: string;
}

/** Resolve where to connect and with what credentials: an explicit `--creds` wins; else self-mint
 *  from `.cotal/auth` so an AUTH-mode mesh admits us; else connect bare on an open mesh. Exits with
 *  a clear message on a `--space` that contradicts the local auth, or an unreachable server. */
export async function resolveConnect(
  values: ConnectValues,
): Promise<{ server: string; space: string; creds?: string }> {
  const server = values.server ?? DEFAULT_SERVER;
  let creds = values.creds ? readFileSync(values.creds, "utf8") : undefined;
  let space = values.space;
  if (!creds) {
    const auth = loadSpaceAuth(authDir(cotalRoot()));
    if (auth) {
      if (space && space !== auth.space) {
        console.error(
          c.red(`Auth here is for space "${auth.space}", not "${space}". Use --space ${auth.space} (or pass --creds).`),
        );
        process.exit(1);
      }
      space = auth.space;
      creds = await mintCreds(auth, newIdentity(), "manager");
    }
  }
  space = space ?? DEFAULT_SPACE;
  if (!(await isReachable(server, { creds }))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: cotal up`));
    process.exit(1);
  }
  return { server, space, creds };
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
