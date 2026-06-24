/**
 * Pure-function smoke for the mesh-manifest pipeline (no NATS, no fs) — run with: pnpm -r test
 * Asserts the deterministic parse → schema → normalize/invert → semantic rules in src/lib/manifest.
 */
import assert from "node:assert/strict";
import { resolveManifest } from "../src/lib/manifest/resolve.js";
import { ManifestError } from "../src/lib/manifest/errors.js";
import type { ResolvedManifest } from "../src/lib/manifest/model.js";

const PATH = "/tmp/cotal.yaml";
const ok = (src: string): ResolvedManifest => resolveManifest(src, PATH);
function fails(src: string, needle: string): void {
  assert.throws(
    () => resolveManifest(src, PATH),
    (e: unknown) => e instanceof ManifestError && e.message.includes(needle),
    `expected a ManifestError containing ${JSON.stringify(needle)}`,
  );
}

const HEAD = `apiVersion: cotal/v1
kind: Mesh
space: experiment-1
`;

// --- happy path: inversion + allowSubscribe defaulting -----------------------------------------
{
  const m = ok(`${HEAD}
agents:
  planner: ./agents/planner.md
  builder:
    persona: ./agents/builder.md
    model: sonnet
  scout:
    model: opus
    instructions: research the web
channels:
  general:
    subscribe: [planner, builder, scout]
    allowPublish: [planner, builder, scout]
  review:
    description: Design critique.
    subscribe: [planner, scout]
    allowSubscribe: [planner, builder, scout]
    allowPublish: [planner, scout]
`);
  assert.equal(m.space, "experiment-1");
  assert.equal(m.personaPermissions, "reject"); // default

  const planner = m.agents.find((a) => a.name === "planner")!;
  const builder = m.agents.find((a) => a.name === "builder")!;
  const scout = m.agents.find((a) => a.name === "scout")!;

  // string form → persona path resolved relative to the manifest dir; no overrides.
  assert.equal(planner.persona, "/tmp/agents/planner.md");
  assert.equal(planner.model, undefined);
  // override form → persona + model.
  assert.equal(builder.persona, "/tmp/agents/builder.md");
  assert.equal(builder.model, "sonnet");
  // inline form → no persona, body + model carried.
  assert.equal(scout.persona, undefined);
  assert.equal(scout.model, "opus");
  assert.equal(scout.instructions, "research the web");

  // Inversion: per-agent ACLs reconstructed from channel membership.
  assert.deepEqual(planner.policy.subscribe.sort(), ["general", "review"]);
  assert.deepEqual(planner.policy.allowPublish.sort(), ["general", "review"]);
  // builder: in general's subscribe, but only review's allowSubscribe (may read, not auto-subscribed).
  assert.deepEqual(builder.policy.subscribe, ["general"]);
  assert.deepEqual(builder.policy.allowSubscribe.sort(), ["general", "review"]);
  assert.deepEqual(builder.policy.allowPublish, ["general"]);
  assert.deepEqual(scout.policy.subscribe.sort(), ["general", "review"]);

  // Channel: allowSubscribe omitted on general ⇒ defaults to subscribe.
  const general = m.channels.find((c) => c.name === "general")!;
  assert.deepEqual(general.allowSubscribe.sort(), ["builder", "planner", "scout"]);
  const review = m.channels.find((c) => c.name === "review")!;
  assert.deepEqual(review.allowSubscribe.sort(), ["builder", "planner", "scout"]);
  assert.equal(review.description, "Design critique.");
}

// --- per-agent personaPermissions override -----------------------------------------------------
{
  const m = ok(`${HEAD}personaPermissions: include
agents:
  a: ./a.md
  b:
    persona: ./b.md
    personaPermissions: reject
channels:
  general:
    subscribe: [a, b]
`);
  assert.equal(m.personaPermissions, "include");
  assert.equal(m.agents.find((a) => a.name === "a")!.personaPermissions, "include");
  assert.equal(m.agents.find((a) => a.name === "b")!.personaPermissions, "reject");
}

// --- semantic errors ---------------------------------------------------------------------------

// allowSubscribe ⊉ subscribe
fails(`${HEAD}
agents: { a: ./a.md, b: ./b.md }
channels:
  general:
    subscribe: [a, b]
    allowSubscribe: [a]
`, "not in allowSubscribe");

// name referenced in a channel but absent from agents:
fails(`${HEAD}
agents: { a: ./a.md }
channels:
  general:
    subscribe: [a, ghost]
`, "ghost\" is not declared in agents:");

// wildcard channel name
fails(`${HEAD}
agents: { a: ./a.md }
channels:
  "team.>":
    subscribe: [a]
`, "must be concrete");

// --- schema errors -----------------------------------------------------------------------------

// unknown top-level key (strict)
fails(`${HEAD}
bogus: true
agents: { a: ./a.md }
channels: { general: { subscribe: [a] } }
`, "Unrecognized key");

// unknown channel key (strict)
fails(`${HEAD}
agents: { a: ./a.md }
channels: { general: { subscribe: [a], canPublish: [a] } }
`, "Unrecognized key");

// inline agent with neither model nor instructions
fails(`${HEAD}
agents: { a: { description: just a blurb } }
channels: { general: { subscribe: [a] } }
`, "inline agent");

// wrong apiVersion
fails(`apiVersion: cotal/v2
kind: Mesh
space: x
agents: { a: ./a.md }
channels: { general: { subscribe: [a] } }
`, "apiVersion");

// spaces: targeted message
fails(`apiVersion: cotal/v1
kind: Mesh
spaces: [a, b]
agents: { a: ./a.md }
channels: { general: { subscribe: [a] } }
`, "single-space");

// duplicate map key (yaml unique-keys)
fails(`${HEAD}
agents: { a: ./a.md }
channels:
  general: { subscribe: [a] }
  general: { subscribe: [a] }
`, "");

console.log("manifest pipeline smoke ok");
