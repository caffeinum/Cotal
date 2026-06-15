import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import {
  CotalEndpoint,
  isReachable,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  authDir,
  loadSpaceAuth,
  type Presence,
} from "@cotal-ai/core";
import { c } from "../ui.js";

/** How long to wait for the presence roster to replay before giving up on a name lookup.
 *  The observer's KV watch fills the roster asynchronously after start(); a target that's
 *  truly present shows up well within this window. */
const ROSTER_WAIT_MS = 3000;

/** Resolve an agent name → its present instance id off the roster, waiting briefly for the
 *  presence KV to replay. Case-insensitive, prefers a live (non-offline) peer. */
async function resolveTarget(ep: CotalEndpoint, name: string): Promise<Presence | undefined> {
  const t = name.toLowerCase();
  const find = (): Presence | undefined => {
    const roster = ep.getRoster();
    const present = roster.filter((p) => p.status !== "offline");
    return (
      present.find((p) => p.card.name.toLowerCase() === t) ??
      roster.find((p) => p.card.name.toLowerCase() === t)
    );
  };
  const deadline = Date.now() + ROSTER_WAIT_MS;
  for (;;) {
    const hit = find();
    if (hit) return hit;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * `cotal dm <name> "<message>"` — an operator sends a mesh DM to a running agent WITHOUT
 * attaching to it or proxying through a `me` agent. It connects to NATS like `console`/`watch`
 * (a presence-watching, off-roster client), resolves the target name → instance id off the
 * roster, and publishes a normal unicast DM — the exact envelope/subject the agent-only
 * `cotal_dm` tool produces, so the receiver's connector parses it as a regular DM.
 *
 * Open mesh: connect bare. Auth mode: a DM is a write, and the self-mintable `observer` cred is
 * read-only — so the operator must pass `--creds <admin.creds>` (mint with `cotal mint <n>
 * --profile admin`). We fail loudly rather than silently picking creds that can't publish.
 */
export async function dm(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: "string" },
      server: { type: "string" },
      creds: { type: "string" },
    },
  });

  const name = positionals[0];
  const text = positionals[1];
  if (!name || !text) {
    console.error(c.red('usage: cotal dm <name> "<message>" [--space <s>] [--server <url>] [--creds <path>]'));
    process.exit(1);
  }

  const server = values.server ?? DEFAULT_SERVER;
  let creds = values.creds ? readFileSync(values.creds, "utf8") : undefined;
  let space = values.space;

  // Auth mode (.cotal/auth present): publishing a DM needs write perms, which only admin/agent
  // creds carry — the self-mintable observer cred can't publish. Require an explicit admin cred.
  if (!creds) {
    const auth = loadSpaceAuth(authDir(process.cwd()));
    if (auth) {
      if (space && space !== auth.space) {
        console.error(
          c.red(`Auth here is for space "${auth.space}", not "${space}". Use --space ${auth.space}.`),
        );
        process.exit(1);
      }
      space = auth.space;
      console.error(
        c.red(
          "This is an auth-mode space — sending a DM needs admin creds. " +
            "Mint one: `cotal mint operator --profile admin`, then pass `--creds <path>`.",
        ),
      );
      process.exit(1);
    }
  }

  const s = space ?? DEFAULT_SPACE;
  if (!(await isReachable(server, { creds }))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: cotal up`));
    process.exit(1);
  }

  // Operator identity for the DM's `from` — off the roster (invisible), like the console's sender.
  const operator = (() => {
    try {
      return userInfo().username || "operator";
    } catch {
      return "operator";
    }
  })();

  const ep = new CotalEndpoint({
    space: s,
    servers: server,
    creds,
    channels: [],
    consume: false, // request/publish only — binds no durables
    registerPresence: false, // invisible on the roster; the DM still carries `operator` as `from`
    watchPresence: true, // need the roster to resolve name → instance id
    card: { name: operator, kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  try {
    const target = await resolveTarget(ep, name);
    if (!target) {
      console.error(c.red(`✗ no agent "${name}" present in space "${s}"`));
      process.exit(1);
    }
    await ep.unicast(target.card.id, text);
    console.log(c.green(`✓ DM → ${c.bold(target.card.name)}`) + c.dim(` (${target.card.id})`));
  } finally {
    await ep.stop();
  }
}
