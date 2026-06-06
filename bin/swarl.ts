/**
 * Composition root for the `swarl` operator CLI. Importing an implementation
 * self-registers its commands into the shared registry — base mesh commands
 * (@swarl/cli), the manager's control plane (@swarl/manager), and the foreground
 * launcher (@swarl/launcher). The root just picks which surfaces to pull in;
 * `runCli` resolves whatever registered. A new surface (a console, a Codex
 * control client …) is one more import line.
 */
import { runCli } from "@swarl/cli"; // self-registers up / join / watch
import "@swarl/manager"; // self-registers start / stop / ps / attach
import "@swarl/launcher"; // self-registers spawn (foreground agent launch)
import "@swarl/connector"; // registers the `claude` connector that spawn resolves
import { registry } from "@swarl/core";

await runCli(registry, process.argv.slice(2));
