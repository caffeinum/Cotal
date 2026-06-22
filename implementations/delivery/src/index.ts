/**
 * `@cotal-ai/delivery` — the server-side Plane-3 delivery daemon, as a self-registering `deliver`
 * command. Importing this package registers `deliver` into the core `Registry`; the `cotal` binary
 * (composition root) pulls it in alongside `@cotal-ai/manager`. Structurally parallel to the manager:
 * a distinct long-lived infra role with its own scoped cred profile and lifecycle. It NEVER imports
 * `@cotal-ai/manager` or `@cotal-ai/cli` (one-way tiering).
 */
import { registry, type Command } from "@cotal-ai/core";
import { runDelivery } from "./delivery.js";

const deliveryCommands: Command[] = [
  {
    kind: "command",
    name: "deliver",
    group: "Manager",
    summary:
      "run the delivery daemon — the server-side Plane-3 durable backstop [--space <s>] [--server <url>] [--creds <file>] (auth mode only; N=1)",
    run: (argv) => runDelivery(argv),
  },
];

registry.register(...deliveryCommands);

export { runDelivery };
