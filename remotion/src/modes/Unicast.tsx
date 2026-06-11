// Unicast: alice messages bob directly. Bob is busy, so the message waits
// durably in his inbox; the moment he frees up, it is delivered.
// 210 frames @ 30fps = 7s seamless loop.

import React from "react";
import { useCurrentFrame } from "remotion";
import { C } from "../_shared";
import {
  ACCENT,
  AgentNode,
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

const accent = ACCENT.unicast;

const ALICE: Pt = { x: 280, y: 268 };
const BOB: Pt = { x: 1120, y: 268 };
const INBOX: Pt = { x: 870, y: 268 }; // bob's durable inbox slot

const SEG1: [Pt, Pt] = [
  { x: ALICE.x + 48, y: ALICE.y },
  { x: INBOX.x - 40, y: INBOX.y },
];
const SEG2: [Pt, Pt] = [
  { x: INBOX.x + 40, y: INBOX.y },
  { x: BOB.x - 50, y: BOB.y },
];

const WIRE_PATHS = [
  wirePath(SEG1[0], lerp(...SEG1, 0.4), lerp(...SEG1, 0.6), SEG1[1]),
  wirePath(SEG2[0], lerp(...SEG2, 0.4), lerp(...SEG2, 0.6), SEG2[1]),
];

// timeline
const T = {
  sendStart: 18,
  sendEnd: 55, // token reaches inbox
  bobFrees: 120, // bob flips working -> idle
  deliverStart: 128,
  deliverEnd: 152,
  flashEnd: 178,
  bobBack: 190, // bob starts working on it
};

export const ModeUnicast: React.FC = () => {
  const frame = useCurrentFrame();

  const t1 = prog(frame, T.sendStart, T.sendEnd);
  const t2 = prog(frame, T.deliverStart, T.deliverEnd);

  const parked = frame >= T.sendEnd && frame < T.deliverStart;
  // soft breathing pulse while the message waits
  const breath = parked ? 0.5 + 0.5 * Math.sin(((frame - T.sendEnd) / 22) * Math.PI * 2) : 0;

  const bobStatus: "idle" | "working" =
    frame < T.bobFrees ? "working" : frame < T.bobBack ? "idle" : "working";
  const flash = frame >= T.deliverEnd ? Math.max(0, 1 - fade(frame, T.deliverEnd, T.flashEnd)) : 0;

  const lit1 = t1 > 0 && t1 < 1 ? 0.8 : 0;
  const lit2 = t2 > 0 && t2 < 1 ? 0.8 : 0;
  const emit =
    frame >= T.sendStart ? Math.max(0, 1 - fade(frame, T.sendStart, T.sendStart + 20)) : 0;

  return (
    <Card>
      <Wires paths={WIRE_PATHS} lit={[lit1, lit2]} accent={accent} />
      <AgentNode at={ALICE} name="alice" role="planner" status="working" flash={emit} />
      <AgentNode at={BOB} name="bob" role="builder" status={bobStatus} flash={flash} />

      {/* durable inbox slot */}
      <div
        style={{
          position: "absolute",
          left: INBOX.x - 36,
          top: INBOX.y - 36,
          width: 72,
          height: 72,
          borderRadius: 16,
          border: `2px dashed ${parked || lit2 > 0 ? accent : "#2a3a50"}`,
          background: "#0e162266",
          boxShadow: parked ? `0 0 ${14 + 14 * breath}px 2px ${accent}33` : "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: INBOX.x - 60,
          top: INBOX.y + 50,
          width: 120,
          textAlign: "center",
          fontSize: 19,
          color: C.dim,
        }}
      >
        inbox
      </div>

      {/* message: travel, park (breathing), deliver */}
      {parked ? (
        <Token pos={() => INBOX} t={1} accent={accent} visible size={12 + 2 * breath} />
      ) : (
        <>
          <Token pos={(t) => lerp(...SEG1, t)} t={t1} accent={accent} visible={t1 > 0 && t1 < 1} />
          <Token pos={(t) => lerp(...SEG2, t)} t={t2} accent={accent} visible={t2 > 0 && t2 < 1} />
        </>
      )}

      <Labels mode="unicast" accent={accent} subject="cotal.demo.inst.bob.alice" />
    </Card>
  );
};
