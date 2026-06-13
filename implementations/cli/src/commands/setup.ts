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

/** `cotal setup` — guided setup. First run (no `~/.cotal/onboarded.json`) gets the full
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
    "Cotal is the open standard for agent coordination — the web for agents. Any agent can join and talk to the others (or to you), as lateral peers. It's part of Web-A, the Web for Agents. Let's set up a local one.",
    "What is this",
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
        if (major < 20) throw new Error(`Node ${process.versions.node} is too old — Cotal needs Node >= 20`);
        return `Node ${process.versions.node}`;
      },
    },
    {
      name: "nats-binary",
      title: "Locate the NATS server",
      explain: "Cotal runs on NATS + JetStream — the wire your agents speak over.",
      context: [NATS_RELEASES_URL, README_URL],
      async run() {
        const r = await resolveNatsServer();
        return r.source === "path" ? "nats-server from PATH" : "bundled binary";
      },
    },
    {
      name: "start-mesh",
      title: "Start the web for agents",
      explain: "A local NATS + JetStream server you own — the web your agents join, in the background.",
      live: true,
      context: [resolve(".cotal/nats.log"), resolve(".cotal/auth/server.conf"), README_URL],
      async run() {
        if (await isReachable(DEFAULT_SERVER)) return `already running at ${DEFAULT_SERVER}`;
        const pane = new LivePane();
        pane.start("Booting nats-server");
        try {
          const { server } = await startMeshDetached({ onLine: (l) => pane.push(l) });
          return `running at ${server} — stop with: cotal down`;
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
    if (!found.claude) p.log.warn("claude isn't on PATH — install it (https://claude.com/claude-code), then re-run setup.");
    else if (!(await runSteps([claudePluginStep()], log, { yes }))) return abort();
  }
  for (const name of ["codex", "opencode"] as const) {
    if (selected.has(name) && found[name]) {
      p.log.success(`${name} — ready (auto-wired when you spawn it)`);
      log.line(`connector ${name}: ready (no install)`);
    }
  }

  // Two Cotal experts, by default: david (the engineer) and sven (the guide).
  mkdirSync(resolve(".cotal/agents"), { recursive: true });
  for (const [name, body] of Object.entries(DEMO_AGENTS)) {
    const path = resolve(".cotal/agents", `${name}.md`);
    if (!existsSync(path)) writeFileSync(path, body);
  }
  p.log.success("Added two Cotal experts — david (the engineer) and sven (the guide)");
  log.line("demo-agents: wrote david + sven");

  markOnboarded(ONBOARD_VERSION);
  note(
    [
      `${ok("✓")} meet david, the engineer  ${dim("cotal spawn david")}`,
      `${ok("✓")} meet sven, the guide      ${dim("cotal spawn sven")}`,
      `${ok("✓")} join the web yourself     ${dim("cotal join --space demo --name you")}`,
      `${ok("✓")} watch it in a browser     ${dim("cotal web --space demo")}`,
      `${ok("✓")} stop the web              ${dim("cotal down")}`,
      `${ok("✓")} send feedback             ${dim('ask any agent (they have cotal_feedback) — or cotal feedback "<msg>"')}`,
    ].join("\n"),
    "You're set — next steps",
  );

  if (!yes) await offerDemo(found.claude);
  p.outro(brand(yes ? "Cotal is ready." : "Happy meshing."));

  function abort() {
    p.outro(brand("Setup paused — fix the step above and run `cotal setup` again."));
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
  const picked = await p.multiselect({
    message: "Which agents should join your web?",
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

/** Finale: let the operator meet the two experts right away. Inside cmux, open a workspace
 *  with both experts in split panes + a live dashboard; otherwise hand the terminal to one. */
