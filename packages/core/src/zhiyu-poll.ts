// zhiyu-poll — the polling transport and its reconnect schedule
// (openspec: add-zhiyu-mobile-clients, 3.2 / 4.3).
//
// Two mobile clients cannot hold a long connection, so both poll. If each one
// grows its own retry ladder, they disagree about how often to ask and about
// when "offline" becomes "give up" — and the difference shows up as one client
// hammering the gateway during an outage while the other goes quiet. So the
// ladder lives here, once, with a scheduler that can be injected (the tests run
// the whole three-minute outage in microseconds instead of minutes).
//
// Three behaviours are pinned, because each of them has a wrong version that
// looks fine:
//   • backoff 1s → 3s, capped, and RESET by a success (no permanent degradation
//     after one blip);
//   • pausing while backgrounded stops asking at all — a phone in a pocket is
//     not a subscriber (4.3);
//   • resuming CATCHES UP from the persisted cursor, so five minutes away costs
//     one catch-up and loses nothing (4.3).

// Type-only imports on purpose: they erase at compile time, so this module has
// NO runtime dependency of its own. That keeps the retry ladder importable by
// the mini-program bundle and directly testable by `node --test`, and it keeps
// the HTTP transport a decision the caller makes (each client configures one).
import type { HttpResponse } from "./api/http";
import type { RoomMessage, RoomState, RoomTransport } from "./zhiyu-room-client";

/** The ladder. Two entries on purpose: 1s for a blip, 3s for a real outage. */
export const POLL_BACKOFF_MS: readonly number[] = Object.freeze([1000, 3000]);

/** Delay before the next attempt after N consecutive failures. Capped, never infinite. */
export function nextPollDelay(consecutiveFailures: number): number {
  const n = Math.max(0, Math.floor(Number(consecutiveFailures) || 0));
  if (n <= 0) return 0;
  const ladder = POLL_BACKOFF_MS;
  return ladder[Math.min(n - 1, ladder.length - 1)] ?? ladder[ladder.length - 1] ?? 3000;
}

/** A scheduler that can be faked. Returns a cancel function. */
export type PollScheduler = (fn: () => void, ms: number) => () => void;

const defaultScheduler: PollScheduler = (fn, ms) => {
  const t = setTimeout(fn, ms);
  // A poller must never hold a process open on its own.
  (t as unknown as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
};

/** The shape a client must hand in — the core `http()` helper satisfies it. */
export type PollRequest = (path: string, init?: { method?: string }) => Promise<HttpResponse>;

export interface PollTransportOptions {
  roomId: string;
  /** Required, and injected: core owns the ladder, the client owns the transport. */
  request: PollRequest;
  /** How long the server may hold the request open. Must be below the edge timeout. */
  waitMs?: number;
  pageSize?: number;
}

/**
 * `RoomTransport` over the gateway's polling endpoints.
 *
 * `page()` reads a window (`tail`/`before`/`after`); `increment()` asks for what
 * is newer than the cursor and lets the server hold the request for `waitMs`.
 * The server returns the cursor to ask from — the last row it HANDED BACK — and
 * this transport passes it through untouched, because only the server knows how
 * many rows it withheld for visibility.
 */
export function createPollingTransport(opts: PollTransportOptions): RoomTransport {
  const roomId = encodeURIComponent(opts.roomId);
  const waitMs = Math.max(0, Math.floor(opts.waitMs ?? 5_000));
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? 50));
  const request: PollRequest = opts.request;

  return {
    async page({ tail, before, after, limit = pageSize }) {
      const query =
        tail !== undefined
          ? `tail=${Math.min(tail, limit)}`
          : before !== undefined
            ? `before=${before}&limit=${limit}`
            : `after=${after ?? 0}&limit=${limit}`;
      const res = await request(`/api/zhiyu/rooms/${roomId}/messages?${query}`, { method: "GET" });
      if (!res.ok) throw new Error(`messages_${res.status}`);
      const body = (await res.json()) as { messages?: RoomMessage[] };
      return { messages: Array.isArray(body?.messages) ? body.messages : [] };
    },

    async increment(after, wait) {
      const hold = Math.max(0, Math.floor(wait ?? waitMs));
      const res = await request(`/api/zhiyu/rooms/${roomId}/stream?after=${after}&wait=${hold}`, { method: "GET" });
      if (!res.ok) throw new Error(`stream_${res.status}`);
      const body = (await res.json()) as { messages?: RoomMessage[]; cursor?: number };
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      // The server's cursor wins; if it is missing, fall back to the newest row
      // we were given (never to `after`, which would re-read the same window).
      const cursor = Number.isFinite(body?.cursor)
        ? Number(body.cursor)
        : messages.length
          ? messages[messages.length - 1]!.seq
          : after;
      return { messages, cursor };
    },
  };
}

