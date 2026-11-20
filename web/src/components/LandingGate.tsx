// LandingGate — where a first visit lands (add-role-landing-board).
//
// The decision itself lives in `../lib/landing.ts` (pure, unit-tested). This
// file is the shell around it: read the resolved config, fetch the connection
// projection only when a credential-bearing board actually needs it, navigate.
//
// The server already decided WHERE the user starts and already guaranteed it
// names a visible surface. The one thing it cannot know is whether a board's
// credential is connected — connection state lives only in this process — so
// that check is the client's, and it is the only one.

import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAppConfig } from "@/hooks/useAppConfig";
import { BOARD_CREDENTIAL, boardAvailable, hasBoard } from "@/lib/appCatalog";
import { boardLineOf, resolveLandingTarget } from "@/lib/landing";

const CHAT = "/chat";

export function LandingGate() {
  const { lineBoardsEnabled, resolvedLayout } = useAppConfig();
  // A null layout means an older server or a config fetch that never landed:
  // both go to /chat, exactly as before this change.
  const landing = resolvedLayout?.landing ?? CHAT;
  const line = boardLineOf(landing);
  // Only a credential-bearing board needs the round trip; a nav landing or a
  // no-credential board must not wait on one before the first paint.
  const needsCredentials = Boolean(line && hasBoard(line) && BOARD_CREDENTIAL[line]);
  const [states, setStates] = useState<Record<string, string> | null>(null);
  const [settled, setSettled] = useState(!needsCredentials);

  useEffect(() => {
    if (!needsCredentials) {
      setSettled(true);
      return;
    }
    let cancelled = false;
    fetch("/api/connections")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        // Same projection AppCenterPage builds: the payload is a list; the
        // decision needs the `id → state` map `boardAvailable()` reads.
        const byId: Record<string, string> = {};
        for (const item of body?.connections ?? []) {
          if (item && typeof item.id === "string") byId[item.id] = item.state;
        }
        setStates(byId);
      })
      .catch(() => {
        /* unreachable server = not connected, same as every board entry */
      })
      .finally(() => {
        if (!cancelled) setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [needsCredentials]);

  if (!settled) return null;

  const target = resolveLandingTarget({
    landing,
    states,
    lineBoardsEnabled,
    nav: resolvedLayout?.nav ?? null,
    boardAvailable: (l, s) => boardAvailable(l, s, lineBoardsEnabled),
    needsCredential: (l) => Boolean(BOARD_CREDENTIAL[l]),
  });
  return <Navigate to={target} replace />;
}
