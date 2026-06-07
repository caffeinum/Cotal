// TODO(demo): backend owns this file.
//
// Build the data layer for the Ink console: a `useMesh()` hook (or small store)
// over the read-only `CotalEndpoint` observer (see ../commands/console.ts for the
// observer setup, and @cotal/core for getRoster()/on("roster"|"presence")/tap()/
// listChannels()/channelHistory()). Return UI-ready state, e.g.
// { roster, channels, feed, status, rates }, with burst coalescing, windowing,
// and pinned-to-bottom tracking.
//
// Settle the exact return shape with tui-designer over the mesh (cotal_dm) — that
// interface is the contract both sides depend on. See ./SPEC.md.

export {};
