import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  createSpaceAuth, serverConfig, mintCreds, newIdentity, isReachable,
  setupSpaceStreams, seedChannelRegistry, provisionAgent, CotalEndpoint,
  type CotalMessage, type Delivery, type MessageMeta,
} from "./src/index.js";

// Auth-mode end-to-end test of the channel-registry replay path: proves the SCOPED agent
// creds carry exactly the grants the mechanism needs — KV registry read (kv.get), chat
// durable create as DeliverPolicy.New, history backfill via Direct Get, and dynamic
// join/leave via consumers.update. No external server (spins its own JWT-auth nats-server).
const space = "authcheck", port = 4227, server = `nats://127.0.0.1:${port}`, storeDir = "/tmp/authcheck-nats", conf = "/tmp/authcheck.conf", log = "/tmp/authcheck.log";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

mkdirSync(storeDir, { recursive: true });
const auth = await createSpaceAuth(space);
writeFileSync(conf, serverConfig(auth, { port, storeDir }));
const fd = openSync(log, "w");
const child = spawn("nats-server", ["-c", conf], { stdio: ["ignore", fd, fd] });
process.on("exit", () => child.kill("SIGTERM"));

const mgrCreds = await mintCreds(auth, newIdentity(), "manager");
let up = false;
for (let i = 0; i < 50; i++) { if (await isReachable(server, { creds: mgrCreds })) { up = true; break; } await sleep(200); }
if (!up) throw new Error(`server not up:\n${readFileSync(log, "utf8")}`);

await setupSpaceStreams({ servers: server, space, creds: mgrCreds });
await seedChannelRegistry({ servers: server, space, creds: mgrCreds, file: { defaults: { replay: false }, channels: { log: { replay: true }, incident: { replay: true } } } });

const mgr = new CotalEndpoint({ space, servers: server, creds: mgrCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
mgr.on("error", (e) => console.log("mgr err:", e.message));
await mgr.start();
await mgr.multicast("log-hist", { channel: "log" });
await mgr.multicast("incident-hist", { channel: "incident" });
await sleep(300);

// scoped agent — the whole point: it holds ONLY the minted "agent" grants
const ident = newIdentity();
const agentCreds = await provisionAgent(mgr, auth, ident, { channels: ["log", "general", "incident"] });
const errors: string[] = [];
const got: { channel?: string; text: string; historical: boolean }[] = [];
const agent = new CotalEndpoint({ space, servers: server, creds: agentCreds, card: { name: "ag1", kind: "agent", id: ident.id }, channels: ["log", "general"] });
agent.on("error", (e: Error) => errors.push(e.message));
agent.on("message", (m: CotalMessage, d: Delivery, meta?: MessageMeta) => { got.push({ channel: m.channel, text: textOf(m), historical: meta?.historical ?? false }); d.ack(); });
await agent.start();
await sleep(500);

assert.deepEqual(errors, [], `no permission errors on start: ${errors.join("; ")}`);
assert.equal(got.filter((g) => g.channel === "log" && g.historical).length, 1, "backfilled log history via Direct Get (replay on)");

const jr = await agent.joinChannel("incident");
await sleep(400);
assert.deepEqual(jr, { joined: true, backfilled: 1 }, "dynamic join: consumers.update + Direct-Get backfill under scoped creds");
const lr = await agent.leaveChannel("incident");
assert.deepEqual(lr, { left: true }, "dynamic leave: consumers.update under scoped creds");
assert.deepEqual(errors, [], `still no permission errors after join/leave: ${errors.join("; ")}`);

console.log("AUTH GRANT CHECKS PASSED");
await agent.stop();
await mgr.stop();
child.kill("SIGTERM");
process.exit(0);