export interface PollDriverOptions {
  /**
   * The room client to drive. Passed in rather than built here so this module
   * needs no runtime import at all — the ladder is shared, the objects are not
   * entangled. The caller builds both from the same two shared pieces:
   *   const client = new ZhiyuRoomClient({ transport: createPollingTransport({...}) });
   *   const driver = new PollDriver({ client });
   */
  client: ZhiyuRoomClientLike;
  onState?: (state: RoomState, meta: { failures: number; paused: boolean }) => void;
  scheduler?: PollScheduler;
  /** Server-side hold per poll (0 = short poll). Default 5s; lowered on a bad network. */
  holdMs?: number;
}

/** The slice of `ZhiyuRoomClient` this driver needs. Structural, so no import. */
export interface ZhiyuRoomClientLike {
  start(): Promise<RoomState>;
  poll(waitMs?: number): Promise<RoomState>;
  catchUp(): Promise<RoomState>;
  state_(): RoomState;
}

/**
 * Drives one room client: starts it, then keeps asking.
 *
 * Nothing here decides WHO may see what — the transport and the server do that.
 * This object only decides WHEN to ask, and it stops asking when told to.
 */
export class PollDriver {
  readonly client: ZhiyuRoomClientLike;
  private readonly scheduler: PollScheduler;
  private readonly onState: PollDriverOptions["onState"] | null;
  private cancelTimer: (() => void) | null = null;
  private holdMs: number;
  private failures = 0;
  private paused = true;
  private stopped = false;

  constructor(opts: PollDriverOptions) {
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.onState = opts.onState ?? null;
    this.client = opts.client;
    this.holdMs = Math.max(0, Math.floor(opts.holdMs ?? 5_000));
  }

  /** Consecutive failures since the last success — exposed for tests and badges. */
  get failureCount(): number {
    return this.failures;
  }

  isPaused(): boolean {
    return this.paused;
  }

  private report() {
    this.onState?.(this.client.state_(), { failures: this.failures, paused: this.paused });
  }

  /** Open the room and begin polling. Idempotent. */
  async start(): Promise<RoomState> {
    this.stopped = false;
    this.paused = false;
    const state = await this.client.start();
    this.report();
    this.scheduleNext();
    return state;
  }

  /**
   * Stop asking. Used when the client goes to the background: a paused poller
   * issues no requests at all, which is the difference between "we handle
   * background" and "we drain the battery to be told nothing changed".
   */
  pause() {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.report();
  }

  /**
   * Resume, and CATCH UP first. Five minutes in a pocket is not one increment:
   * the room may have moved hundreds of rows, and a single page would leave a
   * hole nothing later can fill (4.3).
   */
  async resume(): Promise<RoomState> {
    if (this.stopped) return this.client.state_();
    this.paused = false;
    const state = await this.client.catchUp();
    this.failures = 0;
    this.report();
    this.scheduleNext();
    return state;
  }

  /** Stop for good (page unmount). */
  stop() {
    this.stopped = true;
    this.paused = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  /**
   * How long each poll is allowed to be held open by the server.
   *
   * This is the difference between "long poll" (one request parked for 5s) and
   * "short poll" (a request every second). Downgrading is a REAL change of
   * cadence, not a label: on a bad network a parked request burns the whole
   * window and comes back empty, so the client asks without a hold instead and
   * lets the ladder space it out (3.4).
   */
  setHold(ms: number) {
    this.holdMs = Math.max(0, Math.floor(Number(ms) || 0));
  }

  getHold(): number {
    return this.holdMs;
  }

  /** One manual tick — the page may drive this from its own visibility change. */
  async tick(waitMs = this.holdMs): Promise<RoomState> {
    if (this.paused || this.stopped) return this.client.state_();
    const state = await this.client.poll(waitMs);
    if (state.error) this.failures += 1;
    else this.failures = 0;
    this.report();
    return state;
  }

  private scheduleNext() {
    if (this.paused || this.stopped) return;
    const delay = nextPollDelay(this.failures);
    this.cancelTimer?.();
    this.cancelTimer = this.scheduler(() => {
      void this.tick().then(() => this.scheduleNext());
    }, delay);
  }
}
