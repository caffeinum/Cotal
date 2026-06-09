/**
 * Composition root for the `cotal` operator CLI. Importing an implementation
 * self-registers its commands into the shared registry — base mesh commands plus
 * `spawn`/`console` (@cotal/cli) and the manager's control plane + daemon runners
 * (@cotal/manager). The root just picks which surfaces to pull in; `runCli` resolves
 * whatever registered. A new surface (a Codex control client …) is one more import line.
 */
import { runCli } from "@cotal/cli"; // self-registers up / join / watch / spawn / console
import "@cotal/manager"; // self-registers supervise / cmux / start / stop / ps / attach
import "@cotal/connector-claude-code"; // registers the `claude` connector that spawn / start resolve
import "@cotal/connector-codex"; // registers the `codex` connector (pull-only MCP adapter)
import "@cotal/cmux"; // opt into the cmux integration — registers the `cmux` runtime
import { claudeConnector } from "@cotal/connector-claude-code";
import { registry } from "@cotal/core";

// The manager's default agent type is "cotal"; make it a real Claude coder so a bare
// cotal_spawn / `cotal start --name x` (no --agent) brings up a Claude Code session.
registry.register({ ...claudeConnector, name: "cotal" });

await runCli(registry, process.argv.slice(2));
