import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** This CLI's own invocation as argv: `[node, ...loaderFlags, entryScript]`. The loader flags carry
 *  tsx in dev (so a re-exec can run the `.ts` entry) and are empty in prod (entry = compiled JS).
 *  Re-execed children (web, manager) and cmux pane commands use this so they never depend on
 *  `cotal` being on PATH — works the same via `npx`, `npm i -g`, and a dev clone. */
export function selfArgv(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1]];
}

/** True when launched via `npx` — the package is unpacked under `~/.npm/_npx/<hash>/…`. */
export function isNpx(): boolean {
  return /[/\\]_npx[/\\]/.test(process.argv[1] ?? "");
}

/** Is a `cotal` executable resolvable on PATH? A pure PATH scan (no exec): `cotal --version`
 *  isn't a real command, so probing it via `onPath` would always report cotal as missing. */
export function cotalOnPath(): boolean {
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, `cotal${ext}`), constants.X_OK);
        return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

/** The copy-paste command prefix for user-facing hints: `cotal` when it's on PATH, `npx cotal-ai`
 *  for an npx run, `pnpm cotal` in a dev clone. (Display only — re-execs use {@link selfArgv}.) */
export function displayCmd(): string {
  if (cotalOnPath()) return "cotal";
  if (isNpx()) return "npx cotal-ai";
  return "pnpm cotal";
}

/** The self-invocation as a shell-ready, double-quoted command prefix (for cmux pane commands).
 *  Tokens are absolute paths with no single quotes, so the surrounding `bash -lc '…'` single-quote
 *  wrapping stays intact through a login shell (e.g. nushell) before bash. */
export function selfCotal(): string {
  return selfArgv()
    .map((a) => `"${a}"`)
    .join(" ");
}
