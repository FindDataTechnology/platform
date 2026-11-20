// zhiyu-mobile-model — the room screen's state rules, as pure functions
// (openspec: add-zhiyu-mobile-clients, tasks 3.3 / 3.4).
//
// The page itself can only be exercised on a phone, so everything a phone is
// supposed to DO is kept here, where node can assert it: what an incoming
// increment does to the row list, what paging back does, what a transport
// downgrade must NOT do (drop the draft, clear the screen), and when the send
// button is live.
//
// No Taro, no `@platform/core` runtime import — this file is imported by the
// page and by `zhiyu-mobile-model.test.mjs`.

export type TransportMode = "longpoll" | "shortpoll";

export interface RoomRow {
  seq: number;
  kind: string;
  content: string;
}

export interface PresenceEntry {
  id: string;
  display: string;
  kind: string;
  presence: string;
}

export interface RoomScreenState {
  roomId: string;
  rows: RoomRow[];
  /** Newest seq this screen has seen. Never decreases. */
  cursor: number;
  hasOlder: boolean;
  loadingOlder: boolean;
  /** What the user is typing (or what a take transcribed). Survives everything. */
  draft: string;
  sending: boolean;
  recording: boolean;
  transport: TransportMode;
  /** Consecutive transport failures — drives the connection note, nothing else. */
  failures: number;
  presence: PresenceEntry[];
  error: string | null;
}

export function initialScreen(roomId: string): RoomScreenState {
  return {
    roomId,
    rows: [],
    cursor: 0,
    hasOlder: false,
    loadingOlder: false,
    draft: "",
    sending: false,
    recording: false,
    transport: "longpoll",
    failures: 0,
    presence: [],
    error: null,
  };
}

/** Merge by seq, keeping the first occurrence — a reconnect replays rows. */
export function mergeRows(existing: RoomRow[], incoming: RoomRow[]): RoomRow[] {
  const bySeq = new Map<number, RoomRow>();
  for (const r of existing) bySeq.set(r.seq, r);
  for (const r of incoming) if (!bySeq.has(r.seq)) bySeq.set(r.seq, r);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** One increment landed: append, advance the cursor, clear the failure count. */
export function applyIncoming(state: RoomScreenState, incoming: { messages: RoomRow[]; cursor: number }): RoomScreenState {
  const messages = Array.isArray(incoming.messages) ? incoming.messages : [];
  const rows = messages.length ? mergeRows(state.rows, messages) : state.rows;
  const newest = messages.length ? messages[messages.length - 1]!.seq : 0;
  return {
    ...state,
    rows,
    cursor: Math.max(state.cursor, Number(incoming.cursor) || 0, newest),
    // A success is what makes the connection note disappear again.
    failures: 0,
    transport: "longpoll",
    error: null,
  };
}

/** An older window landed: prepend it. The cursor is newest-seen, so it stays. */
export function applyOlder(state: RoomScreenState, older: { messages: RoomRow[] }): RoomScreenState {
  const messages = (Array.isArray(older.messages) ? older.messages : []).filter((m) => state.rows.every((r) => r.seq !== m.seq));
  return {
    ...state,
    rows: mergeRows([...messages, ...state.rows], []),
    hasOlder: messages.length > 0,
    loadingOlder: false,
    error: null,
  };
}

export function beginLoadingOlder(state: RoomScreenState): RoomScreenState {
  return { ...state, loadingOlder: true };
}

/**
 * A failed request. The draft is untouched on purpose: a flaky network must
 * never cost the user their sentence (3.4).
 */
export function applyFailure(state: RoomScreenState, message: string): RoomScreenState {
  const failures = state.failures + 1;
  return {
    ...state,
    failures,
    // One failure is a blip; two in a row is a downgrade the user should be
    // told about (the cadence really did change).
    transport: failures >= 2 ? "shortpoll" : state.transport,
    error: failures >= 2 ? message : state.error,
  };
}

/**
 * Sync the note with the driver's own failure count.
 *
 * The page does not count failures itself — `PollDriver` does, and this only
 * translates that number into the readable mode. Two consecutive failures is
 * where a long poll stops being worth trying (a parked request on a bad network
 * burns its whole window to learn nothing).
 */
export function syncFailures(state: RoomScreenState, failures: number): RoomScreenState {
  const n = Math.max(0, Math.floor(Number(failures) || 0));
  return { ...state, failures: n, transport: n >= 2 ? "shortpoll" : "longpoll" };
}

/** The hold a transport should use right now: 0 once short-polling. */
export function holdFor(transport: TransportMode): number {
  return transport === "shortpoll" ? 0 : 5_000;
}

/** The user typed / a take was transcribed. Never touches rows or the transport. */
export function setDraft(state: RoomScreenState, draft: string): RoomScreenState {
  return { ...state, draft };
}

export function setRecording(state: RoomScreenState, recording: boolean): RoomScreenState {
  return { ...state, recording };
}

/**
 * A transcribed take goes INTO the composer — it is not sent (add-voice-input
 * spec: 说完可改再发). Empty transcripts leave the draft alone.
 */
export function transcriptIntoDraft(state: RoomScreenState, text: string): RoomScreenState {
  const clean = String(text ?? "").trim();
  if (!clean) return state;
  const joined = state.draft.trim() ? `${state.draft}${state.draft.endsWith(" ") ? "" : " "}${clean}` : clean;
  return { ...state, draft: joined, recording: false };
}

export function canSend(state: RoomScreenState): boolean {
  return !state.sending && state.draft.trim().length > 0;
}

/** Take the draft for sending. The screen clears it only once the server took it. */
export function takeDraft(state: RoomScreenState): { text: string; state: RoomScreenState } {
  const text = state.draft.trim();
  return { text, state: { ...state, sending: true } };
}

export function applySent(state: RoomScreenState): RoomScreenState {
  return { ...state, sending: false, draft: "" };
}

/** A failed send puts the text BACK: losing it is worse than a duplicate tap. */
export function applySendFailed(state: RoomScreenState, message: string): RoomScreenState {
  return { ...state, sending: false, error: message };
}

/**
 * The readable transport note (3.4).
 *
 * `null` means "nothing to say" — a connection that has always been a long poll
 * is not news. Once it degrades the user is told the cadence changed, because a
 * room that suddenly updates every few seconds looks broken otherwise.
 */
export function connectionNote(transport: TransportMode): string | null {
  return transport === "shortpoll" ? "网络较慢，已改为短轮询，消息仍会到达" : null;
}

/**
 * The read-only presence strip at the bottom of the room.
 *
 * Read-only on purpose: mobile does not manage seats (5.1). Returns one line,
 * because a phone has no room for a roster panel.
 */
export function presenceLine(presence: PresenceEntry[], max = 3): string {
  const named = presence.filter((p) => p.presence === "active" || p.presence === "on_duty");
  if (!named.length) return "暂无人在场";
  const shown = named.slice(0, max).map((p) => p.display || p.id);
  const rest = named.length - shown.length;
  return rest > 0 ? `${shown.join("、")} 等 ${named.length} 人在场` : `${shown.join("、")} 在场`;
}

/** System event rows are not bubbles — they are triggers (a join, a take-over, an end). */
export function isRenderableRow(row: RoomRow): boolean {
  return row.kind === "human" || row.kind === "agent";
}
