import { Box, Text } from "ink";

/** The channel tab strip. `all` (firehose) is tab 1; channels follow. 1–9 jump directly. */
export function Tabs({
  tabs,
  active,
  counts,
  width,
}: {
  tabs: string[];
  active: string;
  counts: Record<string, number>;
  width: number;
}) {
  return (
    <Box width={width} height={3} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text wrap="truncate-end">
        {tabs.map((t, i) => {
          const isActive = t === active;
          const label = t === "all" ? "all" : "#" + t;
          const count = t === "all" ? undefined : counts[t];
          return (
            <Text key={t}>
              {i > 0 ? <Text dimColor>{"   "}</Text> : null}
              <Text dimColor>{i + 1}:</Text>
              <Text color={isActive ? "cyan" : undefined} inverse={isActive} bold={isActive}>
                {" " + label + (count !== undefined ? " " + count : "") + " "}
              </Text>
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}
