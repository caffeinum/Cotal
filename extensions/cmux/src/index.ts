/** @cotal-ai/cmux — the cmux integration: a thin driver over the cmux CLI plus
 *  self-registering `cmux` Runtime and Workspaces providers. Importing the package
 *  registers both with the core Registry (like a connector), so the manager can spawn
 *  into cmux tabs and `cotal setup` can open/close them — neither depending on this
 *  package. The driver itself stays mesh-free; launch scripts import `./driver.js`
 *  directly to avoid the registration side effect. */
export * as cmux from "./driver.js";
// importing registers the cmux runtime + workspaces providers
export { CmuxRuntime, cmuxRuntimeProvider, cmuxWorkspacesProvider } from "./runtime.js";
