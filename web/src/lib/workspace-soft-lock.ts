// Multi-tab soft lock (add-agent-builder-workspace 8.3). Two browser tabs on
// the same document don't fight over writes — the 409 conflict banner already
// guards the data (batch 1) — but the second tab deserves a heads-up BEFORE it
// starts typing. A BroadcastChannel whisper does exactly that: "another window
// has this document open" is a NOTICE, never a takeover (no read-only mode, no
// stealing the doc back). The channel name is scoped per document; opening in
// tab B pings tab A, and A answers once so B learns about A too. The seen-set
// truncates the echo (an ack is only ever sent to a NEW peer id), so two tabs
// cannot ping-pong each other into a loop.
import { useEffect, useRef, useState } from "react";

const CHANNEL_PREFIX = "platform.studio.doc:";

export function useDocSoftLock(docId: string | null) {
  const [otherOpen, setOtherOpen] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const selfIdRef = useRef<string>("");

  useEffect(() => {
    setOtherOpen(false);
    if (!docId || typeof BroadcastChannel === "undefined") return;
    const selfId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    selfIdRef.current = selfId;
    const seen = new Set<string>([selfId]);
    const ch = new BroadcastChannel(CHANNEL_PREFIX + docId);
    channelRef.current = ch;
    const ping = () => ch.postMessage({ type: "open", from: selfId });
    ch.onmessage = (e: MessageEvent) => {
      const from = e.data?.from;
      if (e.data?.type !== "open" || typeof from !== "string" || seen.has(from)) return;
      seen.add(from);
      setOtherOpen(true);
      // Answer once so the newcomer learns about us; the seen-set stops the
      // reply from bouncing back and forth forever.
      ch.postMessage({ type: "open", from: selfId });
    };
    ping();
    // Re-ping on focus: a tab that slept while B opened learns about it late
    // (its own id is already in every peer's seen-set, so this stays quiet).
    const onFocus = () => ping();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      ch.close();
      channelRef.current = null;
    };
  }, [docId]);

  return { otherOpen, dismiss: () => setOtherOpen(false) };
}
