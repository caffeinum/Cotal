/** @cotal-ai/cmux — the cmux integration: a thin driver over the cmux CLI plus a
 *  self-registering `cmux` Runtime. Importing the package registers the runtime
 *  with the core Registry (like a connector), so the manager can spawn into cmux
 *  tabs without ever depending on this package. The driver itself stays mesh-free;
 *  launch scripts import `./driver.js` directly to avoid the registration side effect. */
export * as cmux from "./driver.js";
export { CmuxRuntime, cmuxRuntimeProvider } from "./runtime.js"; // importing registers the cmux runtime
