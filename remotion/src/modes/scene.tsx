// Shared scene system for the three README mode animations.
// Brand language of assets/header.gif: near-black, one gold accent,
// hairline strokes, lowercase mono, restraint. No neon, no rainbow.

import React from "react";
import { AbsoluteFill, Easing, interpolate, random, useVideoConfig } from "remotion";
import { fontFamily } from "../_shared";

// --- palette -------------------------------------------------------------------

export const GOLD = "#d9b36a";
export const INK = {
  bg: "#060708",
  card: "#0a0c0f",
  line: "#262d39", // hairline strokes, wires at rest
  ring: "#3a4150", // node rings
  fill: "#10131a", // node fill
  name: "#c6cdd9",
  text: "#8b94a3",
  dim: "#4d5562",
};

export type Pt = { x: number; y: number };

export function bez(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
}

export function lerp(p0: Pt, p1: Pt, t: number): Pt {
  return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
}

export function prog(frame: number, from: number, to: number): number {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
}

export function fade(frame: number, from: number, to: number): number {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

// --- backdrop --------------------------------------------------------------------

// Sparse constellation, seeded (deterministic across renders), barely there.
const STARS = Array.from({ length: 46 }, (_, i) => ({
  x: random(`sx${i}`) * 1368,
  y: random(`sy${i}`) * 568,
  r: 0.8 + random(`sr${i}`) * 1.1,
  a: 0.04 + random(`sa${i}`) * 0.08,
  ph: random(`sp${i}`) * Math.PI * 2,
}));

export const Card: React.FC<{ frame: number; children: React.ReactNode }> = ({
  frame,
  children,
}) => {
  const { durationInFrames } = useVideoConfig();
  // exactly one twinkle cycle per loop, so the seam is invisible
  const cycle = (frame / durationInFrames) * Math.PI * 2;
  return (
    // outer margin transparent: the rounded card floats on the page background
    <AbsoluteFill style={{ fontFamily }}>
      <div
        style={{
          position: "absolute",
          inset: 16,
          borderRadius: 20,
          background:
            `radial-gradient(ellipse 60% 80% at 82% 115%, rgba(217,179,106,0.07) 0%, rgba(217,179,106,0) 60%), ` +
            `radial-gradient(ellipse 80% 100% at 50% 40%, #0c0e12 0%, ${INK.card} 55%, #08090c 100%)`,
          border: "1px solid #1a1f29",
          overflow: "hidden",
        }}
      >
        {STARS.map((s, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: s.x,
              top: s.y,
              width: s.r * 2,
              height: s.r * 2,
              borderRadius: "50%",
              background: "#cfd6e2",
              opacity: s.a * (0.75 + 0.25 * Math.sin(cycle + s.ph)),
            }}
          />
        ))}
        {children}
      </div>
    </AbsoluteFill>
  );
};

// Mode name top-left + real wire subject bottom-left. Lowercase, quiet.
export const Labels: React.FC<{ mode: string; subject: string }> = ({ mode, subject }) => (
  <>
    <div
      style={{
        position: "absolute",
        top: 36,
        left: 46,
        fontSize: 22,
        letterSpacing: 6,
        color: GOLD,
        opacity: 0.85,
      }}
    >
      {mode}
    </div>
    <div
      style={{
        position: "absolute",
        bottom: 30,
        left: 46,
        fontSize: 18,
        color: INK.dim,
        letterSpacing: 0.5,
      }}
    >
      {subject}
    </div>
  </>
);

// --- nodes -------------------------------------------------------------------------

export const NODE_R = 36;

