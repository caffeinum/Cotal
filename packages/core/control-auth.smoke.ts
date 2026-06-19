/**
 * Control-plane authz smoke (P2a/P5) — the transport boundary, verified at runtime.
 *
 * Spins up its OWN JWT-auth nats-server and proves nats-server — not a handler — enforces the
 * privileged / self-service control-subject split:
 *   - non-capable agent: publish to ctl.self.<id> ALLOWED; publish to ctl.manager.<id> DENIED
 *   - spawn-capable agent (capabilities:["spawn"]): publish to ctl.manager.<id> ALLOWED
 * A denied publish rejects the request with an Authorization Violation; an allowed publish with
 * no manager running rejects with "No Responders" / timeout — the error type tells them apart.
 *
 * Run: pnpm smoke:control-auth
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  controlServiceSubject,
  CONTROL_PRIVILEGED,
  CONTROL_SELF_SERVICE,
} from "./src/index.js";

const PORT = 14226;
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const space = `ctl-auth-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-ctlauth-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

/** Try to publish `subject` as a request from a fresh connection using `creds`. The error type
 *  classifies the outcome: an Authorization Violation ⇒ the server DENIED the publish; anything
 *  else (No Responders / timeout) ⇒ the server accepted the publish (no handler replied). The
 *  `inboxPrefix` matches the agent cred's subscribe allow-list (`_INBOX_<id>.>`) so the request's
 *  reply-subscribe isn't the gating factor — the publish is. */
async function tryPublish(creds: string, subject: string, id: string): Promise<"allowed" | "denied"> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id}`,
    maxReconnectAttempts: 0,
  });
  try {
    await nc.request(subject, new Uint8Array(0), { timeout: 500 });
    return "allowed"; // a responder replied (no manager here, so this branch won't fire)
  } catch (e) {
    const msg = (e as Error).message.toLowerCase();
    if (msg.includes("authorization") || msg.includes("permission")) return "denied";
    return "allowed"; // No Responders / timeout ⇒ publish was accepted, just no reply
  } finally {
    await nc.drain().catch(() => {});
  }
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "manager");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  // Two agents: one without capabilities, one declaring spawn. The stub provisioner skips
  // durable pre-create (we only need the creds' publish allow-list, which is what nats-server
  // enforces).
  const noop = { provisionDmInbox: async () => {}, provisionTaskQueue: async () => {} };
  const plainId = newIdentity();
  const plainCreds = await provisionAgent(noop, auth, plainId, { channels: ["general"] });
  const capId = newIdentity();
  const capCreds = await provisionAgent(noop, auth, capId, { channels: ["general"], capabilities: ["spawn"] });

  const plainSelf = controlServiceSubject(space, CONTROL_SELF_SERVICE, plainId.id);
  const plainPriv = controlServiceSubject(space, CONTROL_PRIVILEGED, plainId.id);
  const capPriv = controlServiceSubject(space, CONTROL_PRIVILEGED, capId.id);

  console.log("non-capable agent:");
  check("publish ctl.self.<id> ALLOWED", await tryPublish(plainCreds, plainSelf, plainId.id) === "allowed");
  check("publish ctl.manager.<id> DENIED by nats-server", await tryPublish(plainCreds, plainPriv, plainId.id) === "denied");

  console.log("spawn-capable agent (capabilities:[spawn]):");
  check("publish ctl.manager.<id> ALLOWED", await tryPublish(capCreds, capPriv, capId.id) === "allowed");

  console.log(`\nCONTROL-AUTH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  srv.kill("SIGKILL");
  await wait(150);
  rmSync(dir, { recursive: true, force: true });
}
