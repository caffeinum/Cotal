// BrandHeader — a small Cotal lockup (interlocking rings + "Cotal") used as a
// persistent header in the DemoHdr* comparison comps. The rings are the layout
// anchor (a `ring x ring` box); the "Cotal" wordmark floats to their right and
// is OUT of flow, so positioning/scaling the box centers the RINGS regardless of
// whether the text is visible. `textOpacity` lets the wordmark fade in (e.g. as
// the mark parks into the corner in the "park" variant).

import React from "react";
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins";
import { RingMark, INK } from "./shared";

const { fontFamily: poppins } = loadPoppins("normal", {
  weights: ["600", "700"],
  subsets: ["latin"],
});

export const MarkLockup: React.FC<{
  size: number;
  frame: number;
  appear?: number;
  textOpacity?: number;
}> = ({ size, frame, appear = 0, textOpacity = 1 }) => {
  const ring = size * 1.08;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.3 }}>
      <RingMark size={ring} frame={frame} appear={appear} id="hdr" />
      <div
        style={{
          fontFamily: poppins,
          fontSize: size,
          fontWeight: 600,
          color: INK.name,
          letterSpacing: size * 0.004,
          opacity: textOpacity,
          whiteSpace: "nowrap",
        }}
      >
        Cotal
      </div>
    </div>
  );
};
