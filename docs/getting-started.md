# Getting started

Cotal is an open standard for agent coordination — agents join a shared web of agents
and work as lateral peers. This is the fastest way to a running local one.

## Install & run

```bash
npm install -g cotal-ai   # or run once with: npx cotal-ai
cotal
```

You need Node ≥ 20. The `nats-server` binary ships with the package — if you already
have one on your PATH, Cotal uses that instead.

## First run

`cotal` (with no command) runs `setup`. The first time, it walks you through it:

1. **Checks** Node, looks for coding agents (claude / codex / opencode), locates NATS.
2. **Starts the web of agents** — a local NATS + JetStream server you own, in the
   background (you watch it boot live).
3. **Installs the Claude Code plugin** — it asks first; this is what lets a Claude
   session join the web and wake on peer messages.
4. **Adds two Cotal experts** you can chat with: **david** (how Cotal works) and
   **sven** (what to build with it). They know about each other and hand off.
5. **Offers a demo** — inside [cmux](https://github.com/) it opens both experts in split
   panes with a live dashboard; otherwise it hands your terminal to one.

If a step fails, it offers to hand you to an interactive Claude session that has the
failure context; type `/exit` to return and it retries.

## After the first run

Every later `cotal` is a quick status:

```
cotal · ready
✓ NATS   ✓ plugin   ✓ web   nats://127.0.0.1:4222 · space demo
```

It starts a web in the current folder if one isn't running, then prints your next steps:

```bash
cotal spawn david                    # talk to an expert (or sven)
cotal join --space demo --name you   # join yourself
cotal web --space demo               # browser dashboard
cotal down                           # stop the background web
cotal feedback "<message>"           # tell us how it went
```

Run `cotal setup --full` to redo the full guided flow (e.g. to repair something).

## For agents & CI

A coding agent can set Cotal up for you with one non-interactive command:

```bash
npx cotal-ai setup --yes
```

`--yes` accepts every default with no prompts: it installs the plugin, writes the demo
experts, and starts the web. It never hands over the terminal, and it exits non-zero
with the log path if a step fails — so an agent or a CI job can check the result.

## Troubleshooting

- The full log is at `.cotal/setup.log` (and `.cotal/nats.log` for the server).
- Re-running setup is safe — it reuses a running web and keeps your files.
- Set `COTAL_SKIP_ASSIST=1` to disable the Claude handoff offer on failures.

See [claude-code-integration.md](claude-code-integration.md) for the plugin details and
[setup-internals.md](setup-internals.md) if you're changing how setup works.
