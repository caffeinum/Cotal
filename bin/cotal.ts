/**
 * Composition root for the `cotal` operator CLI. Importing an implementation
 * self-registers its commands into the shared registry — base mesh commands plus
 * `spawn`/`console` (@cotal/cli) and the manager's control plane (@cotal/manager).
 * The root just picks which surfaces to pull in; `runCli` resolves whatever
 * registered. A new surface (a Codex control client …) is one more import line.
 */
import { runCli } from "@cotal/cli"; // self-registers up / join / watch / spawn / console
import "@cotal/manager"; // self-registers start / stop / ps / attach
import "@cotal/connector-claude-code"; // registers the `claude` connector that spawn / start resolve
import "@cotal/connector-codex"; // registers the `codex` connector (pull-only MCP adapter)
import { registry } from "@cotal/core";

await runCli(registry, process.argv.slice(2));
