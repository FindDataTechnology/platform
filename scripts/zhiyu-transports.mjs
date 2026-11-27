// zhiyu-transports — the three ways a client can consume a room, as
// `RoomTransport` implementations (openspec: add-zhiyu-mobile-clients 4.2 /
// 7.1).
//
// The change's claim is that the three clients differ ONLY in transport. That
// claim is cheap to write and expensive to be wrong about, so this module gives
// the parity harness three adapters over the SAME endpoints the real clients
// use:
//
//   sse      — web. Opens `/events` and reads `data:` frames. Holds a
//              connection open.
//   polling  — mini-program. Asks `/stream?after=&wait=`; the server holds the
//              request for us (a long poll is a normal request to us).
//   paged    — the app on a flaky network, and the fallback when a long poll
//              keeps dying. Asks `/messages?after=` and returns immediately; the
//              CALLER's ladder decides when to ask again.
//
// All three hand back the same `{ messages, cursor }`, where the cursor is the
// last row HANDED BACK — never the row we asked after. That single rule is what
// makes the shared state machine safe to run over any of them.

/** The `RoomTransport` shape from packages/core/src/zhiyu-room-client.ts. */
export function sseTransport({ base, roomId, headers = {}, holdMs = 2_000 }) {
  const room = encodeURIComponent(roomId);
  return {
    async page({ tail, before, after, limit = 50 }) {
      const query =
        tail !== undefined ? `tail=${tail}` : before !== undefined ? `before=${before}&limit=${limit}` : `after=${after ?? 0}&limit=${limit}`;
      const res = await fetch(`${base}/api/zhiyu/rooms/${room}/messages?${query}`, { headers });
      if (!res.ok) throw new Error(`messages_${res.status}`);
      const body = await res.json();
      return { messages: Array.isArray(body?.messages) ? body.messages : [] };
    },

    /**
     * One SSE window. The server pumps on connect and then every `ssePollMs`,
     * so "wait for something new" is a matter of how long we hold the reader.
     */
    async increment(after, waitMs) {
      const hold = Math.max(0, Math.floor(waitMs ?? holdMs));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), hold + holdMs);
      const decoder = new TextDecoder();
      const messages = [];
      let buffer = "";
      try {
        const res = await fetch(`${base}/api/zhiyu/rooms/${room}/events?after=${after}`, { headers, signal: ac.signal });
        if (!res.ok) throw new Error(`events_${res.status}`);
        const reader = res.body.getReader();
        const deadline = Date.now() + hold;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const cut = buffer.indexOf("\n\n");
            if (cut < 0) break;
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) messages.push(JSON.parse(line.slice(6)));
          }
          // A short hold is "whatever is already there"; a long one waits for
          // the first row. Either way we stop as soon as we have something.
          if (messages.length) break;
          if (Date.now() > deadline) break;
        }
        await reader.cancel().catch(() => {});
      } catch (err) {
        if (err?.name !== "AbortError") throw err;
      } finally {
        clearTimeout(timer);
        ac.abort();
      }
      const cursor = messages.length ? messages[messages.length - 1].seq : after;
      return { messages, cursor };
    },
  };
}

export function pollingTransport({ base, roomId, headers = {}, waitMs = 2_000 }) {
  const room = encodeURIComponent(roomId);
  return {
    async page({ tail, before, after, limit = 50 }) {
      const query =
        tail !== undefined ? `tail=${tail}` : before !== undefined ? `before=${before}&limit=${limit}` : `after=${after ?? 0}&limit=${limit}`;
      const res = await fetch(`${base}/api/zhiyu/rooms/${room}/messages?${query}`, { headers });
      if (!res.ok) throw new Error(`messages_${res.status}`);
      const body = await res.json();
      return { messages: Array.isArray(body?.messages) ? body.messages : [] };
    },

    async increment(after, wait) {
      const hold = Math.max(0, Math.floor(wait ?? waitMs));
      const res = await fetch(`${base}/api/zhiyu/rooms/${room}/stream?after=${after}&wait=${hold}`, { headers });
      if (!res.ok) throw new Error(`stream_${res.status}`);
      const body = await res.json();
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const cursor = Number.isFinite(body?.cursor) ? Number(body.cursor) : messages.length ? messages[messages.length - 1].seq : after;
      return { messages, cursor };
    },
  };
}

export function pagedTransport({ base, roomId, headers = {}, pageSize = 50 }) {
  const room = encodeURIComponent(roomId);
  return {
    async page({ tail, before, after, limit = pageSize }) {
      const query =
        tail !== undefined ? `tail=${tail}` : before !== undefined ? `before=${before}&limit=${limit}` : `after=${after ?? 0}&limit=${limit}`;
      const res = await fetch(`${base}/api/zhiyu/rooms/${room}/messages?${query}`, { headers });
      if (!res.ok) throw new Error(`messages_${res.status}`);
      const body = await res.json();
      return { messages: Array.isArray(body?.messages) ? body.messages : [] };
    },

    /** No hold at all: "what is new" is one page, and the caller decides when to ask again. */
    async increment(after) {
      const res = await fetch(`${base}/api/zhiyu/rooms/${room}/messages?after=${after}&limit=${pageSize}`, { headers });
      if (!res.ok) throw new Error(`messages_${res.status}`);
      const body = await res.json();
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const cursor = messages.length ? messages[messages.length - 1].seq : after;
      return { messages, cursor };
    },
  };
}

/** The three adapters, in the order the harness reports them. */
export const TRANSPORT_KINDS = Object.freeze(["sse", "polling", "paged"]);

export function transportFor(kind, opts) {
  switch (kind) {
    case "sse":
      return sseTransport(opts);
    case "polling":
      return pollingTransport(opts);
    case "paged":
      return pagedTransport(opts);
    default:
      throw new Error(`unknown transport: ${kind}`);
  }
}

/**
 * Compare three views field by field.
 *
 * Returns `[]` when they agree, and one string per disagreement otherwise —
 * with the field name and both values, because "views differ" is not a bug
 * report anybody can act on.
 */
export function diffViews(views) {
  const entries = Object.entries(views);
  const [firstKind, first] = entries[0] ?? [];
  const out = [];
  if (!firstKind) return ["no views to compare"];
  for (const [kind, view] of entries.slice(1)) {
    if (view.length !== first.length) {
      out.push(`${kind}: ${view.length} rows vs ${first.length} (${firstKind})`);
      continue;
    }
    for (let i = 0; i < view.length; i += 1) {
      const a = first[i];
      const b = view[i];
      for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
        if (JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key])) {
          out.push(`${kind}: row ${i} field ${key}: ${JSON.stringify(b?.[key])} vs ${JSON.stringify(a?.[key])} (${firstKind})`);
        }
      }
    }
  }
  return out;
}
