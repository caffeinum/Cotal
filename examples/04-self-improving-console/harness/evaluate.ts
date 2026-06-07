/**
 * harness/evaluate.ts <rundir> — judge one swarm run.
 *
 * GREEN = build OK (the worktree's @cotal/cli typechecks) AND ≥1 genuine peer-to-peer
 * exchange (a unicast DM whose sender is a worker and recipient is not the orchestrator).
 *
 * Prints a verdict JSON to stdout (the loop appends it to ITERATIONS.md).
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const rundir = process.argv[2] || process.cwd();
const transcriptPath = `${rundir}/transcript.jsonl`;

type Rec = {
  type: string;
  mode?: string;
  from?: string;
  to?: string;
  channel?: string;
  text?: string;
};

const recs: Rec[] = existsSync(transcriptPath)
  ? readFileSync(transcriptPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Rec;
        } catch {
          return null;
        }
      })
      .filter((r): r is Rec => r !== null)
  : [];

const msgs = recs.filter((r) => r.type === "message");

// --- build check (typecheck the cli IN the worktree) ---
// Invoke the worktree's own tsc directly (not `pnpm --filter`, which exits 0 when it
// matches no project — a false green if the worktree install failed).
let buildOk = false;
let buildErr = "";
try {
  execSync("./node_modules/.bin/tsc -p implementations/cli/tsconfig.json --noEmit", {
    cwd: rundir,
    stdio: "pipe",
  });
  buildOk = true;
} catch (e) {
  const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
  buildErr = (
    (err.stdout?.toString() ?? "") +
    (err.stderr?.toString() ?? "") +
    (err.message ?? "")
  ).trim();
}

// --- comms analysis ---
const ORCH = "orchestrator";
const isWorker = (n?: string): boolean => !!n && n !== ORCH && n !== "harness-observer";

const dms = msgs.filter((m) => m.mode === "unicast");
const chats = msgs.filter((m) => m.mode === "chat");
// peer-to-peer DM: a worker initiates a DM to someone other than the orchestrator.
const peerDms = dms.filter((m) => isWorker(m.from) && m.to !== ORCH);
const peerPairs = [...new Set(peerDms.map((m) => `${m.from}->${m.to ?? "?"}`))];
const complete = msgs.some((m) => (m.text ?? "").includes("DEMO COMPLETE"));
const peerToPeer = peerDms.length >= 1;
const green = buildOk && peerToPeer;

const failureMode = !msgs.length
  ? "no-traffic — agents never communicated (spawn/wake/TTY problem)"
  : !peerToPeer
    ? "star-topology — all comms via orchestrator, no peer-to-peer DMs"
    : !buildOk
      ? "build-failed — typecheck red"
      : "ok";

const verdict = {
  green,
  buildOk,
  peerToPeer,
  complete,
  counts: {
    messages: msgs.length,
    chats: chats.length,
    dms: dms.length,
    peerDms: peerDms.length,
  },
  peerPairs,
  failureMode,
  buildErr: buildOk ? "" : buildErr.split("\n").slice(-12).join("\n"),
};

console.log(JSON.stringify(verdict, null, 2));
