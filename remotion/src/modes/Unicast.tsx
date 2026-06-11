// Unicast: alice messages bob directly. Bob is busy, so the message waits
// durably in his inbox; the moment he frees up, it is delivered.
// 210 frames @ 30fps = 7s seamless loop.

import React from "react";
import { useCurrentFrame } from "remotion";
import {
  AgentNode,
  Card,
  Dot,
  fade,
  INK,
  Labels,
  lerp,
  prog,
  Pulse,
  wirePath,
  Wires,
  GOLD,
  type Pt,
} from "./scene";

const ALICE: Pt = { x: 280, y: 268 };
const BOB: Pt = { x: 1120, y: 268 };
const INBOX: Pt = { x: 870, y: 268 };

const SEG1: [Pt, Pt] = [
  { x: ALICE.x + 44, y: ALICE.y },
  { x: INBOX.x - 38, y: INBOX.y },
];
const SEG2: [Pt, Pt] = [
  { x: INBOX.x + 38, y: INBOX.y },
  { x: BOB.x - 46, y: BOB.y },
];

const PATH1 = wirePath(SEG1[0], lerp(...SEG1, 0.4), lerp(...SEG1, 0.6), SEG1[1]);
const PATH2 = wirePath(SEG2[0], lerp(...SEG2, 0.4), lerp(...SEG2, 0.6), SEG2[1]);

const T = {
  sendStart: 18,
  sendEnd: 55,
  bobFrees: 120,
  deliverStart: 128,
  deliverEnd: 152,
  flashEnd: 178,
  bobBack: 190,
};

export const ModeUnicast: React.FC = () => {
  const frame = useCurrentFrame();

  const t1 = prog(frame, T.sendStart, T.sendEnd);
  const t2 = prog(frame, T.deliverStart, T.deliverEnd);

  const parked = frame >= T.sendEnd && frame < T.deliverStart;
  const breath = parked ? 0.5 + 0.5 * Math.sin(((frame - T.sendEnd) / 26) * Math.PI * 2) : 0;

  const bobStatus: "idle" | "working" =
    frame < T.bobFrees ? "working" : frame < T.bobBack ? "idle" : "working";
  const deliverFlash =
    frame >= T.deliverEnd ? Math.max(0, 1 - fade(frame, T.deliverEnd, T.flashEnd)) : 0;
  // a quiet ripple when bob frees up, so the state change registers
  const freeFlash =
    frame >= T.bobFrees ? 0.4 * Math.max(0, 1 - fade(frame, T.bobFrees, T.bobFrees + 16)) : 0;
  const emit =
    frame >= T.sendStart ? Math.max(0, 1 - fade(frame, T.sendStart, T.sendStart + 20)) : 0;

  return (
    <Card frame={frame}>
      <Wires paths={[PATH1, PATH2]} />
      <AgentNode at={ALICE} name="alice" role="planner" status="working" flash={emit} />
      <AgentNode at={BOB} name="bob" role="builder" status={bobStatus} flash={Math.max(deliverFlash, freeFlash)} />

      {/* durable inbox slot */}
      <div
        style={{
          position: "absolute",
          left: INBOX.x - 32,
          top: INBOX.y - 32,
          width: 64,
          height: 64,
          borderRadius: 14,
          border: `1.5px solid ${parked ? GOLD : INK.ring}`,
          background: INK.fill,
          boxShadow: parked ? `0 0 18px 1px rgba(217,179,106,${0.12 + 0.1 * breath})` : "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: INBOX.x - 60,
          top: INBOX.y + 46,
          width: 120,
          textAlign: "center",
          fontSize: 17,
          color: INK.dim,
          letterSpacing: 0.5,
        }}
      >
        inbox
      </div>

      {parked ? (
        <Dot at={INBOX} breath={breath} />
      ) : (
        <>
          <Pulse d={PATH1} pos={(t) => lerp(...SEG1, t)} t={t1} visible={t1 > 0 && t1 < 1} />
          <Pulse d={PATH2} pos={(t) => lerp(...SEG2, t)} t={t2} visible={t2 > 0 && t2 < 1} />
        </>
      )}

      <Labels mode="unicast" subject="cotal.demo.inst.bob.alice" />
    </Card>
  );
};
