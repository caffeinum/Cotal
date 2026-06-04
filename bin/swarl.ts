/**
 * Composition root for the `swarl` operator CLI. Importing an implementation
 * self-registers its commands into the shared registry — base mesh commands
 * (@swarl/cli) plus the manager's control plane (@swarl/manager). The root just
 * picks which surfaces to pull in; `runCli` resolves whatever registered. A new
 * surface (a console, a Codex control client …) is one more import line.
 */
import { runCli } from "@swarl/cli"; // self-registers up / join / watch
import "@swarl/manager"; // self-registers start / stop / ps
import { registry } from "@swarl/core";

await runCli(registry, process.argv.slice(2));
