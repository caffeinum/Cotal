// DemoHdrPark (Variant B) — the big center ring-mark reveals (as today), then at
// the intro->topology hand-off it SHRINKS and FLIES to the top-left corner,
// where the "Cotal" wordmark fades in beside it and it holds as the header while
// the topology plays. Single continuous timeline so the mark can travel across
// the cut. 350f.

import React from "react";
import {
  AbsoluteFill,
  CreamStage,
  Easing,
  GOLD,
  INK,
  Sequence,
  fade,
  fontFamily,
  interpolate,
  loopEnvelope,
  useCurrentFrame,
} from "../header/shared";
import { MarkLockup } from "../header/BrandHeader";
import { S5TopologyRotate } from "./S5TopologyRotate";

const DURATION = 350;
const LINES = ["Any agent", "Any topology", "One space"];

export const DemoHdrPark: React.FC = () => {
  const frame = useCurrentFrame();

  // fly progress: big+centered -> small+top-left
  const p = interpolate(frame, [92, 124], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const cx = interpolate(p, [0, 1], [960, 156]); // lockup centre x
  const cy = interpolate(p, [0, 1], [360, 78]); // lockup centre y
  const sc = interpolate(p, [0, 1], [3.0, 1.0]);
  // "Cotal" wordmark is part of the title from the start (fades in with the rings)
  const textOp = interpolate(frame, [20, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const linesOp = 1 - fade(frame, 92, 112);

  return (
    <AbsoluteFill style={{ opacity: loopEnvelope(frame, DURATION, 12) }}>
      {/* base cream (carries the intro before the topology layer starts) */}
      <CreamStage>{null}</CreamStage>

      {/* intro message lines, below the big mark; fade out as it flies */}
      <div style={{ position: "absolute", top: 470, left: 0, right: 0, textAlign: "center", opacity: linesOp }}>
        {LINES.map((line, i) => {
          const start = 30 + i * 13;
          const op = fade(frame, start, start + 12);
          const dy = interpolate(frame, [start, start + 16], [16, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.out(Easing.cubic),
          });
          const color = i === LINES.length - 1 ? GOLD : INK.name;
          return (
            <div key={i} style={{ fontFamily, fontSize: 78, color, opacity: op, transform: `translateY(${dy}px)`, lineHeight: 1.22, letterSpacing: 1 }}>
              {line}
            </div>
          );
        })}
      </div>

      {/* topology takes over from frame 110 (its own cream covers the intro) */}
      <Sequence from={110}><S5TopologyRotate /></Sequence>

      {/* the travelling mark — on top of everything, big -> parked top-left */}
      <div
        style={{
          position: "absolute",
          left: cx,
          top: cy,
          transform: `translate(-50%, -50%) scale(${sc})`,
          transformOrigin: "center",
        }}
      >
        <MarkLockup size={42} frame={frame} appear={6} textOpacity={textOp} />
      </div>
    </AbsoluteFill>
  );
};