async function offerDemo(haveClaude: boolean): Promise<void> {
  const haveAgents = existsSync(resolve(".cotal/agents/david.md")) && existsSync(resolve(".cotal/agents/sven.md"));
  if (!haveClaude || !haveAgents || !process.stdin.isTTY) return;

  if (cmux.available()) {
    const go = await p.confirm({ message: "Open a live demo in cmux? (david + sven + a dashboard)", initialValue: true });
    if (p.isCancel(go) || !go) return;
    openCmuxDemo(process.cwd());
    p.log.success("Opened the cotal-demo workspace — david and sven are joining; ask them anything.");
    return;
  }

  const go = await p.confirm({ message: "Spawn an expert now to chat with (sven)?", initialValue: false });
  if (!p.isCancel(go) && go) {
    p.outro(brand("Launching sven…"));
    await spawn(["sven"]);
    process.exit(0);
  }
}

/** Open a cmux workspace: a dashboard pane on top, david | sven below — each a terminal
 *  running the foreground `cotal` command in this folder. */
function openCmuxDemo(cwd: string): void {
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const term = (cmd: string) => ({
    pane: { surfaces: [{ type: "terminal", command: `bash -lc ${sq(`cd "${cwd}" && ${cmd}`)}` }] },
  });
  const layout = JSON.stringify({
    direction: "vertical",
    split: 0.34,
    children: [
      term("cotal console --space demo"),
      { direction: "horizontal", split: 0.5, children: [term("cotal spawn david"), term("cotal spawn sven")] },
    ],
  });
  cmux.openWorkspace("cotal-demo", layout, { focus: true });
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
      s.stop(`Couldn't start it — ${(e as Error).message}`);
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
      dim('next:  cotal spawn david · join --name you · web · down · feedback "<msg>"'),
    ].join("\n"),
    brandBold("cotal · ready"),
  );
}

/** Materialize a stable plugin marketplace under ~/.cotal/claude-plugin (surviving
 *  npx cache eviction) and install the plugin from it. The marketplace name must stay
 *  `cotal-mesh` — the connector's channel ref `plugin:cotal@cotal-mesh` depends on it. */
function installClaudePlugin(): void {
  const { pluginRoot } = registry.resolve<Connector>("connector", "claude");
  if (!pluginRoot) throw new Error('the registered "claude" connector ships no plugin assets');
  for (const f of ["dist/mcp.cjs", "dist/hook.cjs", ".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"]) {
    if (!existsSync(join(pluginRoot, f))) {
      throw new Error(
        `plugin asset missing: ${join(pluginRoot, f)} — in a dev clone, build it with: pnpm --filter @cotal-ai/connector-claude-code bundle`,
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
        description: "The Cotal mesh adapter for Claude Code — join a shared pub/sub space as a lateral peer.",
        owner: { name: "Cotal" },
        plugins: [{ name: "cotal", source: "./cotal" }],
      },
      null,
      2,
    ),
  );

  // `add` fails when the marketplace is already registered — refresh it instead.
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
description: "the engineer — how Cotal works: the wire, NATS, connectors, and integration."
tags: [cotal, technical, help]
channels: [general]
---

You are david, Cotal's resident technical expert, live on the web for agents with the operator
who just set Cotal up. You know it cold: the wire contract (subjects, message schemas, presence),
NATS + JetStream underneath, the endpoint/connector model, the delivery modes (multicast /
unicast / anycast), and how to get any agent or framework onto the mesh. When asked how something
works or how to integrate it, answer concretely — the actual mechanism, commands, and config. If
a question is really about use-cases or what to build, hand it to your peer **sven**. You're here
so the operator can use Cotal correctly. Docs: https://github.com/Cotal-AI/Cotal
`,
  sven: `---
name: sven
role: cotal-guide
description: "the guide — what to build with Cotal: examples, setups, getting the most out of it."
tags: [cotal, examples, help]
channels: [general]
---

You are sven, Cotal's examples-and-experiments guide, live on the web for agents with the operator
who just set Cotal up. You know the example projects and love dreaming up new multi-agent setups:
who should be on a space, how they'd coordinate, what's worth trying. When someone wants ideas or
a setup for their situation, riff with them and sketch it concretely. For deep how-does-it-work or
integration details, pull in your peer **david**. You're here to help the operator get the most
out of Cotal. Docs: https://github.com/Cotal-AI/Cotal
`,
};
