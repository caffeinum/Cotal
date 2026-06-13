import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import { DEFAULT_SERVER, isReachable, registry, type Connector } from "@cotal-ai/core";
import { cmux } from "@cotal-ai/cmux";
import { brand, brandBold, dim, ok, note, splash } from "../lib/theme.js";
import { LivePane } from "../lib/live-window.js";
import { runSteps, type Step } from "../lib/steps.js";
import { openSetupLog } from "../lib/setup-log.js";
import { resolveNatsServer } from "../lib/nats-bin.js";
import { isOnboarded, markOnboarded } from "../lib/onboard.js";
import { machineStatus, meshStatus, onPath } from "../lib/status.js";
import { startMeshDetached, up } from "./up.js";
import { spawn } from "./spawn.js";

const ONBOARD_VERSION = "1";
const README_URL = "https://github.com/Cotal-AI/Cotal/blob/main/README.md";
const CC_DOCS_URL = "https://github.com/Cotal-AI/Cotal/blob/main/docs/claude-code-integration.md";
const NATS_RELEASES_URL = "https://github.com/nats-io/nats-server/releases";

/** `cotal setup`: guided setup. First run (no `~/.cotal/onboarded.json`) gets the full
 *  narrated flow; later runs get a compact ensure+status. `--full` forces the full flow.
 *  Each failed step offers an interactive Claude handoff (COTAL_SKIP_ASSIST=1 disables). */
export async function setup(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { full: { type: "boolean" }, yes: { type: "boolean", short: "y" } },
  });
  // `--yes` (agents/CI) always runs the full flow non-interactively.
  if (!isOnboarded() || values.full || values.yes) await runFirstRun(Boolean(values.yes));
  else await runEnsure();
}

/** The full, narrated first-run experience. `yes` = non-interactive accept-all. */
async function runFirstRun(yes: boolean): Promise<void> {
  splash();
  p.intro(brandBold("Welcome to Cotal"));
  note(
    "Cotal is the open web for agents: they join a shared space, see who's around, and coordinate as peers instead of in silos. Build whole agent societies, even across different machines, on one open web. Let's set yours up.",
    "Give your agents a place to work together",
  );

  const log = openSetupLog(process.cwd());

  // Prerequisites + the local web (NATS). These never prompt.
  const core: Step[] = [
    {
      name: "node-version",
      title: "Check Node.js",
      explain: "Cotal needs Node 20 or newer.",
      context: [README_URL],
      async run() {
        const major = Number(process.versions.node.split(".")[0]);
        if (major < 20) throw new Error(`Node ${process.versions.node} is too old; Cotal needs Node >= 20`);
        return `Node ${process.versions.node}`;
      },
    },
    {
      name: "nats-binary",
      title: "Locate the NATS server",
      explain: "Cotal runs on NATS + JetStream, the wire your agents speak over.",
      context: [NATS_RELEASES_URL, README_URL],
      async run() {
        const r = await resolveNatsServer();
        return r.source === "path" ? "nats-server from PATH" : "bundled binary";
      },
    },
    {
      name: "start-mesh",
      title: "Start the web for agents",
      explain: "A local NATS + JetStream server you own; the web your agents join, in the background.",
      live: true,
      context: [resolve(".cotal/nats.log"), resolve(".cotal/auth/server.conf"), README_URL],
      async run() {
        if (await isReachable(DEFAULT_SERVER)) return `already running at ${DEFAULT_SERVER}`;
        const pane = new LivePane();
        pane.start("Booting nats-server");
        try {
          const { server } = await startMeshDetached({ onLine: (l) => pane.push(l) });
          return `running at ${server} (stop with: cotal down)`;
        } finally {
          pane.clear();
        }
      },
    },
  ];
  if (!(await runSteps(core, log, { yes }))) return abort();

  // Connectors: which agents should be able to join. Only Claude needs an install
  // (its wake channel binds to an installed plugin); Codex/OpenCode auto-wire at spawn.
  const found = { claude: onPath("claude"), codex: onPath("codex"), opencode: onPath("opencode") };
  const selected = await pickConnectors(found, yes);
  if (selected.has("claude")) {
    if (!found.claude) p.log.warn("claude isn't on PATH. Install it (https://claude.com/claude-code), then re-run setup.");
    else if (!(await runSteps([claudePluginStep()], log, { yes }))) return abort();
  }
  for (const name of ["codex", "opencode"] as const) {
    if (selected.has(name) && found[name]) {
      p.log.success(`${name} ready (auto-wired when you spawn it)`);
      log.line(`connector ${name}: ready (no install)`);
    }
  }

  // Two experts plus your own driving session, by default.
  mkdirSync(resolve(".cotal/agents"), { recursive: true });
  for (const [name, body] of Object.entries(DEMO_AGENTS)) {
    const path = resolve(".cotal/agents", `${name}.md`);
    if (!existsSync(path)) writeFileSync(path, body);
  }
  p.log.success("Added david (the engineer), sven (the guide), and your session (me); they join when you spawn them or open the demo");
  log.line("demo-agents: wrote david + sven + me");

  markOnboarded(ONBOARD_VERSION);
  note(
    [
      "Your agent has direct access to Cotal: spawn one and just talk to it (it can message peers, spawn teammates, and send feedback). Now any agent can join and collaborate. You can also use the CLI.",
      "",
      `${ok("✓")} drive a session     ${dim("cotal spawn me")}`,
      `${ok("✓")} ask the engineer    ${dim("cotal spawn david")}`,
      `${ok("✓")} ask the guide       ${dim("cotal spawn sven")}`,
      `${ok("✓")} watch in a browser  ${dim("cotal web --space demo")}`,
      `${ok("✓")} stop the web        ${dim("cotal down")}`,
      "",
      dim('Cotal not working? Tell your agent to give us feedback and it sends it for you (built-in cotal_feedback), or run cotal feedback "<msg>".'),
    ].join("\n"),
    "You're set",
  );

  if (!yes) await offerDemo(found.claude);
  p.outro(brand(yes ? "Cotal is ready." : "Happy meshing."));

  function abort() {
    p.outro(brand("Setup paused. Fix the step above and run `cotal setup` again."));
    process.exitCode = 1;
  }
}

