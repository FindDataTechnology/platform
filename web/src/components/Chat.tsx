// Message log. Renders turns; auto-scrolls to bottom unless the user scrolled up.
// Owns the message-level actions wiring: copy lives inside AssistantTurn;
// edit-and-resend goes to the LAST user turn; regenerate re-sends the last
// user prompt from the LAST assistant turn. Also owns the outline rail
// (add-chat-outline): a floating user-turn index over the transcript's right
// edge whose entries jump to a turn via jumpToTurn.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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

// Render windowing (perf-session-open): only the transcript's tail mounts on
// open — Markdown/chart mount cost per turn is what makes a several-hundred-
// turn session janky. The store keeps the complete list (outline, export,
// last-turn actions all read it); this slice is a render concern only.
const WINDOW_INITIAL = 50;
const WINDOW_STEP = 50;

export function Chat({ send, onPrefill }: Props) {
  const { t } = useTranslation();
  const turns = useChatStore((s) => s.turns);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const pendingSession = useChatStore((s) => s.pendingSession);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
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
    setWindowSize((n) => n + WINDOW_STEP);
  };

  const hiddenCount = Math.max(0, turns.length - windowSize);
  const visible = hiddenCount > 0 ? turns.slice(turns.length - windowSize) : turns;

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
      if (idx < 0) return;
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
          ) : (
            <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
              {t("chat.empty")}
            </div>
          )
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-6">
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={loadEarlier}
                data-testid="load-earlier"
                className="mx-auto rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t("chat.loadEarlier", { count: hiddenCount })}
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
          </div>
        )}
      </div>
      {outlineEntries.length >= OUTLINE_MIN_USER_TURNS ? (
        <ChatOutline entries={outlineEntries} onJump={jumpToTurn} />
      ) : null}
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
