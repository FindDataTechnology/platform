import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Menu } from "lucide-react";
import { useChatStore } from "@platform/core";
import { Chat } from "@/components/Chat";
import { ChatHeader } from "@/components/ChatHeader";
import { ChatWelcome } from "@/components/ChatWelcome";
import { Composer } from "@/components/Composer";
import { PlanPanel } from "@/components/PlanPanel";
import type { ClientMessage } from "@platform/core";

// Chat page: the empty state (ChatWelcome) and the in-session state
// (ChatHeader + Chat + Composer) are mutually exclusive — they never render
// together. The branch is keyed on `turns.length === 0` per design D1: the
// welcome is a "no turns" affordance, the header takes over once the user
// starts or resumes a conversation. `clearView` flips back to the welcome.
//
// The composer draft is owned HERE (not inside Composer) so it survives the
// welcome → in-session branch swap, and so ChatWelcome's suggested-prompt
// cards can prefill it: clicking a card fills the composer and focuses it —
// the user stays in control of what actually gets sent.
//
// Sessions are deep-linkable: /chat/:sessionId loads that session, and the
// URL follows the active session both ways (refresh and back keep context).
interface Props {
  send: (m: ClientMessage) => void;
  // Toggles the off-canvas nav drawer (below md, rendered by App).
  onToggleNav?: () => void;
}

export function ChatPage({ send, onToggleNav }: Props) {
  const { t } = useTranslation();
  const { sessionId: urlSessionId } = useParams();
  // Length-and-pending subscription: this page branches on emptiness —
  // subscribing to the whole turns array would re-render it per streamed
  // token. An optimistic session switch clears turns the instant the request
  // leaves (perf-session-open), and that pending view belongs to the
  // transcript's skeleton, not the welcome.
  const isEmpty = useChatStore((s) => s.turns.length === 0 && s.pendingSession === null);
  const status = useChatStore((s) => s.status);
  const currentSessionId = useChatStore((s) => s.currentSessionId);

  const [draft, setDraft] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  const prefillComposer = (text: string) => {
    setDraft(text);
    setFocusTick((n) => n + 1);
  };

  // Cross-page handoff in: a page that parked a draft (library "Start
  // conversation") navigates here with the WS store carrying it. Consume
  // exactly once — mount-time read + clear — so a stale draft can never leak
  // into a later visit.
  useEffect(() => {
    const parked = useChatStore.getState().composerDraft;
    if (parked) {
      useChatStore.getState().setComposerDraft(null);
      setDraft(parked);
      setFocusTick((n) => n + 1);
    }
  }, []);

  // Deep link in: a session id in the URL that isn't current loads it. The URL
  // changes ONLY through user navigation (sidebar rows / new chat navigate
  // explicitly; refresh keeps its place) — a reactive URL-follows-session
  // effect here would race this one and ping-pong switch_session between the
  // stale URL and the fresh session id.
  //
  // The serviced-url ref is what kills the ping-pong (perf-session-open): the
  // optimistic flip moves `currentSessionId` synchronously while the router
  // param lags a render, so an effect keyed on their (dis)agreement "corrects"
  // a just-clicked switch back toward the stale URL. Service each URL change
  // exactly once; a restore after a failed switch intentionally does not
  // re-arm (the row re-click is the retry). A URL seen while the socket is
  // still connecting is NOT serviced — the send would be lost and the ref
  // would suppress the retry — so it waits for `status` to arm the effect.
  const servicedUrlRef = useRef<string | null | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `status` is a deliberate trigger — a URL first seen while connecting must re-arm once the socket opens (the send would have been dropped)
  useEffect(() => {
    if (urlSessionId === servicedUrlRef.current) return;
    if (urlSessionId && urlSessionId !== currentSessionId) {
      if (useChatStore.getState().status !== "connected") return;
      servicedUrlRef.current = urlSessionId;
      send({ type: "switch_session", id: urlSessionId });
      return;
    }
    servicedUrlRef.current = urlSessionId;
  }, [urlSessionId, currentSessionId, status, send]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Nav drawer toggle: below md the rail is off-canvas, so BOTH states
          (welcome and in-session) need the handle — it sits at the page's
          top-left, above the state branch. */}
      {onToggleNav && (
        <div className="flex items-center border-b border-border bg-card px-3 py-1.5 md:hidden">
          <button
            type="button"
            onClick={onToggleNav}
            aria-label={t("nav.openMenu")}
            data-testid="nav-toggle"
            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="ml-1 truncate text-xs text-muted-foreground">
            {t("sidebar.brand")}
          </span>
        </div>
      )}
      {/* A dropped socket used to be legible only in the sidebar's 6px status
          dot — and it stranded the streaming state. The store now finalizes
          the turn on disconnect; this banner names what happened while the
          WS hook's backoff reconnects. */}
      {status === "disconnected" && (
        <div
          data-testid="connection-banner"
          className="flex items-center gap-2 border-b border-border bg-card px-4 py-2 text-xs text-muted-foreground"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-destructive" />
          {t("chat.connectionLost")}
          <button
            type="button"
            data-testid="connection-retry"
            onClick={() => window.dispatchEvent(new Event("platform:reconnect"))}
            className="ml-1 rounded-md border border-border px-2 py-0.5 text-xs text-foreground hover:bg-muted"
          >
            {t("chat.retry")}
          </button>
        </div>
      )}
      {/* Two columns: the chat column (header + log + composer) and, on wide
          viewports with a live plan, the progress panel beside it. The panel
          unmounts when the plan is empty, so the chat column re-centers with
          no reserved gutter (add-plan-progress-panel). */}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {isEmpty ? (
            <>
              <ChatWelcome onPrefill={prefillComposer} send={send} />
              <Composer send={send} value={draft} onChange={setDraft} focusTick={focusTick} />
            </>
          ) : (
            <>
              <ChatHeader send={send} />
              <Chat send={send} onPrefill={prefillComposer} />
              <Composer send={send} value={draft} onChange={setDraft} focusTick={focusTick} />
            </>
          )}
        </div>
        <PlanPanel />
      </div>
    </main>
  );
}

// Re-export for the Ctrl+O shortcut helper if needed elsewhere.
export const useChatToggleAll = useChatStore;
