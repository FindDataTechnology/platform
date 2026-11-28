// Message log. Renders turns; auto-scrolls to bottom unless the user scrolled up.
// Owns the message-level actions wiring: copy lives inside AssistantTurn;
// edit-and-resend goes to the LAST user turn; regenerate re-sends the last
// user prompt from the LAST assistant turn. Also owns the outline rail
// (add-chat-outline): a floating user-turn index over the transcript's right
// edge whose entries jump to a turn via jumpToTurn.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";
import { useChatStore } from "@platform/core";
import { ChatOutline } from "@/components/ChatOutline";
import { UserTurn } from "@/components/UserTurn";
import { AssistantTurn } from "@/components/AssistantTurn";
import type { ClientMessage } from "@platform/core";

interface Props {
  send: (m: ClientMessage) => void;
  onPrefill: (text: string) => void;
}

// Render the outline only past this many user turns — below it the rail is
// noise on a conversation the user can see whole (spec: threshold).
const OUTLINE_MIN_USER_TURNS = 3;

// Render windowing (perf-session-open; now data-backed by polish-web-surfaces):
// only the transcript's tail mounts on open — Markdown/chart mount cost per turn
// is what makes a several-hundred-turn session janky. The store holds the LOADED
// window (the server sends the tail on open); "load earlier" either grows this
// window within the loaded turns or fetches the previous page from the server.
const WINDOW_INITIAL = 50;
const WINDOW_STEP = 50;