/** Pick which agent connectors to set up. Detected ones are pre-checked (= the "all"
 *  default). Non-interactive / --yes selects all detected without prompting. */
async function pickConnectors(
  found: Record<"claude" | "codex" | "opencode", boolean>,
  yes: boolean,
): Promise<Set<string>> {
  const all = (["claude", "codex", "opencode"] as const).filter((n) => found[n]);
  if (yes || !process.stdin.isTTY) return new Set(all);
  const labels: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
  // Enter on the multiselect *is* the continue — no second confirm prompt (that extra step read
  // as a confusing separate tab).
  const picked = await p.multiselect({
    message: "Pick the agents to set up (space to toggle, enter to continue)",
    options: (["claude", "codex", "opencode"] as const).map((n) => ({
      value: n,
      label: labels[n],
      hint: !found[n] ? "not on PATH" : n === "claude" ? "installs a plugin" : "ready at spawn",
    })),
    initialValues: all,
    required: false,
  });
  return new Set(p.isCancel(picked) ? all : (picked as string[]));
}

/** The Claude Code plugin install, as a step (spinner + failure handling + handoff). */
function claudePluginStep(): Step {
  return {
    name: "claude-plugin",
    title: "Install the Claude Code plugin",
    explain: "Lets a Claude Code session join the web and wake on peer messages.",
    context: [join(homedir(), ".cotal/claude-plugin"), CC_DOCS_URL],
    async run() {
      installClaudePlugin();
      return "cotal@cotal-mesh (local scope)";
    },
  };
}

/** Finale: open a Claude the operator drives, with david and sven helping in the background.
 *  Inside cmux: background tabs for the experts + a focused console/driving pane. Otherwise:
 *  hand the terminal to the driving session. Offered (skipped under --yes). */
async function offerDemo(haveClaude: boolean): Promise<void> {
  const haveAgents = (["me", "david", "sven"] as const).every((n) => existsSync(resolve(".cotal/agents", `${n}.md`)));
  if (!haveClaude || !haveAgents || !process.stdin.isTTY) return;

  if (cmux.available()) {
    const go = await p.confirm({
      message: "Open a live demo? A Claude you drive, with david and sven helping in the background.",
      initialValue: true,
    });
    if (p.isCancel(go) || !go) return;
    openCmuxDemo(process.cwd());
    p.log.success("Demo open: drive the 'me' pane; david and sven are on the mesh in the background.");
    return;
  }

  const go = await p.confirm({
    message: "Spawn your driving session now? (open david and sven in other terminals to help)",
    initialValue: false,
  });
  if (!p.isCancel(go) && go) {
    p.outro(brand("Launching your session..."));
    await spawn(["me"]);
    process.exit(0);
  }
}

