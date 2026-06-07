// TODO(demo): tui-designer owns this file (+ ./ui/*.tsx and the console-ink command).
//
// Build the lazygit-style Ink TUI: always-visible panels (roster, channel tabs,
// live feed), focus via useFocus/useFocusManager, number-key channel jumps (1–9),
// per-context keybindings, and a context-sensitive `?` help overlay. Consume the
// data layer from ./mesh.ts (useMesh) — agree its shape with backend over the mesh.
//
// Render config to keep flicker down at cotal scale: incrementalRendering, maxFps ~30,
// <Static> for finalized scrollback. See ./SPEC.md.

export {};
