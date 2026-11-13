// web/src/lib/zhiyu-room-transport.ts — the browser's transport for the shared
// room state machine (openspec: add-zhiyu-mobile-clients, task 2.2).
//
// Web is the only client that can hold a stream open, so its transport is the
// only one that is event-driven. Everything else about the room — where the
// first screen starts, how a reconnect catches up, how older pages prepend, and
// what the cursor means — is the shared state machine in
// `@platform/core/zhiyu-room-client`, which this adapter feeds.
//
// The point of writing it as a transport rather than letting the page keep its
// own `EventSource` + `setRows` loop: the page's loop had to remember four
// things (dedupe on reconnect, tail-first, prepend on demand, never rewind the
// cursor) and the mobile clients had to remember the same four. One of the two
// was going to get them right.
//
// Overlays (`event: overlay` — live deltas and agent lifecycle) are deliberately
// NOT part of `RoomTransport`: they are seq-less and never persisted, so they
// cannot be replayed, which is the one thing the cursor model is built on. They
// ride the same connection and are handed to `onOverlay`.

import type { RoomMessage, RoomTransport } from "@platform/core";

/** The `EventSource` surface this adapter needs — injected so tests can fake it. */
export interface EventSourceLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  addEventListener: (type: string, fn: (ev: { data: string }) => void) => void;
  close: () => void;
}

export interface EventSourceFactory {
  (url: string): EventSourceLike;
}

export interface EventSourceTransportOptions {
  roomId: string;
  /** `fetch` from the page, or a stub in tests. */
  request: (path: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  /** `window.EventSource` in the browser; required (there is no sensible default in core). */
  eventSource: EventSourceFactory;
  /** Live, seq-less frames (agent deltas, lifecycle). Not replayed, not persisted. */
  onOverlay?: (payload: unknown) => void;
  /** Open/close notifications for a "connection changed" hint. */
  onConnectionChange?: (open: boolean) => void;
}

export interface EventSourceTransport extends RoomTransport {
  /** Tear the connection down (page unmount). */
  close(): void;
  /** Where the stream is currently positioned — for the page's own diagnostics. */
  streamCursor(): number;
}

/**
 * One `EventSource`, one buffer, one cursor.
 *
 * `increment(after, waitMs)` resolves from the buffer as soon as anything newer
 * than `after` has arrived, and resolves EMPTY with the same cursor when the
 * wait window closes. That is the same contract the polling transport honours,
 * which is what lets one state machine drive both.
 */
export function createEventSourceTransport(opts: EventSourceTransportOptions): EventSourceTransport {
  const room = encodeURIComponent(opts.roomId);
  const buffer: RoomMessage[] = [];
  let waiters: Array<() => void> = [];
  let stream: EventSourceLike | null = null;
  let positionedAt = 0;
  let closed = false;

  const wake = () => {
    const pending = waiters;
    waiters = [];
    for (const fn of pending) fn();
  };

  const ensureStream = () => {
    if (stream || closed) return;
    stream = opts.eventSource(`/api/zhiyu/rooms/${room}/events${positionedAt ? `?after=${positionedAt}` : ""}`);
    stream.onopen = () => opts.onConnectionChange?.(true);
    stream.onmessage = (ev) => {
      let row: RoomMessage;
      try {
        row = JSON.parse(ev.data) as RoomMessage;
      } catch {
        return;
      }
      if (!row || !Number.isFinite(row.seq)) return;
      // The stream replays from our cursor on every reconnect, so the same seq
      // can arrive twice; keeping the newest position makes the buffer a set.
      if (row.seq <= positionedAt) return;
      positionedAt = row.seq;
      buffer.push(row);
      wake();
    };
    stream.onerror = () => opts.onConnectionChange?.(false);
    stream.addEventListener("overlay", (ev) => {
      try {
        opts.onOverlay?.(JSON.parse(ev.data));
      } catch {
        /* a malformed overlay is not worth breaking the stream over */
      }
    });
  };

  /**
   * Hand back everything newer than `after` and forget the rest.
   *
   * Rows at or below the caller's cursor are dead weight: the state machine
   * only ever moves forward, so nothing in the buffer can become useful again.
   */
  const takeBuffer = (after: number): RoomMessage[] => {
    const fresh = buffer.filter((r) => r.seq > after);
    buffer.length = 0;
    return fresh;
  };

  return {
    async page({ tail, before, after, limit = 50 }) {
      const query =
        tail !== undefined
          ? `tail=${tail}`
          : before !== undefined
            ? `before=${before}&limit=${limit}`
            : `after=${after ?? 0}&limit=${limit}`;
      const res = await opts.request(`/api/zhiyu/rooms/${room}/messages?${query}`);
      if (!res.ok) throw new Error(`messages_${res.status}`);
      const body = (await res.json()) as { messages?: RoomMessage[] };
      return { messages: Array.isArray(body?.messages) ? body.messages : [] };
    },

    async increment(after, waitMs) {
      // (Re)open positioned at the caller's cursor. The state machine owns the
      // cursor, so the stream follows it rather than the other way round.
      if (!stream) {
        positionedAt = Math.max(positionedAt, after);
        ensureStream();
      }
      const buffered = takeBuffer(after);
      if (buffered.length) {
        const cursor = Math.max(after, buffered[buffered.length - 1]!.seq);
        return { messages: buffered, cursor };
      }

      const waited = await new Promise<RoomMessage[]>((resolve) => {
        const done = () => {
          waiters = waiters.filter((w) => w !== done);
          resolve(takeBuffer(after));
        };
        waiters.push(done);
        if (waitMs > 0) setTimeout(done, waitMs);
      });
      const cursor = waited.length ? Math.max(after, waited[waited.length - 1]!.seq) : after;
      return { messages: waited, cursor };
    },

    close() {
      closed = true;
      // Resolve anything still waiting BEFORE dropping the waiters: a poll left
      // hanging on unmount keeps its promise (and the component) alive.
      wake();
      buffer.length = 0;
      stream?.close();
      stream = null;
    },

    streamCursor() {
      return positionedAt;
    },
  };
}
