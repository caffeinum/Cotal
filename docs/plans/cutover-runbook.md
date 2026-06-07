# Auth cutover runbook — flipping the demo space to auth mode

Operational runbook for the single, coordinated cutover from the open mesh to
JWT-authenticated mode. **Restart-class** (operator config + resolver are not
SIGHUP-reloadable) and **per-account** (JetStream/KV reset — pre-flip `$G` data
does not carry). David owns the *when*; this is the *how*. Reviewed with linus.

## Prep status — COMPLETE, holding for David's explicit go

- `.swarl/auth` generated (account + signing key) — `up` is load-or-create, so the
  flip reuses this exact key and the pre-minted creds stay valid (invariant #1).
- Per-peer creds pre-minted in `.swarl/auth/creds/` (gitignored, local): `ada.creds`,
  `dave.creds`, `david.creds`, `linus.creds` (agent profiles, channel scope from each agent
  file) + `dashboard.creds` (observer). Hand each peer its file (`--creds <path>` / `SWARL_CREDS`)
  at relaunch; manager-spawned agents are minted by the manager at spawn instead.
- Validated against a throwaway server using this exact auth material: a pre-minted cred
  connects; a **credless connect is REFUSED** (auth engages).
- **Do NOT flip** — this drops the whole coordination mesh (this channel included). David gives
  the explicit go at the moment.

## Invariants (confirmed in code)

- **Signing-key continuity.** `swarl up` is **load-or-create**
  (`authSetup` in `up.ts`: `loadSpaceAuth` first, generate only if absent). The
  signing key that mints creds MUST be the one the running server trusts — running
  `up` repeatedly reuses the same `.swarl/auth`, so pre-minted creds stay
  valid. Never regenerate `.swarl/auth` between minting creds and starting the server.
- **Secrets hygiene.** `.swarl/auth/**` (incl. `creds/`) is gitignored — verify it
  is uncommitted before and after (a cutover is when key material gets accidentally
  committed).

## 0. Rehearsal (do this first)

Run the entire flip + verify matrix on a throwaway space (`--space demo-rehearsal`),
then tear it down. A restart-class flip with live downtime is best de-risked by
finding any ordering/cred-path gap on a space nobody is standing in.

> **Rehearse in a SEPARATE workspace dir** (or `rm -rf .swarl/auth` at teardown):
> `.swarl/auth` is per-*workspace*, not per-space — one `auth.json` holding a single
> SpaceAuth. Rehearsing in the same workspace leaves rehearsal material that the real
> pre-flip's load-or-create (invariant #1) would then *reuse* for the demo flip,
> contaminating it with rehearsal-named account/creds.

## 1. Pre-flip (no disruption)

1. Branch green: `pnpm typecheck` + `pnpm smoke`, merged to the demo branch.
2. **Announce the window.** The flip drops the live mesh — every connected peer
   disconnects and must rejoin with creds. We are flipping the space we all stand in.
3. `swarl up --space demo` once to generate/confirm `.swarl/auth` (operator/
   account/SYS + signing key), `server.conf`, and to pre-create CHAT/DM/TASK streams
   + the presence KV bucket **in the demo account**. Stop it again (generation only;
   the real start is step 7). *(Idempotent — safe even if `.swarl/auth` already exists.)*
4. Pre-mint creds against that signing key: `swarl mint <name> --profile observer`
   for each observer, and a control-CLI creds. Agents are minted by the manager at spawn.
5. Accept: pre-flip `$G` chat/dm/task history does NOT carry (throwaway data).

## 2. Flip (brief downtime)

6. Graceful stop, in order: agents → manager → observers → the open `nats-server`.
7. Start `swarl up` (operator config + MEMORY resolver; pre-creates streams +
   KV in the demo account).
8. Start the manager (with `.swarl/auth` present → mints its own manager-profile creds,
   pre-creates each agent's `dm_<id>` at spawn).
9. Start agents (manager-spawned receive creds + their pre-created `dm_<id>`).
10. Start observers + control-CLI **with `--creds`**.

## 3. Verify (lead with the security check)

11. **CREDLESS CONNECT IS REFUSED** — a raw connect / `swarl watch` with NO creds is
    REJECTED. This is the proof auth actually engaged (not merely that nothing broke);
    if `up` silently came up open, everything below would pass while unprotected.
12. `swarl ps --creds <c>` lists agents — control plane alive under auth.
13. Presence/roster populates for a NORMAL endpoint (not just `ps`) — confirms
    `kv.watch` works under scoped creds (the KV-bucket-stream path); else agents look
    absent though up.
14. multicast to a DECLARED channel succeeds; to an UNDECLARED channel is DENIED
    (visible in the step-1 logs, never silent).
15. DM delivers between two agents; an observer sees channel activity and ZERO DMs.
16. No silent "absent": any absence shows a permission-denied log (step 1), not silence.

## 4. Rollback (if the flip wedges)

A creds-configured client won't cleanly auth against an open server, and running
endpoints won't drop their creds on their own — so rollback is a **full endpoint
restart**, not just a server swap:

17. Stop all endpoints (agents, manager, observers) AND the auth `nats-server`.
18. Start `swarl up --open` (unauthenticated `-js`); open-mode lazy-create rebuilds streams in `$G`.
19. Restart all endpoints **without `--creds`**. (`inboxPrefix` stays set in open mode —
    harmless, each owns its own namespace — only the creds/authenticator must be dropped.)
20. Symmetric no-history: data from the auth run does not carry back.
