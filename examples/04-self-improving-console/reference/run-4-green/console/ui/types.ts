// UI-facing views of backend's useMesh() contract. Derived from the hook's return
// type so the panels depend only on `useMesh` being exported from mesh.ts — never on
// backend's internal type-export names. Settled peer-to-peer (see SPEC.md).

import type { useMesh } from "../mesh.js";

export type MeshState = ReturnType<typeof useMesh>;
export type AgentRow = MeshState["roster"][number];
export type ChannelRow = MeshState["channels"][number];
export type FeedEntry = MeshState["feed"][number];

/** A channel tab: the leftmost "all" plus one per live channel. */
export interface Tab {
  label: string;
  unread: number;
}