export function Chat({ send, onPrefill }: Props) {
  const { t } = useTranslation();
  const turns = useChatStore((s) => s.turns);
  const isStreaming = useChatStore((s) => s.isStreaming);
  // A prompt waiting behind another session's turn (concurrent-chat-sessions).
  // Not a transcript turn — a queued prompt has no history row until it
  // dispatches — so it renders as its own pending bubble.
  const queuedTurn = useChatStore((s) => s.queuedTurn);
  const pendingSession = useChatStore((s) => s.pendingSession);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  // Windowed transcript (polish-web-surfaces): the loaded window's paging state.
  const transcriptHasMore = useChatStore((s) => s.transcriptHasMore);
  const transcriptTotal = useChatStore((s) => s.transcriptTotal);
  const transcriptOldestSeq = useChatStore((s) => s.transcriptOldestSeq);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const flashTimerRef = useRef<number | null>(null);

  // ── Windowing state ──────────────────────────────────────────────────────
  const [windowSize, setWindowSize] = useState(WINDOW_INITIAL);
  // Reset when the VIEWED SESSION changes — a same-session background refresh
  // (cached re-entry reconcile) must not collapse the user's expanded window.
  // Render-phase adjust (not an effect): the first frame of the new session
  // must already carry the fresh window.
  const windowedSessionRef = useRef(currentSessionId);
  if (windowedSessionRef.current !== currentSessionId) {
    windowedSessionRef.current = currentSessionId;
    setWindowSize(WINDOW_INITIAL);
  }

  // Scroll anchoring for load-earlier: capture the geometry before the
  // prepend, restore the offset after it commits.
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  // An outline jump whose target sits above the current window: expand first,
  // complete the scroll once the target has mounted.
  const pendingJumpRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: windowSize/turns are the deliberate triggers — run after a window expansion (or any turn-list swap) settles its DOM; flashTurn/stickToBottomRef are stable per-render closures the linter cannot see are refs
  useLayoutEffect(() => {
    const el = containerRef.current;
    const anchor = prependAnchorRef.current;
    if (el && anchor) {
      prependAnchorRef.current = null;
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
      return;
    }
    const jumpId = pendingJumpRef.current;
    if (el && jumpId) {
      const target = document.getElementById(`turn-${jumpId}`);
      if (target) {
        pendingJumpRef.current = null;
        stickToBottomRef.current = false;
        target.scrollIntoView({ block: "start" });
        flashTurn(target);
      }
    }
  }, [windowSize, turns]);

  const loadEarlier = () => {
    const el = containerRef.current;
    if (el) prependAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    // The server still holds earlier messages (windowed payload, polish-web-surfaces):
    // fetch the previous page. The local render window grows with it so the page
    // actually mounts.
    if (transcriptHasMore && currentSessionId && transcriptOldestSeq !== null) {
      setLoadingEarlier(true);
      setWindowSize((n) => n + WINDOW_STEP);
      send({ type: "load_earlier", id: currentSessionId, beforeSeq: transcriptOldestSeq });
      return;
    }
    // Everything is loaded: expand the local render window only.
    setWindowSize((n) => n + WINDOW_STEP);
  };

  // A page (session_page) prepends turns; clear the pending flag when the window
  // grows (or the session changes) so the affordance never sticks disabled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: turns.length/currentSessionId are the deliberate triggers for a settled page
  useEffect(() => {
    setLoadingEarlier(false);
  }, [turns.length, currentSessionId]);

  const hiddenCount = Math.max(0, turns.length - windowSize);
  const visible = hiddenCount > 0 ? turns.slice(turns.length - windowSize) : turns;
  // What "load earlier" would reveal: turns scrolled out of the local window
  // PLUS turns the server has not sent yet (windowed payload). Older servers
  // send no counts, so transcriptTotal falls back to the loaded length and this
  // reduces to hiddenCount — today's behavior.
  const visibleCount = Math.min(windowSize, turns.length);
  const remaining = Math.max(hiddenCount, Math.max(0, transcriptTotal - visibleCount));
  const showLoadEarlier = transcriptHasMore || remaining > 0;

  // Last-of-role flags over the COMPLETE list (edit/regenerate target the
  // actual last turns even when earlier ones are windowed out) — one O(n)
  // pass instead of a per-turn slice scan.
  const { lastUserIndex, lastAssistantIndex } = useMemo(() => {
    let lu = -1;
    let la = -1;
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (!t) continue;
      if (lu < 0 && t.role === "user") lu = i;
      if (la < 0 && t.role === "assistant") la = i;
      if (lu >= 0 && la >= 0) break;
    }
    return { lastUserIndex: lu, lastAssistantIndex: la };
  }, [turns]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      // If we're within ~40px of the bottom, keep sticking.
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      stickToBottomRef.current = nearBottom;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `turns` is the deliberate trigger — scroll to bottom when a turn is added
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  // Outline jump: release stick-to-bottom FIRST so streaming deltas cannot
  // yank the view back (the scroll listener re-arms it when the user returns
  // to the bottom), then smooth-scroll and flash the target turn. A target
  // above the render window expands the window and defers the scroll to the
  // layout effect that sees it mounted.
  const flashTurn = (el: HTMLElement) => {
    el.classList.remove("outline-jump-flash");
    // Force reflow so a rapid re-tap of the same turn restarts the animation.
    void el.offsetWidth;
    el.classList.add("outline-jump-flash");
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => el.classList.remove("outline-jump-flash"), 1200);
  };

  const jumpToTurn = (id: string) => {
    const el = document.getElementById(`turn-${id}`);
    if (!el) {
      const idx = turns.findIndex((t) => t.id === id);
      if (idx < 0) {
        // Not in the loaded window (windowed payload, polish-web-surfaces): pull
        // the previous page and retry — the pending jump survives the prepend
        // and the layout effect completes it once the target mounts.
        if (transcriptHasMore && currentSessionId && transcriptOldestSeq !== null) {
          pendingJumpRef.current = id;
          setLoadingEarlier(true);
          setWindowSize((n) => n + WINDOW_STEP);
          send({ type: "load_earlier", id: currentSessionId, beforeSeq: transcriptOldestSeq });
        }
        return;
      }
      pendingJumpRef.current = id;
      setWindowSize((n) => Math.max(n, turns.length - idx));
      return;
    }
    stickToBottomRef.current = false;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    flashTurn(el);
  };

  // The last user prompt: powers regenerate (re-send as a new prompt — dsh
  // has no replace-turn RPC, so this is honest regeneration, not mutation).
  const lastUserText = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t && t.role === "user") return t.text;
    }
    return null;
  }, [turns]);

  // Outline entries: user turns in order, keyed by turn id (jump target).
  const outlineEntries = useMemo(
    () => turns.filter((t): t is Extract<typeof t, { role: "user" }> => t?.role === "user"),
    [turns],
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={containerRef}
        data-testid="chat-log"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-6"
      >
        {/* Scoped live region: announce only stream start/end. The container is
          deliberately NOT aria-live — a polite log would re-announce every
          50ms delta flush and flood screen readers. */}
        <span role="status" aria-live="polite" className="sr-only">
          {isStreaming ? t("chat.ariaStreaming") : turns.length > 0 ? t("chat.ariaDone") : ""}
        </span>
        {turns.length === 0 ? (
          pendingSession ? (
            <SessionSkeleton />
          ) : queuedTurn ? (
            // A first prompt queued on a blank chat: there is no transcript to
            // append to, but the bubble is still what the user must see.
            <div className="mx-auto flex max-w-4xl flex-col gap-6">
              <QueuedBubble queued={queuedTurn} send={send} />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
              {t("chat.empty")}
            </div>
          )
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-6">
            {showLoadEarlier && (
              <button
                type="button"
                onClick={loadEarlier}
                disabled={loadingEarlier}
                data-testid="load-earlier"
                className="mx-auto rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {t("chat.loadEarlier", { count: remaining })}
              </button>
            )}
            {visible.map((t, vi) => {
              // Absolute index into the complete list — the last-of-role flags
              // must keep targeting the true tail, not the window's edge.
              const i = hiddenCount + vi;
              const isLastUser = t.role === "user" && i === lastUserIndex;
              const isLastAssistant = t.role === "assistant" && i === lastAssistantIndex;
              return (
                <div key={t.id} id={`turn-${t.id}`}>
                  {t.role === "user" ? (
                    <UserTurn
                      text={t.text}
                      taskSummary={t.taskSummary}
                      onEdit={isLastUser && !t.taskSummary ? () => onPrefill(t.text) : undefined}
                    />
                  ) : (
                    <AssistantTurn
                      turn={t}
                      onRegenerate={
                        isLastAssistant && lastUserText
                          ? () => send({ type: "prompt", text: lastUserText })
                          : undefined
                      }
                    />
                  )}
                </div>
              );
            })}
            {queuedTurn && <QueuedBubble queued={queuedTurn} send={send} />}
          </div>
        )}
      </div>
      {outlineEntries.length >= OUTLINE_MIN_USER_TURNS ? (
        <ChatOutline entries={outlineEntries} onJump={jumpToTurn} />
      ) : null}
    </div>
  );
}

