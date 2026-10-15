// Demo-sandbox session wipe (openspec: mp-demo-sandbox).
//
// The accountless demo pod is a SHARED runtime: without a wipe every
// stranger's sessions would pile up in the sidebar for the next visitor. This
// step — called on a timer by server.js — starts a fresh session and deletes
// every prior one, while never touching a streaming turn (a wipe mid-turn
// would orphan the running dsh exchange). Dependencies are injected so the
// logic is testable against fakes; the pod's ephemeral volume means a pod
// recreation is a full reset regardless of this timer.

export async function wipeSandboxSessions({ isStreaming, listSessions, deleteSession, startNewSession, currentSessionId }) {
  if (isStreaming()) return { skipped: "streaming" };

  const sessions = await listSessions();
  if (sessions.length === 0) return { wiped: 0, skipped: "empty" };

  // A fresh session becomes the active one — deleteSession refuses to remove
  // the active session, which is exactly the guard we want.
  await startNewSession();
  const activeId = currentSessionId();

  let wiped = 0;
  let failed = 0;
  for (const s of sessions) {
    if (s.id === activeId) continue;
    try {
      await deleteSession(s.id);
      wiped += 1;
    } catch {
      failed += 1;
    }
  }
  return { wiped, failed, activeId };
}
