// zhiyu-room-client — the room's cursor state machine, shared by web, the
// mini-program and the app (openspec: add-zhiyu-mobile-clients, D: one state
// machine, three transports).
//
// The room is a seq-ordered log. Every client does the same four things with it,
// and every client that does them separately gets one of them subtly wrong:
//
//   • tail start   — open at the newest N rows, not at row 1 of a year-old room.
//   • dedupe       — a reconnect REPLAYS from the cursor, so the same seq arrives
//                    twice; rendering it twice makes the room look like somebody
//                    repeated themselves.
//   • catch-up     — after being away, one increment may not be enough: read
//                    until the cursor stops moving, or the room has holes.
//   • page back    — older rows prepend, and the cursor must NOT move backwards
//                    because of it (the cursor is "newest seen", not "last read").
//
// DOM-free and timer-free: a transport object is injected, so the same logic can
// run on SSE, on a 25-second poll, or in a test. Deliberately no runtime
// dependency (2.4) — this module is imported by the mini-program bundle.

export interface RoomMessage {
  seq: number;
  kind: string;
  content: string;
  visibility?: string;
  senderMemberId?: string | null;
  createdAt?: number;
  meta?: Record<string, unknown> | null;
}

/** What a transport must provide. Semantics, not mechanics. */
export interface RoomTransport {
  /**
   * One window read. Exactly one of `tail` / `before` / `after` is meaningful:
   * `tail` opens the room, `before` pages backwards, `after` catches up.
   */
  page(opts: { tail?: number; before?: number; after?: number; limit?: number }): Promise<{ messages: RoomMessage[] }>;
  /**
   * One increment. Resolves with whatever is new after `after`, and the cursor
   * to ask from next time — which is the last row HANDED BACK, never `after`.
   */
  increment(after: number, waitMs: number): Promise<{ messages: RoomMessage[]; cursor: number }>;
}

export interface RoomState {
  messages: RoomMessage[];
  /** Newest seq this client has seen. Never decreases. */
  cursor: number;
  /** False once a backward page came back empty. */
  hasOlder: boolean;
  loading: boolean;
  /** Set when the last operation failed; cleared by the next success. */
  error: string | null;
}

export interface ZhiyuRoomClientOptions {
  transport: RoomTransport;
  roomId: string;
  /** Rows to open with. */
  tailCount?: number;
  /** Rows per backward page. */
  pageSize?: number;
  /**
   * The last seq this client saw in a PREVIOUS life (from storage). A cold start
   * with a cursor catches up instead of replaying the tail — that is the whole
   * difference between "reopened the room" and "scrolled back an hour" (2.3).
   */
  resumedFrom?: number | null;
  /** Called with the new cursor after every change, so the caller can persist it. */
  onCursor?: (seq: number) => void;
}

/**
 * Merge two seq-ordered lists, keeping only the first occurrence of each seq.
 *
 * Written as a merge rather than a sort+unique because the lists are already
 * ordered and the cost of a full sort on every increment grows with the room.
 */
export function mergeBySeq(a: RoomMessage[], b: RoomMessage[]): RoomMessage[] {
  const out: RoomMessage[] = [];
  let i = 0;
  let j = 0;
  const push = (m: RoomMessage) => {
    const last = out[out.length - 1];
    if (last && last.seq === m.seq) return; // a replay of the same row
    out.push(m);
  };
  // `noUncheckedIndexedAccess` is on in the consumers' tsconfigs, so every
  // index read is narrowed explicitly rather than asserted away.
  for (;;) {
    const left: RoomMessage | undefined = i < a.length ? a[i] : undefined;
    const right: RoomMessage | undefined = j < b.length ? b[j] : undefined;
    if (!left && !right) break;
    if (!right || (left && left.seq <= right.seq)) {
      if (left) push(left);
      i += 1;
    } else if (right) {
      push(right);
      j += 1;
    }
  }
  return out;
}

export class ZhiyuRoomClient {
  private readonly transport: RoomTransport;
  private readonly roomId: string;
  private readonly tailCount: number;
  private readonly pageSize: number;
  private readonly onCursor: ((seq: number) => void) | null;
  private state: RoomState;
  private readonly listeners = new Set<(s: RoomState) => void>();
  /** Guards against two pollers racing the same cursor. */
  private inFlight = false;

  constructor(opts: ZhiyuRoomClientOptions) {
    this.transport = opts.transport;
    this.roomId = opts.roomId;
    this.tailCount = Math.max(1, Math.floor(opts.tailCount ?? 50));
    this.pageSize = Math.max(1, Math.floor(opts.pageSize ?? 50));
    this.onCursor = opts.onCursor ?? null;
    const resumed = Number(opts.resumedFrom);
    this.state = {
      messages: [],
      cursor: Number.isFinite(resumed) && resumed > 0 ? resumed : 0,
      hasOlder: true,
      loading: false,
      error: null,
    };
  }

