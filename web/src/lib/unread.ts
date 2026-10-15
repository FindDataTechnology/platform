// Client-side unread derivation (spec: scheduled-task-notifications).
// Unread = the session's updatedAt is newer than the last time the user
// opened that session on THIS client. No server read-tracking, no new
// events — the sessions payload already carries updatedAt.

const KEY = "platform.sessionLastSeen";

export type LastSeenMap = Record<string, string>;

export function getLastSeen(): LastSeenMap {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

export function markSessionSeen(id: string): LastSeenMap {
  const next = { ...getLastSeen(), [id]: new Date().toISOString() };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full/blocked — unread state just stops persisting.
  }
  return next;
}

export function isSessionUnseen(
  session: { id: string; updatedAt?: string | number | null },
  lastSeen: LastSeenMap,
): boolean {
  if (!session.updatedAt) return false;
  const updated = new Date(session.updatedAt).toISOString();
  const seen = lastSeen[session.id];
  return !seen || updated > seen;
}
