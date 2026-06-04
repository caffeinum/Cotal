import "./commands.js"; // self-registers the control-plane commands on import

export { Manager, type ManagerOptions } from "./manager.js";
export type { RuntimeKind, RuntimeMode } from "./runtime/index.js";
