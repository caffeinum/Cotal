---
"cotal-ai": minor
"@cotal-ai/cli": minor
"@cotal-ai/core": minor
"@cotal-ai/connector-claude-code": patch
---

Add `cotal-ai` — a guided, two-tier setup. The composition root (`bin/`) ships as the
publishable `cotal-ai` package, so `npm i -g cotal-ai` / `npx cotal-ai <cmd>` works (bare
`cotal` runs `setup`). The **first run** is a narrated, branded flow (`@clack/prompts` UI,
wordmark splash, a live pane that streams the mesh booting) that checks prerequisites, locates
the NATS server (bundled platform binary via `@eplightning/nats-server-*`, or one already on
PATH), then a **connector picker** (Claude / Codex / OpenCode — only Claude installs a plugin;
Codex/OpenCode auto-wire at spawn), and writes two default Cotal experts you can chat with —
**david — the engineer** (how it works) and **sven — the guide** (what to build). The finale is
cmux-aware: inside cmux it opens both experts in split panes with a live dashboard, otherwise it
hands the terminal to one. (It's "the web for agents".) **Later runs** are a compact ensure+status card; `cotal setup --full` forces the full flow,
and `cotal setup --yes` runs it non-interactively (agents/CI) — installs the plugin, writes the
experts, starts the web, and exits non-zero with the log path on failure. Each failed interactive
step offers a Claude handoff (skippable with `COTAL_SKIP_ASSIST=1`) that carries the failure
context and resumes setup on `/exit`. Adds `cotal up --detach` + `cotal down` for a
background mesh, a `Connector.pluginRoot` contract so consumers can find a connector's installable
plugin assets without importing the extension, and ships the Claude Code connector's plugin
manifest files in its published package. When run via `npx` without a global `cotal`, setup offers
to `npm i -g cotal-ai` (default yes; non-interactive takes the default), best-effort — and the
status-card hints render the right prefix (`cotal` / `npx cotal-ai` / `pnpm cotal`) for how you ran it.
