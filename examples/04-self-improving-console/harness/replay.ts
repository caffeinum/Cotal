/**
 * harness/replay.ts <transcript> [space] [stepMs] — re-enact a recorded run on a LIVE mesh.
 *
 * Spins up one real endpoint per agent in the transcript (so they show in the roster), then
 * replays every presence change + message (multicast / peer DM / anycast) in order, looping.
 * Point `cotal console-ink --space <space>` at it to watch the swarm coordinate — no agents,
 * no cost, fully repeatable. The demo's "play button".
 *
 *   pnpm cotal up --open
 *   pnpm tsx examples/04-self-improving-console/harness/replay.ts \
 *     examples/04-self-improving-console/reference/run-5-green/transcript.jsonl demo-replay
 *   pnpm cotal console-ink --space demo-replay   # in a real terminal
 */
import { readFileSync } from "node:fs";
import { CotalEndpoint, DEFAULT_SERVER } from "@cotal/core";

const transcript = process.argv[2];
const space = process.argv[3] ?? "demo-replay";
const stepMs = Number(process.argv[4] ?? "650");
if (!transcript) {
  console.error("usage: replay.ts <transcript> [space] [stepMs]");
  process.exit(1);
}
const server = process.env.COTAL_SERVERS?.trim() || DEFAULT_SERVER;

type Rec = {
  type: string; ev?: string; mode?: string;
  name?: string; role?: string; status?: string; activity?: string;
  from?: string; fromId?: string; fromRole?: string; to?: string;
  channel?: string; toService?: string; text?: string;
};
const recs: Rec[] = readFileSync(transcript, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Infra endpoints aren't agents — don't give them a roster row.
const INFRA = new Set(["manager", "cli", "harness-observer", "console"]);

// Collect agents + their roles from presence and message records.
const roleOf = new Map<string, string>();
for (const r of recs) {
  const n = r.name ?? r.from;
  if (n && !INFRA.has(n)) roleOf.set(n, r.role ?? r.fromRole ?? roleOf.get(n) ?? n);
}

// One live endpoint per agent (registers presence → shows in the roster).
const eps = new Map<string, CotalEndpoint>();
for (const [name, role] of roleOf) {
  const ep = new CotalEndpoint({
    space, servers: server,
    card: { name, role, kind: "agent" },
    // consume:true so each agent's inbox JetStream stream exists — otherwise replayed
    // peer DMs (unicast) have no responder and fail.
    channels: ["team"], consume: true, registerPresence: true, watchPresence: false,
  });
  await ep.start();
  eps.set(name, ep);
}
console.log(`replay: ${eps.size} agents live in space "${space}" — ${[...eps.keys()].join(", ")}`);

// Map the recording's instance ids → the names we just spun up, so peer DMs resolve.
const idToName: Record<string, string> = {};
for (const r of recs) if (r.fromId && r.from) idToName[r.fromId] = r.from;
const newIdOf = (name?: string) => (name ? eps.get(name)?.card.id : undefined);

async function once() {
  for (const r of recs) {
    if (r.type === "presence" && (r.ev === "update" || r.ev === "join") && r.name && eps.has(r.name)) {
      await eps.get(r.name)!.setStatus((r.status as never) ?? "working");
      continue;
    }
    if (r.type !== "message" || !r.text) continue;
    const ep = r.from ? eps.get(r.from) : undefined;
    if (!ep) continue;
    try {
      if (r.mode === "chat") await ep.multicast(r.text, { channel: r.channel ?? "team" });
      else if (r.mode === "unicast") {
        const tid = newIdOf(idToName[r.to ?? ""]);
        if (tid) await ep.unicast(tid, r.text);
      } else if (r.mode === "anycast") await ep.anycast(r.toService ?? "team", r.text);
    } catch (e) {
      console.error(`  (skipped ${r.mode} from ${r.from}: ${(e as Error).message})`);
    }
    await sleep(stepMs);
  }
}

console.log("replay: looping the recorded session — Ctrl-C to stop. Open the console now:");
console.log(`  cotal console-ink --space ${space}`);
for (;;) {
  await once();
  await sleep(3000);
}
