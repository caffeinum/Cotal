import { parseArgs } from "node:util";
import {
  authDir,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  purgeSpaceStreams,
} from "@cotal-ai/core";
import { c } from "../ui.js";

/**
 * `cotal purge` — wipe a space's channel history (the CHAT stream; `--dm` for the DM
 * inboxes too). Streams and consumers stay in place: live agents keep working, late
 * joiners just backfill nothing. Privileged: in auth mode the command mints ephemeral
 * manager creds from `.cotal/auth`; in open mode it connects plainly.
 *
 *   cotal purge [--dm] [--space <s>] [--server <url>]
 */
export async function purge(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      space: { type: "string" },
      dm: { type: "boolean" },
    },
  });
  const server = values.server ?? DEFAULT_SERVER;
  const space = values.space ?? DEFAULT_SPACE;
  const auth = loadSpaceAuth(authDir(process.cwd()));
  const creds = auth ? await mintCreds(auth, newIdentity(), "manager") : undefined;
  const res = await purgeSpaceStreams({ servers: server, space, creds, dm: values.dm });
  console.log(c.green(`✓ purged ${res.chat} channel message${res.chat === 1 ? "" : "s"} in "${space}"`));
  if (res.dm !== undefined)
    console.log(c.green(`✓ purged ${res.dm} DM message${res.dm === 1 ? "" : "s"}`));
}
