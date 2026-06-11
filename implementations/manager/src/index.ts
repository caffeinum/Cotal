import "./commands.js"; // self-registers the control-plane commands on import

export { Manager, type ManagerOptions } from "./manager.js";
export { createRuntime } from "./runtime/index.js";
export type { Runtime, AgentHandle, RuntimeKind, RuntimeMode } from "./runtime/index.js";
