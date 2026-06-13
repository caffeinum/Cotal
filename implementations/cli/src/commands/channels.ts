import { parseArgs } from "node:util";
import {
  authDir,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
  DEFAULT_SERVER,
  seedChannelRegistry,
  readChannelRegistry,
  effectiveReplay,
  type ChannelConfig,
  type ChannelDefaults,
  type ChannelRegistryFile,
} from "@cotal-ai/core";
import { resolveSpace } from "../lib/status.js";
import { c } from "../ui.js";

/**
 * `cotal channels` — inspect and mutate the per-space channel registry (replay policy,
 * description, instructions) while the mesh is up. Writes are privileged: in auth mode the
 * command mints ephemeral manager creds from `.cotal/auth`; in open mode it connects plainly.
 *
 *   cotal channels list
 *   cotal channels set <name> [--replay|--no-replay] [--desc <s>] [--instructions <s>]
 *   cotal channels default --replay|--no-replay
 */
export async function channels(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      space: { type: "string" },
      replay: { type: "boolean" },
      "no-replay": { type: "boolean" },
      window: { type: "string" }, // backfill window, e.g. 24h / 30m / 7d
      desc: { type: "string" },
      instructions: { type: "string" },
    },
  });
  const server = values.server ?? DEFAULT_SERVER;
  const space = values.space ?? resolveSpace(process.cwd());
  // Tri-state replay: --replay → true, --no-replay → false, neither → leave unchanged.
  const replay = values["no-replay"] ? false : values.replay ? true : undefined;
  const creds = await managerCreds(); // undefined ⇒ open mode

  switch (positionals[0]) {
    case "list": {
      printRegistry(await readChannelRegistry({ servers: server, space, creds }));
      return;
    }
    case "set": {
      const name = positionals[1];
      if (!name) return usage();
      const cfg: ChannelConfig = {};
      if (replay !== undefined) cfg.replay = replay;
      if (values.window !== undefined) cfg.replayWindow = values.window;
      if (values.desc !== undefined) cfg.description = values.desc;
      if (values.instructions !== undefined) cfg.instructions = values.instructions;
      if (!Object.keys(cfg).length) {
        console.error(c.red("nothing to set — pass --replay/--no-replay, --window, --desc, or --instructions"));
        process.exit(1);
      }
      await seedChannelRegistry({ servers: server, space, creds, file: { channels: { [name]: cfg } } });
      console.log(c.green(`✓ set #${name} in "${space}"`));
      return;
    }
    case "default": {
      const defaults: ChannelDefaults = {};
      if (replay !== undefined) defaults.replay = replay;
      if (values.window !== undefined) defaults.replayWindow = values.window;
      if (!Object.keys(defaults).length) {
        console.error(c.red("usage: cotal channels default [--replay|--no-replay] [--window <dur>]"));
        process.exit(1);
      }
      await seedChannelRegistry({ servers: server, space, creds, file: { defaults } });
      console.log(c.green(`✓ set space defaults in "${space}"`));
      return;
    }
    default:
      return usage();
  }
}

/** Privileged creds for a registry write: mint ephemeral manager creds from the space auth
 *  (auth mode), or undefined to connect open. Throws nothing — open mode is the no-auth dev mesh. */
async function managerCreds(): Promise<string | undefined> {
  const auth = loadSpaceAuth(authDir(process.cwd()));
  if (!auth) return undefined;
  return mintCreds(auth, newIdentity(), "manager");
}

function printRegistry(reg: ChannelRegistryFile): void {
  const def = reg.defaults?.replay;
  const dw = reg.defaults?.replayWindow;
  console.log(c.dim(`space default replay: ${def === undefined ? "true (built-in)" : def}${dw ? `, window=${dw}` : ""}`));
  const entries = Object.entries(reg.channels ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) {
    console.log(c.dim("no channel entries yet."));
    return;
  }
  for (const [name, cfg] of entries) {
    const effective = effectiveReplay(cfg, reg.defaults);
    const src = cfg.replay === undefined ? " (default)" : "";
    const win = cfg.replayWindow ?? reg.defaults?.replayWindow;
    console.log(`#${name}  replay=${effective}${src}${effective && win ? ` window=${win}` : ""}`);
    if (cfg.description) console.log(c.dim(`  ${cfg.description}`));
    if (cfg.instructions) console.log(c.dim(`  usage: ${cfg.instructions}`));
  }
}

function usage(): void {
  console.error(
    c.red(
      "usage: cotal channels <list | set <name> [--replay|--no-replay] [--window <dur>] [--desc <s>] [--instructions <s>] | default [--replay|--no-replay] [--window <dur>]> [--space <s>] [--server <url>]",
    ),
  );
  process.exit(1);
}
