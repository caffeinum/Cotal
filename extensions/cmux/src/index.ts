/** @swarl/cmux — a thin driver over the cmux CLI. No mesh logic, no self-
 *  registration: the manager's `cmux` runtime and example launch scripts call
 *  these to place agents into cmux tabs. */
export * as cmux from "./driver.js";
