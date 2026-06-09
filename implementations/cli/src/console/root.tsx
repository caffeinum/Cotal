import { useMemo, useState } from "react";
import { CotalEndpoint, chatWildcard } from "@cotal/core";
import { App } from "./app.js";
import { SpacePicker } from "./ui/SpacePicker.js";

/** The read-only observer the console watches a space through — invisible to peers. Built once
 *  per selected space (the picker can switch spaces at runtime). */
export function makeObserver(
  space: string,
  server: string,
  creds?: string,
  name = "console",
): CotalEndpoint {
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false, // observer: reads via tap + history + presence-watch, binds no durables
    registerPresence: false, // invisible on the roster; sent messages still carry `name` as `from`
    watchPresence: true,
    card: { name, kind: "endpoint" },
  });
  ep.on("error", () => {});
  return ep;
}

/**
 * Console root. With a fixed `space` (explicit `--space`, or the single space under auth) it goes
 * straight into the per-space console. Without one (open mesh) it shows the space overview first;
 * picking a space mounts the console for it — `key={space}` forces a clean MeshView remount, and
 * `onBack` tears it down to return to the overview.
 */
export function Root({
  server,
  creds,
  space,
  canWrite,
  name,
}: {
  server: string;
  creds?: string;
  space?: string;
  canWrite?: boolean;
  name?: string;
}) {
  const [selected, setSelected] = useState<string | undefined>(space);

  // Build the observer lazily, once per selected space (App's useMesh owns start/stop).
  const ep = useMemo(
    () => (selected === undefined ? null : makeObserver(selected, server, creds, name)),
    [selected, server, creds, name],
  );

  if (selected === undefined || ep === null)
    return <SpacePicker server={server} creds={creds} canWrite={canWrite} onSelect={setSelected} />;

  return (
    <App
      key={selected}
      ep={ep}
      tapSubject={creds ? chatWildcard(selected) : undefined}
      onBack={space === undefined ? () => setSelected(undefined) : undefined}
      canWrite={canWrite}
    />
  );
}
