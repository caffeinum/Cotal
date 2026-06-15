/** This CLI's own invocation as argv: `[node, ...loaderFlags, entryScript]`. The loader flags carry
 *  tsx in dev (so a re-exec can run the `.ts` entry) and are empty in prod (entry = compiled JS).
 *  Re-execed children (web, manager) and cmux pane commands use this so they never depend on
 *  `cotal` being on PATH — works the same via `npx`, `npm i -g`, and a dev clone. */
export function selfArgv(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1]];
}

/** The self-invocation as a shell-ready, double-quoted command prefix (for cmux pane commands).
 *  Tokens are absolute paths with no single quotes, so the surrounding `bash -lc '…'` single-quote
 *  wrapping stays intact through a login shell (e.g. nushell) before bash. */
export function selfCotal(): string {
  return selfArgv()
    .map((a) => `"${a}"`)
    .join(" ");
}
