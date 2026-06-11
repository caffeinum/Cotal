import { useEffect, useRef, useState } from "react";
import { Box, useApp, useFocus, useInput, useStdout } from "ink";
import type { CotalEndpoint } from "@cotal-ai/core";
import { useMesh } from "./mesh.js";
import { Roster } from "./ui/Roster.js";
import { Channels } from "./ui/Channels.js";
import { Feed } from "./ui/Feed.js";
import { StatusBar } from "./ui/StatusBar.js";
import { Help } from "./ui/Help.js";
import type { Tab } from "./ui/types.js";

const ROSTER_W = 26;
type FocusId = "roster" | "channels" | "feed";

/** Track the terminal size so the root box fills the screen and re-lays out on resize. */
function useTermSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

/**
 * The lazygit-style live console: always-visible roster, channel tabs, and a live
 * feed, with Tab-cycled focus and a context-sensitive `?` help overlay. All data
 * comes from backend's useMesh() over the read-only observer endpoint.
 */
export function App({
  ep,
  space,
  tapSubject,
}: {
  ep: CotalEndpoint;
  space: string;
  tapSubject?: string;
}) {
  const { exit } = useApp();
  const mesh = useMesh(ep, { tapSubject });
  const { cols, rows } = useTermSize();

  const [activeTab, setActiveTab] = useState(0); // 0 = "all"
  const [showHelp, setShowHelp] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [focusId, setFocusId] = useState<FocusId>("feed");

  // Three focusable panels; Ink cycles them on Tab. Mirror the active one for the chrome.
  const rosterFocus = useFocus({ id: "roster" });
  const channelsFocus = useFocus({ id: "channels" });
  const feedFocus = useFocus({ id: "feed", autoFocus: true });
  useEffect(() => {
    if (rosterFocus.isFocused) setFocusId("roster");
    else if (channelsFocus.isFocused) setFocusId("channels");
    else if (feedFocus.isFocused) setFocusId("feed");
  }, [rosterFocus.isFocused, channelsFocus.isFocused, feedFocus.isFocused]);

  // Keep presence ages fresh.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const combined: Tab[] = [
    { label: "all", unread: 0 },
    ...mesh.channels.map((ch) => ({ label: ch.name, unread: ch.unread })),
  ];
  const safeTab = Math.min(activeTab, combined.length - 1);
  const activeLabel = combined[safeTab]?.label ?? "all";

  // Unread is backend-tracked; mark the channel we leave AND the one we enter read, and
  // suppress the active tab's badge so messages seen while viewing don't re-flag it.
  const prevLabel = useRef("all");
  useEffect(() => {
    const left = prevLabel.current;
    if (left !== "all" && left !== activeLabel) mesh.markRead(left);
    if (activeLabel !== "all") mesh.markRead(activeLabel);
    prevLabel.current = activeLabel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLabel]);
  const tabs: Tab[] = combined.map((t, i) => (i === safeTab ? { label: t.label, unread: 0 } : t));

  const feedEntries =
    safeTab === 0
      ? mesh.feed
      : mesh.feed.filter((e) => e.kind === "multicast" && e.channel === activeLabel);

  useInput((input, key) => {
    if (showHelp) {
      if (input === "?" || key.escape) setShowHelp(false);
      return;
    }
    if (input === "?") return void setShowHelp(true);
    if (input === "q") return void exit();
    if (input === "a" || input === "0") return void setActiveTab(0);
    if (input >= "1" && input <= "9") {
      const idx = Number(input);
      if (idx < combined.length) {
        setActiveTab(idx);
        feedFocus.focus("feed");
      }
      return;
    }
    if (key.leftArrow) return void setActiveTab((t) => Math.max(0, t - 1));
    if (key.rightArrow) return void setActiveTab((t) => Math.min(combined.length - 1, t + 1));
  });

  const agentCount = mesh.roster.filter((p) => p.kind === "agent").length;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {showHelp ? (
        <Help focus={focusId} />
      ) : (
        <>
          <Box flexGrow={1} minHeight={0}>
            <Roster
              roster={mesh.roster}
              focused={rosterFocus.isFocused}
              now={now}
              width={ROSTER_W}
            />
            <Box flexDirection="column" flexGrow={1} minHeight={0}>
              <Channels tabs={tabs} activeIndex={safeTab} focused={channelsFocus.isFocused} />
              <Feed
                entries={feedEntries}
                focused={feedFocus.isFocused}
                title={activeLabel === "all" ? "all traffic" : "#" + activeLabel}
              />
            </Box>
          </Box>
          <StatusBar
            connected={mesh.status.connected}
            space={space}
            agents={agentCount}
            msgs={mesh.feed.length}
            focusLabel={focusId}
          />
        </>
      )}
    </Box>
  );
}
