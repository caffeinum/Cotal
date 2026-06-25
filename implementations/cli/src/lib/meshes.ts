// `pruneStaleMeshes` moved into `@cotal-ai/core` (`preflight.ts`) so the manager control commands can
// share it too. Re-exported from here so its CLI importers (`connect`, `commands/meshes`,
// `commands/use`) and the `spawn-from-anywhere` smokes keep resolving it from this module unchanged.
export { pruneStaleMeshes } from "@cotal-ai/core";
