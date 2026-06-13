#!/usr/bin/env node
/**
 * Composition root for the `cotal` operator CLI, published as `cotal-ai`. Importing an
 * implementation self-registers its commands into the shared registry — base mesh commands
 * plus `spawn`/`console` (@cotal-ai/cli) and the manager's control plane (@cotal-ai/manager).
 * The root just picks which surfaces to pull in; `runCli` resolves whatever
 * registered. A new surface (a Codex control client …) is one more import line.
 */
import { runCli } from "@cotal-ai/cli"; // self-registers up / join / watch / spawn / console / setup
import "@cotal-ai/manager"; // self-registers start / stop / ps / attach
import "@cotal-ai/connector-claude-code"; // registers the `claude` connector that spawn / start resolve
import "@cotal-ai/connector-codex"; // registers the `codex` connector (pull-only MCP adapter)
import "@cotal-ai/connector-opencode"; // registers the `opencode` connector (native in-process plugin)
import { registry } from "@cotal-ai/core";

// Bare `npx cotal-ai` = guided first-run setup; any argument dispatches as usual.
const argv = process.argv.length > 2 ? process.argv.slice(2) : ["setup"];
await runCli(registry, argv);
