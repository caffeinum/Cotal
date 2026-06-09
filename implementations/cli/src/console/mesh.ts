// useMesh() — the React binding for the Ink console. A thin adapter over the shared
// `MeshView` model in @cotal/core: it owns one MeshView over the read-only observer endpoint
// (built by the console command), subscribes to its batched "change" snapshots, and pushes
// them into React state. All the normalization (classification, coalescing, windowing, roster
// sort, rates, derived signals) lives in MeshView — see docs/protocol-view.md.

import { useEffect, useRef, useState } from "react";
import type { CotalEndpoint, MeshSnapshot, MeshViewOptions } from "@cotal/core";
import { MeshView } from "@cotal/core";

// Re-exported so the UI components keep importing the model shape from one place.
export type { FeedEntry, MeshViewOptions, FeedDelivery } from "@cotal/core";
export type MeshState = MeshSnapshot;

/** Focusable panes across the console (normal panels + the DM lens). */
export type FocusId = "roster" | "feed" | "needsyou" | "dmpeers" | "dmthread";

export function useMesh(ep: CotalEndpoint, opts?: MeshViewOptions): MeshSnapshot {
  const viewRef = useRef<MeshView | null>(null);
  if (!viewRef.current) viewRef.current = new MeshView(ep, opts ?? {});
  const [state, setState] = useState<MeshSnapshot>(() => viewRef.current!.snapshot());
  useEffect(() => {
    const view = viewRef.current!;
    const onChange = (s: MeshSnapshot) => setState(s);
    view.on("change", onChange);
    void view.start();
    return () => {
      view.off("change", onChange);
      void view.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}