/** Greeting the driving session auto-submits on start (no apostrophes — it rides through
 *  cmux's `bash -lc '…'` quoting). Teaches the capabilities by telling, not by calling tools,
 *  so it does not depend on david/sven having joined yet when this first turn runs. */
const ME_GREETING =
  "Greet the operator in a few short lines. Open with one line on what Cotal is: an open space where AI agents join and work together as peers. Say you are their Cotal session and that david (the engineer) and sven (the guide) are on the mesh to help. Then tell them what you can do for them: message david or sven, spawn new teammates and despawn them when done, and send feedback. End by asking what they want to build.";

/** Open david and sven as background cmux tabs, then a focused workspace (console + the driving
 *  session "me"). The driving session consults david/sven over the mesh; nothing is foregrounded
 *  but your own pane. Each spawned `claude` pane presses Enter on its own cmux surface a few times
 *  to auto-accept the one-time dev-channels prompt, so david/sven/me actually join with no keypress. */
function openCmuxDemo(cwd: string): void {
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const enterLoop =
    '( [ -n "$CMUX_SURFACE_ID" ] && [ -n "$CMUX_BUNDLED_CLI_PATH" ] && ' +
    'for _ in 1 2 3 4 5; do sleep 1; "$CMUX_BUNDLED_CLI_PATH" send-key --surface "$CMUX_SURFACE_ID" enter >/dev/null 2>&1; done ) &';
  const term = (cmd: string) => ({
    pane: { surfaces: [{ type: "terminal", command: `bash -lc ${sq(`cd "${cwd}" && ${cmd}`)}` }] },
  });
  // A claude pane that auto-confirms the dev-channels prompt so the session joins the mesh.
  const confirmTerm = (cmd: string) => ({
    pane: { surfaces: [{ type: "terminal", command: `bash -lc ${sq(`cd "${cwd}" && ${enterLoop} ${cmd}`)}` }] },
  });
  cmux.openWorkspace("cotal-david", JSON.stringify(confirmTerm("cotal spawn david")), { focus: false });
  cmux.openWorkspace("cotal-sven", JSON.stringify(confirmTerm("cotal spawn sven")), { focus: false });
  const main = JSON.stringify({
    direction: "vertical",
    split: 0.34,
    children: [term("cotal console --space demo"), confirmTerm(`cotal spawn me --prompt ${sq(ME_GREETING)}`)],
  });
  cmux.openWorkspace("cotal-demo", main, { focus: true });
}

