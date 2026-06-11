// Shared scene system for the three README mode animations.
// Clean product look: dark card, glowing message tokens, soft pulses.
// Distinct from the ASCII header variants; only the palette is shared.

import React from "react";
import { AbsoluteFill, Easing, interpolate } from "remotion";
import { C, fontFamily } from "../_shared";

export const ACCENT = {
  multicast: C.cyan,
  unicast: C.magenta,
  anycast: C.yellow,
} as const;

export const AGENTC: Record<string, string> = {
  alice: C.blue,
  bob: C.orange,
  carol: C.magenta,
  dave: C.green,
};

export type Pt = { x: number; y: number };

// Cubic bezier point (for curved wires + token travel).
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

// Eased progress of `frame` through [from, to]; clamped 0..1.
export function prog(frame: number, from: number, to: number): number {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
}

// Linear (unclamped easing) version for fades.
export function fade(frame: number, from: number, to: number): number {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

// --- backdrop ----------------------------------------------------------------

export const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ backgroundColor: "#05080c", fontFamily }}>
    <div
      style={{
        position: "absolute",
        inset: 16,
        borderRadius: 24,
        background: "radial-gradient(ellipse 70% 90% at 50% 45%, #0d1420 0%, #0b0f14 60%, #090c11 100%)",
        border: "1px solid #1c2736",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  </AbsoluteFill>
);

// Mode name top-left + real wire subject bottom-left.
export const Labels: React.FC<{ mode: string; accent: string; subject: string }> = ({
  mode,
  accent,
  subject,
}) => (
  <>
    <div
      style={{
        position: "absolute",
        top: 34,
        left: 44,
        fontSize: 26,
        letterSpacing: 7,
        textTransform: "uppercase",
        color: accent,
        opacity: 0.92,
      }}
    >
      {mode}
    </div>
    <div
      style={{
        position: "absolute",
        bottom: 30,
        left: 44,
        fontSize: 21,
        color: C.dim,
        letterSpacing: 0.5,
      }}
    >
      {subject}
    </div>
  </>
);

// --- nodes --------------------------------------------------------------------

export const NODE_R = 40;

export const AgentNode: React.FC<{
  at: Pt;
  name: string;
  role: string;
  status: "idle" | "working";
  // 0..1 receive flash: brightens ring + fires an expanding pulse
  flash?: number;
  dimmed?: number; // 0..1, fades the whole node
}> = ({ at, name, role, status, flash = 0, dimmed = 0 }) => {
  const color = AGENTC[name] ?? C.white;
  const statusColor = status === "working" ? C.green : C.gray;
  const statusGlyph = status === "working" ? "●" : "○";
  return (
    <div style={{ position: "absolute", left: at.x - NODE_R, top: at.y - NODE_R, opacity: 1 - 0.55 * dimmed }}>
      {/* receive pulse ring */}
      {flash > 0 && (
        <div
          style={{
            position: "absolute",
            left: NODE_R,
            top: NODE_R,
            width: NODE_R * 2,
            height: NODE_R * 2,
            marginLeft: -NODE_R,
            marginTop: -NODE_R,
            borderRadius: "50%",
            border: `2px solid ${color}`,
            transform: `scale(${1 + 1.1 * (1 - flash)})`,
            opacity: flash * 0.7,
          }}
        />
      )}
      <div
        style={{
          width: NODE_R * 2,
          height: NODE_R * 2,
          borderRadius: "50%",
          background: "#0e1622",
          border: `2.5px solid ${color}`,
          boxShadow: `0 0 ${14 + 30 * flash}px ${2 + 9 * flash}px ${color}${flash > 0.05 ? "55" : "2e"}`,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: NODE_R * 2 + 12,
          left: -60,
          width: NODE_R * 2 + 120,
          textAlign: "center",
          lineHeight: 1.45,
        }}
      >
        <span style={{ color, fontSize: 21 }}>{name}</span>
        <span style={{ color: C.dim, fontSize: 21 }}>/{role}</span>
        <div style={{ fontSize: 17, color: statusColor }}>
          {statusGlyph} {status}
        </div>
      </div>
    </div>
  );
};

export const ChannelPill: React.FC<{ at: Pt; label: string; glow?: number; accent: string }> = ({
  at,
  label,
  glow = 0,
  accent,
}) => (
  <div
    style={{
      position: "absolute",
      left: at.x - 88,
      top: at.y - 30,
      width: 176,
      height: 60,
      borderRadius: 30,
      background: "#0e1622",
      border: `2px solid ${glow > 0.05 ? accent : "#2a3a50"}`,
      boxShadow: glow > 0.05 ? `0 0 ${30 * glow}px ${6 * glow}px ${accent}33` : "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 25,
      color: glow > 0.4 ? C.white : C.text,
    }}
  >
    {label}
  </div>
);

// --- wires + tokens -------------------------------------------------------------

// A dim static wire as an SVG path string.
export function wirePath(p0: Pt, c1: Pt, c2: Pt, p1: Pt): string {
  return `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`;
}

export const Wires: React.FC<{ paths: string[]; lit?: number[]; accent: string }> = ({
  paths,
  lit = [],
  accent,
}) => (
  <svg style={{ position: "absolute", inset: 0 }} width={1400} height={600}>
    {paths.map((d, i) => (
      <path
        key={i}
        d={d}
        stroke={(lit[i] ?? 0) > 0.05 ? accent : "#33455e"}
        strokeOpacity={0.45 + 0.45 * (lit[i] ?? 0)}
        strokeWidth={2}
        fill="none"
      />
    ))}
  </svg>
);

// Glowing message token with a trailing comet tail.
// pos(t) maps 0..1 progress to a point; t is the eased head progress.
export const Token: React.FC<{
  pos: (t: number) => Pt;
  t: number;
  accent: string;
  visible: boolean;
  size?: number;
}> = ({ pos, t, accent, visible, size = 13 }) => {
  if (!visible) return null;
  const ghosts = [0, 0.045, 0.09, 0.14, 0.2];
  return (
    <>
      {ghosts.map((back, i) => {
        const gt = Math.max(0, t - back);
        const p = pos(gt);
        const k = 1 - i / ghosts.length;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: p.x - size * k,
              top: p.y - size * k,
              width: size * 2 * k,
              height: size * 2 * k,
              borderRadius: "50%",
              background: accent,
              opacity: i === 0 ? 1 : 0.28 * k,
              boxShadow: i === 0 ? `0 0 22px 7px ${accent}66` : "none",
            }}
          />
        );
      })}
    </>
  );
};