export const AgentNode: React.FC<{
  at: Pt;
  name: string;
  role: string;
  status: "idle" | "working";
  flash?: number; // 0..1 receive/emit pulse
  dimmed?: number; // 0..1
}> = ({ at, name, role, status, flash = 0, dimmed = 0 }) => {
  const ring = flash > 0.05 ? GOLD : INK.ring;
  return (
    <div
      style={{
        position: "absolute",
        left: at.x - NODE_R,
        top: at.y - NODE_R,
        opacity: 1 - 0.45 * dimmed,
      }}
    >
      {flash > 0 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: NODE_R * 2,
            height: NODE_R * 2,
            borderRadius: "50%",
            border: `1.5px solid ${GOLD}`,
            transform: `scale(${1 + 0.65 * (1 - flash)})`,
            opacity: flash * 0.55,
          }}
        />
      )}
      <div
        style={{
          width: NODE_R * 2,
          height: NODE_R * 2,
          borderRadius: "50%",
          background: INK.fill,
          border: `1.5px solid ${ring}`,
          boxShadow: flash > 0.05 ? `0 0 24px 2px rgba(217,179,106,${0.22 * flash})` : "none",
        }}
      />
      {/* status: a quiet dot on the ring; gold = working, hollow = idle */}
      <div
        style={{
          position: "absolute",
          top: 2,
          left: NODE_R * 2 - 13,
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: status === "working" ? GOLD : "transparent",
          border: status === "working" ? "none" : `1.5px solid ${INK.dim}`,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: NODE_R * 2 + 13,
          left: -70,
          width: NODE_R * 2 + 140,
          textAlign: "center",
          fontSize: 19,
          letterSpacing: 0.5,
        }}
      >
        <span style={{ color: INK.name }}>{name}</span>
        <span style={{ color: INK.dim }}>/{role}</span>
      </div>
    </div>
  );
};

export const ChannelPill: React.FC<{ at: Pt; label: string; glow?: number }> = ({
  at,
  label,
  glow = 0,
}) => (
  <div
    style={{
      position: "absolute",
      left: at.x - 80,
      top: at.y - 26,
      width: 160,
      height: 52,
      borderRadius: 26,
      background: INK.fill,
      border: `1.5px solid ${glow > 0.05 ? GOLD : INK.ring}`,
      boxShadow: glow > 0.05 ? `0 0 22px 2px rgba(217,179,106,${0.2 * glow})` : "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 21,
      letterSpacing: 0.5,
      color: glow > 0.4 ? INK.name : INK.text,
    }}
  >
    {label}
  </div>
);

// --- wires + the light that runs along them ------------------------------------------

export function wirePath(p0: Pt, c1: Pt, c2: Pt, p1: Pt): string {
  return `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`;
}

export const Wires: React.FC<{ paths: string[]; lit?: number[] }> = ({ paths, lit = [] }) => (
  <svg style={{ position: "absolute", inset: 0 }} width={1368} height={568}>
    {paths.map((d, i) => (
      <path
        key={i}
        d={d}
        stroke={INK.line}
        strokeOpacity={0.9 + 0.1 * (lit[i] ?? 0)}
        strokeWidth={1.5}
        fill="none"
      />
    ))}
  </svg>
);

// A pulse of light running along a wire: a tapered dash sliding down the path,
// with a small bright head. No comet balls.
export const Pulse: React.FC<{
  d: string;
  pos: (t: number) => Pt;
  t: number; // eased 0..1
  visible: boolean;
}> = ({ d, pos, t, visible }) => {
  if (!visible) return null;
  const TAIL = 0.16;
  const head = pos(t);
  // dash window [t - TAIL, t], clamped by offset motion
  const off = -(t - TAIL);
  return (
    <>
      <svg style={{ position: "absolute", inset: 0 }} width={1368} height={568}>
        <path
          d={d}
          pathLength={1}
          stroke={GOLD}
          strokeOpacity={0.28}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={`${TAIL} 1`}
          strokeDashoffset={off}
          fill="none"
        />
        <path
          d={d}
          pathLength={1}
          stroke={GOLD}
          strokeOpacity={0.85}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={`${TAIL * 0.4} 1`}
          strokeDashoffset={-(t - TAIL * 0.4)}
          fill="none"
        />
      </svg>
      <Dot at={head} />
    </>
  );
};

// The message itself: a small gold dot (head of a pulse, or parked).
export const Dot: React.FC<{ at: Pt; breath?: number }> = ({ at, breath = 0 }) => {
  const r = 5.5 + 1.2 * breath;
  return (
    <div
      style={{
        position: "absolute",
        left: at.x - r,
        top: at.y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: "50%",
        background: GOLD,
        boxShadow: `0 0 ${12 + 5 * breath}px 2px rgba(217,179,106,0.5)`,
      }}
    />
  );
};
