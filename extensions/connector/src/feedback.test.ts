/** Run with: pnpm --filter @swarl/connector test (tsx). Asserts classifyOrigin against the real repo layout. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyOrigin } from "./feedback.js";

const here = dirname(fileURLToPath(import.meta.url)); // extensions/connector/src
const repo = join(here, "..", "..", ".."); // repo root

// This extension → implementation, named by its package.json.
const conn = classifyOrigin(here);
assert.equal(conn.domain, "implementation");
assert.equal(conn.component, "@swarl/connector");

// A package under packages/ → protocol.
const core = classifyOrigin(join(repo, "packages", "core", "src"));
assert.equal(core.domain, "protocol");

// An example app → implementation.
const api = classifyOrigin(join(repo, "examples", "02-cmux-handoff", "todo-api", "src"));
assert.equal(api.domain, "implementation");

// Nothing found above an unknown path → safe fallback.
const none = classifyOrigin("/nonexistent/somewhere");
assert.equal(none.domain, "implementation");
assert.equal(none.component, "unknown");

console.log("feedback classifier OK ✅");
