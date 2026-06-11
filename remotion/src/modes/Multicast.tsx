// Multicast: alice posts to #general; every subscriber receives it.
// 150 frames @ 30fps = 5s seamless loop.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  ACCENT,
  AgentNode,
  bez,
  Card,
  ChannelPill,
  fade,
  Labels,
  lerp,
  prog,
  Token,
  wirePath,
  Wires,
  type Pt,
} from "./scene";

const accent = ACCENT.multicast;

const ALICE: Pt = { x: 250, y: 268 };
const PILL: Pt = { x: 660, y: 268 };
const RECV: Pt[] = [
  { x: 1110, y: 116 },
  { x: 1110, y: 268 },
  { x: 1110, y: 420 },
];
const NAMES = [
  { name: "bob", role: "builder" },
  { name: "carol", role: "reviewer" },
  { name: "dave", role: "builder" },
] as const;

// wire geometry
const IN_START: Pt = { x: ALICE.x + 48, y: ALICE.y };
const IN_END: Pt = { x: PILL.x - 92, y: PILL.y };
const OUT_START: Pt = { x: PILL.x + 92, y: PILL.y };
const outCtrl = (r: Pt): [Pt, Pt] => [
  { x: OUT_START.x + 130, y: OUT_START.y },
  { x: r.x - 220, y: r.y },
];
const OUT_END = (r: Pt): Pt => ({ x: r.x - 50, y: r.y });

const WIRE_PATHS = [
  wirePath(IN_START, lerp(IN_START, IN_END, 0.4), lerp(IN_START, IN_END, 0.6), IN_END),
  ...RECV.map((r) => wirePath(OUT_START, ...outCtrl(r), OUT_END(r))),
];

// timeline
const T = {
  sendStart: 18,
  sendEnd: 48,
  fanStart: 52,
  fanEnd: 92,
  flashEnd: 118,
};

export const ModeMulticast: React.FC = () => {
  const frame = useCurrentFrame();

  const tIn = prog(frame, T.sendStart, T.sendEnd);
  const tOut = prog(frame, T.fanStart, T.fanEnd);

  const pillGlow =
    fade(frame, T.sendEnd - 6, T.sendEnd + 4) * (1 - fade(frame, T.fanEnd, T.flashEnd));
  const flash =
    frame >= T.fanEnd ? Math.max(0, 1 - fade(frame, T.fanEnd, T.flashEnd)) : 0;
  const litIn = tIn > 0 && tIn < 1 ? 0.8 : 0;
  const litOut = tOut > 0 && tOut < 1 ? 0.8 : 0;
  const emit =
    frame >= T.sendStart ? Math.max(0, 1 - fade(frame, T.sendStart, T.sendStart + 20)) : 0;

  return (
    <Card>
      <Wires paths={WIRE_PATHS} lit={[litIn, litOut, litOut, litOut]} accent={accent} />
      <AgentNode at={ALICE} name="alice" role="planner" status="working" flash={emit} />
      <ChannelPill at={PILL} label="#general" glow={pillGlow} accent={accent} />
      {NAMES.map((n, i) => (
        <AgentNode key={n.name} at={RECV[i]!} name={n.name} role={n.role} status="idle" flash={flash} />
      ))}
      <Token
        pos={(t) => lerp(IN_START, IN_END, t)}
        t={tIn}
        accent={accent}
        visible={tIn > 0 && tIn < 1}
      />
      {RECV.map((r, i) => (
        <Token
          key={i}
          pos={(t) => bez(OUT_START, ...outCtrl(r), OUT_END(r), t)}
          t={tOut}
          accent={accent}
          visible={tOut > 0 && tOut < 1}
        />
      ))}
      <Labels mode="multicast" accent={accent} subject="cotal.demo.chat.alice.general" />
    </Card>
  );
};
