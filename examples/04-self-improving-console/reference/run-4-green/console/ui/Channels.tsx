import { Box, Text } from "ink";
import { focusBorder } from "./theme.js";
import type { Tab } from "./types.js";

/** Channel tab bar. Index 0 is the "all" pseudo-tab; 1–9 map to live channels. */
export function Channels({
  tabs,
  activeIndex,
  focused,
}: {
  tabs: Tab[];
  activeIndex: number;
  focused: boolean;
}) {
  return (
    <Box borderStyle="round" borderColor={focusBorder(focused)} paddingX={1}>
      {tabs.map((t, i) => {
        const active = i === activeIndex;
        const label = i === 0 ? "all" : `${i}:${t.label}`;
        const badge = t.unread > 0 ? ` (${t.unread})` : "";
        return (
          <Box key={t.label} marginRight={1}>
            <Text inverse={active} bold={active} dimColor={!active}>
              {` ${label}${badge} `}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
