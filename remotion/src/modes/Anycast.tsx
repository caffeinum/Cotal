// Anycast: alice addresses the role "reviewer"; exactly one free instance
// claims the work. 180 frames @ 30fps = 6s seamless loop.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  AgentNode,
  bez,
  Card,
  Dot,
  fade,
  GOLD,
  Labels,
  lerp,
  prog,
  Pulse,
  wirePath,
  Wires,
  type Pt,
} from "./scene";

const ALICE: Pt = { x: 250, y: 268 };
const JUNCTION: Pt = { x: 720, y: 268 };
const GROUP: Pt[] = [
  { x: 1110, y: 116 }, // bob, working
  { x: 1110, y: 268 }, // carol, idle -> claims
  { x: 1110, y: 420 }, // dave, working
];
const MEMBERS = [
  { name: "bob", busy: true },
  { name: "carol", busy: false },
  { name: "dave", busy: true },
] as const;
const CLAIMER = 1;

const SEG1: [Pt, Pt] = [
  { x: ALICE.x + 44, y: ALICE.y },
  { x: JUNCTION.x - 8, y: JUNCTION.y },
];
const outCtrl = (r: Pt): [Pt, Pt] => [
  { x: JUNCTION.x + 140, y: JUNCTION.y },
  { x: r.x - 220, y: r.y },
];
const OUT_END = (r: Pt): Pt => ({ x: r.x - 46, y: r.y });

const PATH1 = wirePath(SEG1[0], lerp(...SEG1, 0.4), lerp(...SEG1, 0.6), SEG1[1]);
const OUT_PATHS = GROUP.map((r) => wirePath(JUNCTION, ...outCtrl(r), OUT_END(r)));

const T = {
  sendStart: 18,
  sendEnd: 52,
  probeEnd: 78,
  claimStart: 78,
  claimEnd: 104,
  flashEnd: 130,
  carolBack: 162,
};

export const ModeAnycast: React.FC = () => {
  const frame = useCurrentFrame();

  const t1 = prog(frame, T.sendStart, T.sendEnd);
  const t2 = prog(frame, T.claimStart, T.claimEnd);

  const probing = frame >= T.sendEnd && frame < T.probeEnd;
  const breath = probing ? 0.5 + 0.5 * Math.sin(((frame - T.sendEnd) / 20) * Math.PI * 2) : 0;

  const flash = frame >= T.claimEnd ? Math.max(0, 1 - fade(frame, T.claimEnd, T.flashEnd)) : 0;
  const carolStatus: "idle" | "working" =
    frame >= T.claimEnd && frame < T.carolBack ? "working" : "idle";
  const emit =
    frame >= T.sendStart ? Math.max(0, 1 - fade(frame, T.sendStart, T.sendStart + 20)) : 0;
  const dimOthers = probing || (t2 > 0 && t2 < 1) || flash > 0 ? 0.5 : 0;

  return (
    <Card frame={frame}>
      <Wires paths={[PATH1, ...OUT_PATHS]} />

      {/* role bracket, label as a legend on the border */}
      <div
        style={{
          position: "absolute",
          left: GROUP[0]!.x - 125,
          top: GROUP[0]!.y - 64,
          width: 250,
          height: GROUP[2]!.y - GROUP[0]!.y + 192,
          borderRadius: 24,
          border: "1px solid #20262f",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: GROUP[0]!.x - 125,
          top: GROUP[0]!.y - 77,
          width: 250,
          textAlign: "center",
          fontSize: 19,
          letterSpacing: 1,
          color: GOLD,
          opacity: 0.85,
        }}
      >
        <span style={{ background: "#090b0e", padding: "0 12px", borderRadius: 6 }}>@reviewer</span>
      </div>

      <AgentNode at={ALICE} name="alice" role="planner" status="working" flash={emit} />
      {MEMBERS.map((m, i) => (
        <AgentNode
          key={m.name}
          at={GROUP[i]!}
          name={m.name}
          role="reviewer"
          status={i === CLAIMER ? carolStatus : m.busy ? "working" : "idle"}
          flash={i === CLAIMER ? flash : 0}
          dimmed={i !== CLAIMER ? dimOthers : 0}
        />
      ))}

      <Pulse d={PATH1} pos={(t) => lerp(...SEG1, t)} t={t1} visible={t1 > 0 && t1 < 1} />
      {probing && <Dot at={JUNCTION} breath={breath} />}
      <Pulse
        d={OUT_PATHS[CLAIMER]!}
        pos={(t) => bez(JUNCTION, ...outCtrl(GROUP[CLAIMER]!), OUT_END(GROUP[CLAIMER]!), t)}
        t={t2}
        visible={t2 > 0 && t2 < 1}
      />

      <Labels mode="anycast" subject="cotal.demo.svc.reviewer.alice" />
    </Card>
  );
};
