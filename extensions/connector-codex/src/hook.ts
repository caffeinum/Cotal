/**
 * Cotal Codex lifecycle hook — a one-liner over the shared relay.
 *
 * Codex runs this on a lifecycle event and pipes the event JSON on stdin; the relay
 * (in @cotal-ai/connector-core) forwards it to this session's connector control
 * socket and prints the reply. It never blocks the session. Identical to the Claude
 * Code hook entry — the relay is harness-agnostic.
 */
import { runHookRelay } from "@cotal-ai/connector-core";

void runHookRelay().catch(() => process.exit(0));
