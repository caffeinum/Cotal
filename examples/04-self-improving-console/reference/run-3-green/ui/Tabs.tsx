import React from "react";
import { Box, Text } from "ink";

export interface TabItem {
  /** Display label ("all" or a channel name). */
  label: string;
  /** Message count badge, or null to hide (e.g. the synthetic "all" tab). */
  count: number | null;
  /** True for real channels (rendered with a leading #). */
  isChannel: boolean;
}

/** Channel tab strip — number keys 1–9 jump to a tab; the active one is highlighted. */
export function Tabs({ tabs, active }: { tabs: TabItem[]; active: number }): React.ReactElement {
  return (
    <Box>
      {tabs.map((t, i) => {
        const on = i === active;
        const key = i + 1;
        const label = (t.isChannel ? "#" : "") + t.label;
        return (
          <Box key={t.label} marginRight={1}>
            <Text
              color={on ? "cyan" : undefined}
              dimColor={!on}
              bold={on}
              inverse={on}
            >
              {" "}
              {key <= 9 ? `${key}:` : ""}
              {label}
              {t.count !== null ? ` ${t.count}` : ""}{" "}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
