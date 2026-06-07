import { useCallback, useEffect, useState } from "react";
import { Box, useApp, useFocusManager, useInput, useStdout } from "ink";
import type { CotalEndpoint } from "@cotal/core";
import { useMesh } from "./mesh.js";
import { Tabs } from "./ui/Tabs.js";
import { Roster } from "./ui/Roster.js";
import { Feed } from "./ui/Feed.js";
import { StatusBar } from "./ui/StatusBar.js";
import { Help } from "./ui/Help.js";

/**
 * The lazygit-style console: channel tabs (top) · roster (left) · live feed (main) · status bar.
 * `useMesh` owns the observer endpoint lifecycle and hands us UI-ready state. Input routing is
 * single-source: this global handler owns 1–9 / ? / q / ←→; each panel's keys are gated on focus.
 */
export function App({ ep, tapSubject }: { ep: CotalEndpoint; tapSubject?: string }) {
  const mesh = useMesh(ep, { tapSubject });
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { focus, focusNext, focusPrevious } = useFocusManager();

  const [size, setSize] = useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const [activeChannel, setActiveChannel] = useState("all");
  const [helpOpen, setHelpOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<"roster" | "feed">("feed");

  // Focus the feed first; re-focus the last panel after the help overlay closes.
  useEffect(() => {
    if (!helpOpen) focus(focusedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helpOpen]);

  // Keep last-seen ages fresh.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const tabs = ["all", ...mesh.channels.map((ch) => ch.channel)];
  const counts: Record<string, number> = {};
  for (const ch of mesh.channels) counts[ch.channel] = ch.messages;

  const onFocus = useCallback((id: "roster" | "feed") => setFocusedId(id), []);

  useInput((input, key) => {
    if (helpOpen) {
      setHelpOpen(false);
      return;
    }
    if (input === "?") return setHelpOpen(true);
    if (input === "q") return exit();
    if (key.leftArrow) return focusPrevious();
    if (key.rightArrow) return focusNext();
    if (input >= "1" && input <= "9") {
      const idx = Number(input) - 1;
      if (idx < tabs.length) setActiveChannel(tabs[idx]);
    }
  });

  if (helpOpen) {
    return <Help focusedId={focusedId} width={size.cols} height={size.rows} />;
  }

  const narrow = size.cols < 80;
  const bodyH = Math.max(3, size.rows - 3 /* tabs */ - 1 /* status */);
  let roster: { w: number; h: number };
  let feed: { w: number; h: number };
  if (narrow) {
    const rH = Math.min(8, Math.max(3, Math.floor(bodyH * 0.35)));
    roster = { w: size.cols, h: rH };
    feed = { w: size.cols, h: bodyH - rH };
  } else {
    const rW = Math.min(36, Math.max(24, Math.floor(size.cols * 0.3)));
    roster = { w: rW, h: bodyH };
    feed = { w: size.cols - rW, h: bodyH };
  }

  return (
    <Box flexDirection="column" width={size.cols} height={size.rows}>
      <Tabs tabs={tabs} active={activeChannel} counts={counts} width={size.cols} />
      <Box flexDirection={narrow ? "column" : "row"} height={bodyH}>
        <Roster
          agents={mesh.agents}
          endpoints={mesh.endpoints}
          boxWidth={roster.w}
          boxHeight={roster.h}
          helpOpen={helpOpen}
          onFocus={onFocus}
        />
        <Feed
          entries={mesh.feed}
          activeChannel={activeChannel}
          boxWidth={feed.w}
          boxHeight={feed.h}
          helpOpen={helpOpen}
          onFocus={onFocus}
        />
      </Box>
      <StatusBar
        status={mesh.status}
        rates={mesh.rates}
        activeChannel={activeChannel}
        agentCount={mesh.agents.length}
        focusedId={focusedId}
        width={size.cols}
      />
    </Box>
  );
}
