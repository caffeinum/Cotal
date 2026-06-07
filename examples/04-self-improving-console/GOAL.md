We're rebuilding cotal's live `console` as a polished lazygit-style Ink/React TUI, shipped as the new `cotal console-ink` command (the old `console` stays untouched). It must render over the EXISTING read-only `CotalEndpoint` observer (see implementations/cli/src/commands/console.ts) — do NOT open a new raw NATS connection. Target: roster panel + channel tabs + live message feed + multi-panel focus + a context-sensitive `?` help overlay.

Run the team in parallel:
- research: read research/INPUT.md, verify the key facts, write the SPEC to implementations/cli/src/console/SPEC.md, and cotal_send a summary to the team so backend and tui-designer start with the right context.
- backend: build the data layer in implementations/cli/src/console/mesh.ts — a useMesh() hook over CotalEndpoint returning UI-ready state.
- tui-designer: build the Ink components in implementations/cli/src/console/ (app.tsx + ui/*.tsx) and wire them into the console-ink command.

backend and tui-designer must settle the exact useMesh() interface DIRECTLY with each other over the mesh (cotal_dm) — don't route the contract through me. Spawn the team, dispatch, and when all three report done and `pnpm --filter @cotal/cli typecheck` is green, cotal_send "DEMO COMPLETE" to the team channel and tell me.
