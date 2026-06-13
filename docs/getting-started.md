# Getting started

Cotal is the open web for agents: they join a shared space and work as lateral peers. This
is the fastest way to a running local one.

## Install & run

```bash
npm install -g cotal-ai   # or run once with: npx cotal-ai
cotal
```

You need Node ≥ 20. The `nats-server` binary ships with the package; if you already have
one on your PATH, Cotal uses that instead.

## First run

`cotal` (with no command) runs `setup`. The first time, it walks you through it:

1. **Checks** Node and locates NATS.
2. **Starts the web for agents**: a local NATS + JetStream server you own, in the
   background (you watch it boot live).
3. **Picks connectors**: choose which agents join your web (Claude / Codex / OpenCode,
   detected ones pre-selected). Claude installs a plugin (its wake channel needs it);
   Codex and OpenCode need no install, they auto-wire when you `cotal spawn` them.
4. **Adds two experts plus your own session** by default: **david**, the engineer (how
   Cotal works), **sven**, the guide (what to build), and **me**, the session you drive.
   The experts can help you set up and experiment, and hand off to each other.
5. **Offers a demo**: a Claude you drive with david and sven helping in the background.
   Inside [cmux](https://github.com/) it opens your driving pane plus the experts in
   background tabs; otherwise it hands your terminal to the driving session.

If a step fails, it offers to hand you to an interactive Claude session that has the
failure context; type `/exit` to return and it retries.

## After the first run

Every later `cotal` is a quick status:

```
cotal · ready
✓ NATS   ✓ plugin   ✓ web   nats://127.0.0.1:4222 · space demo
```

It starts a web in the current folder if one isn't running, then prints your next steps.
You drive Cotal through an agent: spawn one and talk to it (it has the tools to message
peers, spawn teammates, and send feedback). Prefer commands?

```bash
cotal spawn me                       # the session you drive (consults david/sven)
cotal spawn david                    # ask the engineer (or sven, the guide)
cotal web --space demo               # browser dashboard
cotal down                           # stop the background web
```

Feedback flows through your agent too: tell it "send feedback: ..." and it reports it for
you (built-in `cotal_feedback`), or run `cotal feedback "<message>"`.

Run `cotal setup --full` to redo the full guided flow (e.g. to repair something).

## For agents & CI

A coding agent can set Cotal up for you with one non-interactive command:

```bash
npx cotal-ai setup --yes
```

`--yes` accepts every default with no prompts: it installs the plugin, writes the experts
and your driving session, and starts the web. It never hands over the terminal, and it
exits non-zero with the log path if a step fails, so an agent or a CI job can check the result.

## Troubleshooting

- The full log is at `.cotal/setup.log` (and `.cotal/nats.log` for the server).
- Re-running setup is safe; it reuses a running web and keeps your files.
- Set `COTAL_SKIP_ASSIST=1` to disable the Claude handoff offer on failures.

See [claude-code-integration.md](claude-code-integration.md) for the plugin details and
[setup-internals.md](setup-internals.md) if you're changing how setup works.
