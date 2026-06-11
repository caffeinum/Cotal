// Anycast: alice addresses the role "reviewer"; exactly one free instance
// claims the work. 180 frames @ 30fps = 6s seamless loop.

import React from "react";
import { useCurrentFrame } from "remotion";
import { C } from "../_shared";
import {
  ACCENT,
  AgentNode,
  bez,
  Card,
  fade,
  Labels,
  lerp,
  prog,
  Token,
  wirePath,
  Wires,
  type Pt,
} from "./scene";

const accent = ACCENT.anycast;

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
  { x: ALICE.x + 48, y: ALICE.y },
  { x: JUNCTION.x - 10, y: JUNCTION.y },
];
const outCtrl = (r: Pt): [Pt, Pt] => [
  { x: JUNCTION.x + 140, y: JUNCTION.y },
  { x: r.x - 220, y: r.y },
];
const OUT_END = (r: Pt): Pt => ({ x: r.x - 50, y: r.y });

const WIRE_PATHS = [
  wirePath(SEG1[0], lerp(...SEG1, 0.4), lerp(...SEG1, 0.6), SEG1[1]),
  ...GROUP.map((r) => wirePath(JUNCTION, ...outCtrl(r), OUT_END(r))),
];

// timeline
const T = {
  sendStart: 18,
  sendEnd: 52, // token reaches the role junction
  probeEnd: 78, // candidate wires shimmer while one instance is picked
  claimStart: 78,
  claimEnd: 104,
  flashEnd: 130,
  carolBack: 162, // carol finishes; group returns to start state
};

export const ModeAnycast: React.FC = () => {
  const frame = useCurrentFrame();

  const t1 = prog(frame, T.sendStart, T.sendEnd);
  const t2 = prog(frame, T.claimStart, T.claimEnd);

  const probing = frame >= T.sendEnd && frame < T.probeEnd;
  const shimmer = probing ? 0.25 + 0.25 * Math.sin(((frame - T.sendEnd) / 9) * Math.PI * 2) : 0;

  const flash = frame >= T.claimEnd ? Math.max(0, 1 - fade(frame, T.claimEnd, T.flashEnd)) : 0;
  const carolStatus: "idle" | "working" =
    frame >= T.claimEnd && frame < T.carolBack ? "working" : "idle";

  const lit1 = t1 > 0 && t1 < 1 ? 0.8 : 0;
  const litClaim = t2 > 0 && t2 < 1 ? 0.8 : 0;

  return (
    <Card>
      <Wires
        paths={WIRE_PATHS}
        lit={[lit1, shimmer, Math.max(shimmer, litClaim), shimmer]}
        accent={accent}
      />

      {/* role bracket around the group, label as a legend on the border */}
      <div
        style={{
          position: "absolute",
          left: GROUP[0]!.x - 125,
          top: GROUP[0]!.y - 68,
          width: 250,
          height: GROUP[2]!.y - GROUP[0]!.y + 204,
          borderRadius: 28,
          border: "1.5px dashed #2e405a",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: GROUP[0]!.x - 125,
          top: GROUP[0]!.y - 82,
          width: 250,
          textAlign: "center",
          fontSize: 21,
          color: accent,
          opacity: 0.9,
        }}
      >
        <span style={{ background: "#0b0f14", padding: "0 12px", borderRadius: 6 }}>@reviewer</span>
      </div>

      <AgentNode
        at={ALICE}
        name="alice"
        role="planner"
        status="working"
        flash={frame >= T.sendStart ? Math.max(0, 1 - fade(frame, T.sendStart, T.sendStart + 20)) : 0}
      />
      {MEMBERS.map((m, i) => (
        <AgentNode
          key={m.name}
          at={GROUP[i]!}
          name={m.name}
          role="reviewer"
          status={i === CLAIMER ? carolStatus : m.busy ? "working" : "idle"}
          flash={i === CLAIMER ? flash : 0}
          dimmed={i !== CLAIMER && (probing || litClaim > 0 || flash > 0) ? 0.5 : 0}
        />
      ))}

      <Token pos={(t) => lerp(...SEG1, t)} t={t1} accent={accent} visible={t1 > 0 && t1 < 1} />
      {probing && <Token pos={() => JUNCTION} t={1} accent={accent} visible size={12} />}
      <Token
        pos={(t) => bez(JUNCTION, ...outCtrl(GROUP[CLAIMER]!), OUT_END(GROUP[CLAIMER]!), t)}
        t={t2}
        accent={accent}
        visible={t2 > 0 && t2 < 1}
      />

      <Labels mode="anycast" accent={accent} subject="cotal.demo.svc.reviewer.alice" />
    </Card>
  );
};
