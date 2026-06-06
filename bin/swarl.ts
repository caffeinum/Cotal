/**
 * Composition root for the `swarl` operator CLI. Importing an implementation
 * self-registers its commands into the shared registry — base mesh commands plus
 * `spawn`/`console` (@swarl/cli) and the manager's control plane (@swarl/manager).
 * The root just picks which surfaces to pull in; `runCli` resolves whatever
 * registered. A new surface (a Codex control client …) is one more import line.
 */
import { runCli } from "@swarl/cli"; // self-registers up / join / watch / spawn / console
import "@swarl/manager"; // self-registers start / stop / ps / attach
import "@swarl/connector-claude-code"; // registers the `claude` connector that spawn / start resolve
import { registry } from "@swarl/core";

await runCli(registry, process.argv.slice(2));
