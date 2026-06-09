import type { InboxItem } from "./agent.js";

/** The slice of {@link MeshAgent} an {@link InboxTurn} drives off of. */
export interface InboxSource {
  /** Buffered messages, oldest first, without acking. */
  peekInbox(): InboxItem[];
  /** Ack + remove the front `limit` messages and return them. */
  drainInbox(limit?: number): InboxItem[];
}

/**
 * Ack-on-surface delivery off a {@link MeshAgent}'s stream-backed inbox.
 *
 * The inbox is the single source of truth — there is no parallel buffer to drift out of
 * sync. A turn *surfaces* a front-contiguous run of messages (so the surfaced set is always
 * a prefix of the inbox, which keeps the ack count exact) and acks them with `drainInbox`
 * only once the turn COMPLETES. A crash or interrupt before {@link commit} leaves the run on
 * the stream, so it redelivers — nothing is acked merely by being read.
 *
 * Fits both shapes the embed adapters use:
 *   - a one-message serialize loop: `start()` → run → `commit()`;
 *   - pi's same-scope steer loop: `start()` → `extend(match)`* (fold contiguous peers, e.g.
 *     same-scope messages, as they stream in) → `commit()` on a clean/failed finish, or
 *     `abandon()` on interrupt.
 *
 * `cotal_inbox` (where exposed) must stay on `peekInbox` so a model call can't double-drain
 * what the loop already surfaced.
 */
export class InboxTurn {
  private surfaced = 0;
  private _origin?: InboxItem;

  constructor(private readonly source: InboxSource) {}

  /** True while a turn holds surfaced-but-unacked messages. */
  get inFlight(): boolean {
    return this.surfaced > 0;
  }

  /** The message that opened the current turn (its reply scope), or undefined when idle. */
  get origin(): InboxItem | undefined {
    return this._origin;
  }

  /** How many front messages this turn has surfaced (the exact `commit` ack count). */
  get count(): number {
    return this.surfaced;
  }

  /**
   * Ack-drop the leading messages matching `skip` (own echoes, ambient chatter) so they
   * neither block the front nor linger to the inbox cap. Only valid with no turn in flight.
   */
  drop(skip: (item: InboxItem) => boolean): void {
    if (this.surfaced) return;
    const pending = this.source.peekInbox();
    let n = 0;
    while (n < pending.length && skip(pending[n])) n++;
    if (n) this.source.drainInbox(n);
  }

  /**
   * Open a turn on the front message (its origin) and surface it. Returns the origin, or
   * undefined if the inbox is empty. Idempotent while a turn is in flight (returns the
   * current origin). Call {@link drop} first so the front is the message you mean to answer.
   */
  start(): InboxItem | undefined {
    if (this.surfaced) return this._origin;
    const front = this.source.peekInbox()[0];
    if (!front) return undefined;
    this._origin = front;
    this.surfaced = 1;
    return front;
  }

  /**
   * Fold the front-contiguous run of not-yet-surfaced messages that `match(item, origin)`
   * into this turn, stopping at the first non-match (so the surfaced set stays a prefix and
   * the ack count stays exact). Returns the newly surfaced messages for the caller to feed
   * in (e.g. via steer). No-op until {@link start}.
   */
  extend(match: (item: InboxItem, origin: InboxItem) => boolean): InboxItem[] {
    if (!this._origin) return [];
    const rest = this.source.peekInbox().slice(this.surfaced);
    const run: InboxItem[] = [];
    for (const item of rest) {
      if (!match(item, this._origin)) break;
      run.push(item);
    }
    this.surfaced += run.length;
    return run;
  }

  /**
   * Ack the surfaced run — the sole ack site. Call on a terminal status that should consume
   * the messages: a clean finish, or a failed/dropped turn (drop, no retry-loop). Do NOT
   * call on interrupt/crash — use {@link abandon} so the run redelivers.
   */
  commit(): void {
    if (this.surfaced) this.source.drainInbox(this.surfaced);
    this.reset();
  }

  /** End the turn without acking — the surfaced run stays on the stream and redelivers. */
  abandon(): void {
    this.reset();
  }

  private reset(): void {
    this.surfaced = 0;
    this._origin = undefined;
  }
}
