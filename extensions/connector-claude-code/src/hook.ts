/**
 * Cotal Claude Code lifecycle hook — a one-liner over the shared relay.
 *
 * Claude Code runs this on a lifecycle event and pipes the event JSON on stdin;
 * the relay (in @cotal/connector-core) forwards it to this session's connector
 * control socket and prints the reply. It never blocks the session.
 */
import { runHookRelay } from "@cotal/connector-core";

void runHookRelay().catch(() => process.exit(0));