/** The compact repeat-run: quietly ensure the mesh is up here, then a one-glance card. */
async function runEnsure(): Promise<void> {
  let mesh = await meshStatus(process.cwd());
  if (!mesh.reachable) {
    const s = p.spinner();
    s.start("Starting the web for agents");
    try {
      await up(["--detach"]);
      s.stop("Web for agents started");
    } catch (e) {
      s.stop(`Couldn't start it: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    mesh = await meshStatus(process.cwd());
  }
  const m = await machineStatus();
  const line = (label: boolean, text: string) => `${label ? ok("✓") : dim("○")} ${text}`;
  note(
    [
      line(m.nats !== "missing", `NATS   ${dim(m.nats === "missing" ? "missing" : m.nats)}`),
      line(m.claudePlugin, `plugin ${dim(m.claudePlugin ? "installed" : "not installed")}`),
      line(mesh.reachable, `web    ${dim(`${mesh.server} · space ${mesh.space}`)}`),
      "",
      `drive it:  ${dim("cotal spawn me")}   ${dim("(or david / sven)")}`,
      `more:      ${dim('cotal web · cotal down · cotal feedback "<msg>" · cotal --help')}`,
    ].join("\n"),
    brandBold("cotal · ready"),
  );
}

/** Materialize a stable plugin marketplace under ~/.cotal/claude-plugin (surviving
 *  npx cache eviction) and install the plugin from it. The marketplace name must stay
 *  `cotal-mesh` (the connector's channel ref `plugin:cotal@cotal-mesh` depends on it). */
function installClaudePlugin(): void {
  const { pluginRoot } = registry.resolve<Connector>("connector", "claude");
  if (!pluginRoot) throw new Error('the registered "claude" connector ships no plugin assets');
  for (const f of ["dist/mcp.cjs", "dist/hook.cjs", ".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"]) {
    if (!existsSync(join(pluginRoot, f))) {
      throw new Error(
        `plugin asset missing: ${join(pluginRoot, f)} (in a dev clone, build it with: pnpm --filter @cotal-ai/connector-claude-code bundle)`,
      );
    }
  }

  const marketDir = join(homedir(), ".cotal", "claude-plugin");
  const pluginDir = join(marketDir, "cotal");
  for (const f of [".claude-plugin", ".mcp.json", "hooks", "dist/mcp.cjs", "dist/hook.cjs"]) {
    cpSync(join(pluginRoot, f), join(pluginDir, f), { recursive: true });
  }
  mkdirSync(join(marketDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(marketDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      {
        name: "cotal-mesh",
        description: "The Cotal mesh adapter for Claude Code: join a shared pub/sub space as a lateral peer.",
        owner: { name: "Cotal" },
        plugins: [{ name: "cotal", source: "./cotal" }],
      },
      null,
      2,
    ),
  );

  // `add` fails when the marketplace is already registered; refresh it instead.
  const add = claude("plugin", "marketplace", "add", marketDir);
  if (add.status !== 0) {
    const update = claude("plugin", "marketplace", "update", "cotal-mesh");
    if (update.status !== 0) throw new Error(`couldn't register the plugin marketplace:\n${add.output}\n${update.output}`);
  }
  const install = claude("plugin", "install", "cotal@cotal-mesh", "--scope", "local");
  if (install.status !== 0 && !/already installed/i.test(install.output)) {
    throw new Error(`plugin install failed:\n${install.output}`);
  }
  const list = claude("plugin", "list");
  if (!list.output.includes("cotal")) throw new Error(`plugin not visible in \`claude plugin list\`:\n${list.output}`);
}

function claude(...args: string[]): { status: number | null; output: string } {
  const r = spawnSync("claude", args, { encoding: "utf8" });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const DEMO_AGENTS: Record<string, string> = {
  david: `---
name: david
role: cotal-tech
description: "the engineer: how Cotal works (the wire, NATS, connectors, integration)."
tags: [cotal, technical, help]
channels: [general]
---

You are david, Cotal's engineer, live on the web for agents with the operator who just set Cotal
up. You help them set up and experiment. You know it cold: the wire contract (subjects, message
schemas, presence), NATS and JetStream underneath, the endpoint/connector model, the delivery
modes (multicast, unicast, anycast), and how to get any agent or framework onto the mesh. When
asked how something works or how to integrate it, answer concretely with the real mechanism,
commands, and config. If a question is really about use-cases or what to build, hand it to your
peer sven. Docs: https://github.com/Cotal-AI/Cotal
`,
  sven: `---
name: sven
role: cotal-guide
description: "the guide: what to build with Cotal (examples, setups, getting the most out of it)."
tags: [cotal, examples, help]
channels: [general]
---

You are sven, Cotal's guide, live on the web for agents with the operator who just set Cotal up.
You help them set up and experiment. You know the example projects and love dreaming up new
multi-agent setups: who should be on a space, how they'd coordinate, what's worth trying. When
someone wants ideas or a setup for their situation, riff with them and sketch it concretely. For
deep how-it-works or integration details, pull in your peer david. Docs: https://github.com/Cotal-AI/Cotal
`,
  me: `---
name: me
role: operator
description: "your own session on the Cotal mesh."
tags: [cotal]
channels: [general]
---

You are the operator's own session on the Cotal mesh: the agent they drive. Do what they ask and
use the mesh to get it done. Two experts are here to help you set up and experiment: david (the
engineer, how Cotal works) and sven (the guide, what to build). Reach them with cotal_dm or
cotal_anycast, grow the team with cotal_spawn, and if Cotal misbehaves send a report with
cotal_feedback. Docs: https://github.com/Cotal-AI/Cotal
`,
};