  private emit() {
    const snapshot = this.snapshot();
    for (const fn of this.listeners) fn(snapshot);
  }

  private snapshot(): RoomState {
    return { ...this.state, messages: [...this.state.messages] };
  }

  private setCursor(seq: number) {
    if (!Number.isFinite(seq) || seq <= this.state.cursor) return;
    this.state.cursor = seq;
    this.onCursor?.(seq);
  }

  state_(): RoomState {
    return this.snapshot();
  }

  subscribe(fn: (s: RoomState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  /**
   * Open the room.
   *
   * With a resumed cursor: catch up from it (no replay, no gap). Without one:
   * read the tail. Either way the cursor only ever moves forward.
   */
  async start(): Promise<RoomState> {
    this.state.loading = true;
    this.state.error = null;
    this.emit();
    try {
      if (this.state.cursor > 0) {
        await this.catchUp();
      } else {
        const { messages } = await this.transport.page({ tail: this.tailCount, limit: this.tailCount });
        this.state.messages = mergeBySeq([], [...messages].sort((x, y) => x.seq - y.seq));
        const newest = this.state.messages[this.state.messages.length - 1];
        if (newest) this.setCursor(newest.seq);
        // The tail is the beginning of what this client will show; whether
        // anything older exists is answered by the first backward page.
        this.state.hasOlder = messages.length >= this.tailCount;
      }
    } catch (err) {
      this.state.error = (err as Error)?.message ?? "start_failed";
    } finally {
      this.state.loading = false;
      this.emit();
    }
    return this.snapshot();
  }

  /**
   * Read forward until nothing new comes back.
   *
   * One increment is not a catch-up: a client that was away for ten minutes gets
   * a bounded page, and stopping there leaves a hole in the middle of the room
   * that no later read can fill (later reads start after the cursor).
   */
  async catchUp(): Promise<RoomState> {
    if (this.inFlight) return this.snapshot();
    this.inFlight = true;
    try {
      for (;;) {
        const { messages, cursor } = await this.transport.increment(this.state.cursor, 0);
        if (!messages.length) break;
        this.state.messages = mergeBySeq(this.state.messages, messages);
        this.setCursor(Math.max(cursor, messages[messages.length - 1]?.seq ?? 0));
        if (messages.length === 0) break;
        // A short page means the log is exhausted for now; a full page means
        // there may be more behind it.
        if (messages.length < this.pageSize) break;
      }
      this.state.error = null;
    } catch (err) {
      this.state.error = (err as Error)?.message ?? "catch_up_failed";
    } finally {
      this.inFlight = false;
      this.emit();
    }
    return this.snapshot();
  }

  /** One poll of the live transport (long-poll on mobile, SSE tick on web). */
  async poll(waitMs = 0): Promise<RoomState> {
    if (this.inFlight) return this.snapshot();
    this.inFlight = true;
    try {
      const { messages, cursor } = await this.transport.increment(this.state.cursor, waitMs);
      if (messages.length) {
        this.state.messages = mergeBySeq(this.state.messages, messages);
        this.setCursor(Math.max(cursor, messages[messages.length - 1]?.seq ?? 0));
      } else {
        // An empty increment may still move the cursor (a row we are not allowed
        // to see). Honouring it is what stops a private row from pinning the
        // client into re-reading the same window forever.
        this.setCursor(cursor);
      }
      this.state.error = null;
    } catch (err) {
      this.state.error = (err as Error)?.message ?? "poll_failed";
    } finally {
      this.inFlight = false;
      this.emit();
    }
    return this.snapshot();
  }

  /** Page backwards. Prepends; never moves the cursor. */
  async loadOlder(): Promise<RoomState> {
    const oldest = this.state.messages[0];
    if (!oldest || !this.state.hasOlder) return this.snapshot();
    this.state.loading = true;
    this.emit();
    try {
      const { messages } = await this.transport.page({ before: oldest.seq, limit: this.pageSize });
      const fresh = messages.filter((m) => m.seq < oldest.seq).sort((x, y) => x.seq - y.seq);
      if (!fresh.length) {
        this.state.hasOlder = false;
      } else {
        this.state.messages = mergeBySeq(fresh, this.state.messages);
        this.state.hasOlder = fresh.length >= this.pageSize;
      }
      this.state.error = null;
    } catch (err) {
      this.state.error = (err as Error)?.message ?? "page_failed";
    } finally {
      this.state.loading = false;
      this.emit();
    }
    return this.snapshot();
  }

  get room(): string {
    return this.roomId;
  }
}