// A prompt accepted while the runtime is busy (concurrent-chat-sessions,
// design D10). Deliberately NOT a Turn: the user's message has not been
// recorded (a cancelled queue entry leaves no history row), so this bubble is
// local UI driven by server state (`queued` / session_loaded.queued) and
// disappears on `dequeued`. Two actions: withdraw it, or stop the session it is
// waiting behind and run this one instead.
function QueuedBubble({
  queued,
  send,
}: {
  queued: { text: string; position: number; waitingOn: { id: string; title: string | null } | null };
  send: (m: ClientMessage) => void;
}) {
  const { t } = useTranslation();
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  return (
    <div data-testid="queued-bubble" data-position={queued.position} className="flex flex-col items-end gap-1.5">
      <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground">{queued.text}</div>
      <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
        <span data-testid="queued-status" className="flex items-center gap-1">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {queued.waitingOn
            ? t("chat.queuedBehind", {
                title: queued.waitingOn.title || t("sidebar.untitled"),
              })
            : t("chat.queuedIdle")}
        </span>
        <button
          type="button"
          data-testid="queued-cancel"
          onClick={() => currentSessionId && send({ type: "stop_turn", id: currentSessionId })}
          className="rounded-full border border-border px-2 py-0.5 hover:bg-muted hover:text-foreground"
        >
          {t("chat.queuedCancel")}
        </button>
        {queued.waitingOn && (
          <button
            type="button"
            data-testid="queued-preempt"
            onClick={() => send({ type: "stop_turn", id: queued.waitingOn!.id })}
            className="rounded-full border border-border px-2 py-0.5 hover:bg-muted hover:text-foreground"
          >
            {t("chat.queuedPreempt")}
          </button>
        )}
      </div>
    </div>
  );
}

// The optimistic-switch placeholder (perf-session-open): the click already
// moved the view to the target session; this stands in for the transcript
// until its session_loaded lands (or the switch fails and the store restores
// the previous view). Purely presentational — no data assumptions.
function SessionSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="session-pending-skeleton"
      role="status"
      aria-label={t("chat.loadingSession")}
      className="mx-auto flex w-full max-w-4xl animate-pulse flex-col gap-6 py-2"
    >
      <div className="ml-auto h-9 w-1/3 rounded-lg bg-muted" />
      <div className="flex flex-col gap-2.5">
        <div className="h-4 w-full rounded bg-muted" />
        <div className="h-4 w-11/12 rounded bg-muted" />
        <div className="h-4 w-2/3 rounded bg-muted" />
      </div>
      <div className="ml-auto h-9 w-2/5 rounded-lg bg-muted" />
      <div className="flex flex-col gap-2.5">
        <div className="h-4 w-5/6 rounded bg-muted" />
        <div className="h-4 w-1/2 rounded bg-muted" />
      </div>
    </div>
  );
}
