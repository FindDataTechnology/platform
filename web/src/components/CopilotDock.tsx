// ── Copilot dock (add-line-boards-and-action-gate, tasks 14-15) ─────────────
//
// A dock holding a same-origin iframe of
// /chat?embed=copilot&board=<line>&preset=<agentId>.
//
// Entry point (scope-copilot-dock-to-line-surfaces): the dock is NO LONGER a
// global floating button. Only surfaces that resolve a line context mount
// `<CopilotDockTrigger />` in their own header — the line boards, the pack
// market, the fleets hub. Everywhere else the dock has nothing to add: with no
// board line its iframe is just a second conversation beside the main one, and
// the 萬星 cross-line copilot already owns the conversation entry there.
//
// Why an iframe: useChatStore is a module singleton. A second conversation
// panel in the same document would fight the main chat for its state. A
// same-origin iframe gets its own document, its own store instance and its
// own WS connection — full isolation with zero store refactoring.
//
// The board context rides the URL (first frame) and postMessage (updates);
// the context bar inside the embed shows exactly what was sent.
//
// Focused preset (copilot-dock-focused-preset): the dock asks the server which
// installed pack is this line's focused assistant and puts its agent id on the
// URL; the embed switches the runtime to it once connected. The preset is
// CELL-wide (dsh bakes it at initialize, a switch restarts the child), so the
// dock remembers the agent the main chat was on and restores it on close —
// unless the user picked something else meanwhile, which then stands.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Bot, Maximize2, Minimize2, X } from "lucide-react";
import { useChatStore } from "@platform/core";
import type { ClientMessage } from "@platform/core";
import { useAppConfig } from "@/hooks/useAppConfig";
import { subscribePackInspection, type CopilotPackContext } from "@/lib/copilot-pack-context";
import { resolveCopilotCard, type CopilotCardPatch } from "@platform/core";

export interface CopilotPreset {
  line: string;
  agentId: string;
  agentName: string;
  packId: string;
  packName: string;
}

interface Props {
  send: (m: ClientMessage) => void;
  /** The shell's rail state. The dock panel sits to the right of the 240px rail
   *  so opening it never covers navigation; collapsed, it takes the corner. */
  navCollapsed?: boolean;
}

/** Page-header triggers announce themselves here; the dock is a singleton, so
 *  every trigger opens the same panel on whatever line the route resolves. */
const OPEN_EVENT = "copilot-dock:open";

/** The mounted board page publishes its current view summary here (B1). The
 *  dock is a singleton in App and the board lives in the router outlet, so a
 *  window event is the only shared seam without a new context provider. */
export const BOARD_VIEW_EVENT = "copilot-dock:view-summary";
/** The dock asks a mounted board to (re)publish its summary. The board publishes
 *  on mount, which happens LONG before the dock is opened — so without this the
 *  dock opens holding nothing and the model gets a context with no view on it. */
const BOARD_VIEW_REQUEST = "copilot-dock:view-summary-request";

/** Whether an `/agents` `?tab=` value addresses the pack market — the surface
 *  whose focused assistant is the 谦面 line.
 *
 *  Three values qualify, and the old check only accepted the middle one: the
 *  market page normalizes its own slug (`LEGACY_TAB.market → agents`) and writes
 *  the normalized value back to the URL, so by the time the dock reads it the
 *  string is `agents`. With only `"market"` accepted, opening the dock on the
 *  market surface produced a context-free frame — no `board=facet`, no focused
 *  preset (caught by e2e/copilot-dock.spec.js). An absent tab is the same
 *  surface too: `agents` is the first tab, i.e. the default.
 */
// ── Dock shell config (unify-copilot-workbench 3.3) ─────────────────────────
//
// The panel's placement/size/defaultOpen now come from the surface's copilot
// card (deployment → role → user, per axis). Two things survive from the old
// 1-bit design because they are still the right answer:
//   · the maximize toggle (a one-click jump to the large size), and
//   · USER SIZE as a per-axis override, which now rides `user_preferences`
//     (`copilot.card.dock`) instead of localStorage — the change's design says
//     the user layer is stored per axis, and a size the user dragged is exactly
//     one axis. Writing only `shell.size` is deliberate: a whole-card snapshot
//     would freeze the deployment's future changes to every other axis.
const USER_SIZE_KEY = "copilot.card.dock";

type ShellSize = { width: number; height: number; minWidth: number; minHeight: number };

/** A user size override, or null. Stored as a partial card; only `shell.size`
 *  is read here — any other key is somebody else's axis. */
function readUserSize(prefs: Record<string, string> | null): Partial<ShellSize> | null {
  const raw = prefs?.[USER_SIZE_KEY];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const size = parsed?.shell?.size;
    return size && typeof size === "object" ? size : null;
  } catch {
    return null;
  }
}

function isMarketTab(tab: string | null): boolean {
  return tab === null || tab === "" || tab === "market" || tab === "agents";
}

/** Route → line, the same mapping the dock itself uses. The trigger needs it
 *  too: it only exists where the dock would carry a line. */
function lineForLocation(pathname: string, search: string): string | null {
  const match = pathname.match(/^\/boards\/([^/]+)/);
  if (match?.[1]) return match[1];
  if (pathname === "/packs" || (pathname === "/agents" && isMarketTab(new URLSearchParams(search).get("tab")))) {
    return "facet";
  }
  if (pathname === "/fleets" || pathname.startsWith("/fleets/")) return "fleets";
  return null;
}

/**
 * The dock's page-held entry (scope-copilot-dock-to-line-surfaces).
 *
 * Deliberately router-free: the pack market also mounts inside the facet shell,
 * which has no Router ancestor (same trap that made PackMarketView read
 * `window.location` instead of useSearchParams). Whether the surface carries a
 * line is decided by WHERE this is mounted — the line boards, the market, the
 * fleets hub — not by a hook inside it.
 *
 * Keeps `data-testid="copilot-fab"` — the name predates this change (it was a
 * floating action button) and four e2e assertions anchor on it, so renaming
 * buys nothing but churn. Renders nothing inside the embed (a framed document
 * is a guest, never a host).
 */
export function CopilotDockTrigger({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const { copilotEnabled } = useAppConfig();
  const embedded =
    (typeof window !== "undefined" && window.self !== window.top) ||
    (typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("embed") === "copilot");
  if (!copilotEnabled || embedded) return null;
  const label = t("copilot.open");
  return (
    <button
      type="button"
      data-testid="copilot-fab"
      data-dock-trigger=""
      aria-label={label}
      title={label}
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      className={`inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted ${className}`}
    >
      <Bot className="h-4 w-4" aria-hidden="true" />
      {label}
    </button>
  );
}

export function CopilotDock({ send, navCollapsed = false }: Props) {
  const location = useLocation();
  const { t } = useTranslation();
  const { copilotEnabled, lineBoardsEnabled, copilotCards } = useAppConfig();
  // The dock's shell: deployment card, then this user's size override (per
  // axis). `maximized` is the builtin one-click large state, kept separate from
  // the resolved size so neither overwrites the other.
  const [userSize, setUserSize] = useState<Partial<ShellSize> | null>(null);
  const [maximized, setMaximized] = useState(false);
  const shell = useMemo(() => {
    const deployment = copilotCards?.dock as CopilotCardPatch | undefined;
    const card = resolveCopilotCard("dock", { deployment: deployment ? { dock: deployment } : null });
    const size = { ...card.shell.size, ...(userSize ?? {}) };
    return { ...card.shell, size };
  }, [copilotCards, userSize]);
  const [open, setOpen] = useState(false);
  const [boardLine, setBoardLine] = useState<string | null>(null);
  // A one-line summary of what the board surface is showing, so the embed can
  // tell the model "what you see here" without a second fetch (B1). The board
  // page publishes it; nothing publishes → undefined, and the prefix omits the
  // line rather than inventing one.
  const [boardViewSummary, setBoardViewSummary] = useState<string | undefined>(undefined);
  // The resolved preset for `boardLine`, keyed on the line it was fetched for
  // so a stale answer from a previous board never rides into the iframe URL.
  const [preset, setPreset] = useState<{ line: string; copilot: CopilotPreset | null } | null>(null);
  const agentBeforeOpenRef = useRef<string | null>(null);
  const injectedAgentRef = useRef<string | null>(null);

  // Load this user's stored shell size once (unify-copilot-workbench 3.3). A
  // failure is silent: the deployment card's size is a perfectly good answer,
  // and a preference read must never block the panel.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        const size = readUserSize(body?.preferences ?? null);
        if (size) setUserSize(size);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Derive the dock's line context from the route. /boards/:line is the
  // board path; the 壹座 pack market carries the facet line (add-facet-copilot
  // D1) — the same focused-preset resolution serves both. The market surface
  // moved out of the (now dissolved) agents hub to its own /packs route, and
  // the dock's facet line had to move with it: without this the market opened
  // a context-free dock on the one surface whose whole contract is the 谦面
  // assistant line. The legacy /agents?tab=market URL stays mapped so old
  // bookmarks keep behaving. Other routes open context-free.
  useEffect(() => {
    const line = lineForLocation(location.pathname, location.search);
    setBoardLine(line);
  }, [location.pathname, location.search]);

  // The board surface publishes a human summary of its current view here (B1).
  // A custom event, not a prop: the dock is a singleton mounted in App while
  // the board renders inside the router outlet, so there is no shared parent
  // to own the value.
  useEffect(() => {
    const onSummary = (e: Event) => {
      const detail = (e as CustomEvent<{ line?: string; summary?: string }>).detail;
      if (detail?.line && detail.line !== boardLine) return;
      setBoardViewSummary(typeof detail?.summary === "string" && detail.summary ? detail.summary : undefined);
    };
    window.addEventListener(BOARD_VIEW_EVENT, onSummary);
    return () => window.removeEventListener(BOARD_VIEW_EVENT, onSummary);
  }, [boardLine]);

  // Resolve the line's focused assistant as soon as the line is known (before
  // the trigger is clicked), so opening the dock does not wait on the request.
  useEffect(() => {
    if (!boardLine) {
      setPreset(null);
      return;
    }
    // The fleets hub is not a line board — its focus resolves from the
    // installed-pack roster, not the line-board copilot lane; the board-gate
    // (lineBoardsEnabled) does not apply to it.
    if (boardLine === "fleets") {
      let cancelled = false;
      fetch("/api/fleets/copilot")
        .then((r) => (r.ok ? r.json() : { copilot: null }))
        .then((body) => {
          if (!cancelled) setPreset({ line: boardLine, copilot: body?.copilot ?? null });
        })
        .catch(() => {
          if (!cancelled) setPreset({ line: boardLine, copilot: null });
        });
      return () => {
        cancelled = true;
      };
    }
    if (!lineBoardsEnabled) {
      setPreset(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/boards/${encodeURIComponent(boardLine)}/copilot`)
      .then((r) => (r.ok ? r.json() : { copilot: null }))
      .then((body) => {
        if (!cancelled) setPreset({ line: boardLine, copilot: body?.copilot ?? null });
      })
      .catch(() => {
        if (!cancelled) setPreset({ line: boardLine, copilot: null });
      });
    return () => {
      cancelled = true;
    };
  }, [boardLine, lineBoardsEnabled]);

  // Keep the iframe's context in sync when the user navigates between boards
  // while the dock is open. Same-origin, so postMessage is safe and direct.
  //
  // This channel is UI-ONLY (unify-copilot-workbench B1/D2): a same-document
  // postMessage cannot reach the model process, which runs on the server. The
  // embed renders it into the context bar AND re-submits it as the `context`
  // field of every prompt; anything that needs the model to know must take
  // that route. Do not "fix" a missing model-side context here.
  //
  // Sent on every line change (not just on open) — a bar frozen at the frame
  // that first opened is the bug this payload shape exists to fix.
  //
  // TIMING (2026-11-20, caught on prod): posting when the effect first runs
  // reaches a frame whose document has NOT loaded yet — `contentWindow` exists
  // the instant `src` is set, but the embed's listener is registered by its own
  // React effect, which runs after that document commits. The message was
  // silently dropped and the model got a prefix with no page/view on it (the
  // board line survived only because it rides the iframe URL). So: send on the
  // frame's `load`, AND on every later change while it stays loaded.
  // Ask the mounted board for its summary the moment the dock opens (see
  // BOARD_VIEW_REQUEST). A no-op when no board is mounted.
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new Event(BOARD_VIEW_REQUEST));
  }, [open]);

  // Sent on every change while the dock is open. The FIRST delivery is the
  // iframe's onLoad (below), not this effect: `document.querySelector` can find
  // the element before React has committed its src, and a message posted into a
  // document that is still blank is dropped without an error (2026-11-20 prod:
  // the model got `产品线/看板` only — page and view were lost this way, while
  // board survived because it also rides the iframe URL).
  // The payload lives in a ref so the callback is stable across renders: the
  // iframe's onLoad fires ONCE, and a callback rebuilt afterwards would be a
  // different function than the one React attached — the loaded frame would
  // keep calling the closure it captured, i.e. the values from the render that
  // created it (board only, no page/view) — exactly the 2026-11-20 symptom.
  const contextPayloadRef = useRef({ boardLine, page: location.pathname, viewSummary: boardViewSummary });
  contextPayloadRef.current = { boardLine, page: location.pathname, viewSummary: boardViewSummary };
  const sendContext = useCallback(() => {
    const frame = document.querySelector<HTMLIFrameElement>("[data-testid=copilot-frame]");
    const { boardLine: line, page, viewSummary } = contextPayloadRef.current;
    frame?.contentWindow?.postMessage(
      { type: "copilot_context", board: line, page, viewSummary },
      window.location.origin,
    );
  }, []);
  // Re-send whenever the payload changes. Keyed on a derived string rather than
  // the individual values: `sendContext` reads a ref, so the linter is right
  // that those values are not dependencies OF THE CALLBACK — but a change in
  // them must still produce a message, which this key expresses.
  const contextKey = `${boardLine ?? ""}|${location.pathname}|${boardViewSummary ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: contextKey is the point — the callback reads a ref, so a change in the payload is not visible to the linter but MUST re-send.
  useEffect(() => {
    if (!open) return;
    sendContext();
  }, [open, sendContext, contextKey]);

  // The market tab's inspected pack (add-facet-copilot D2): subscribe while
  // the dock is open on the facet line and forward it into the embed. The
  // context message re-sends on every change (open/switch/close), so the bar
  // always shows what the host sees.
  const [packCtx, setPackCtx] = useState<CopilotPackContext | null>(null);
  useEffect(() => {
    if (!open || boardLine !== "facet") {
      setPackCtx(null);
      return;
    }
    return subscribePackInspection(setPackCtx);
  }, [open, boardLine]);
  useEffect(() => {
    if (!open) return;
    const frame = document.querySelector<HTMLIFrameElement>("[data-testid=copilot-frame]");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "copilot_pack", pack: packCtx }, window.location.origin);
    }
  }, [packCtx, open]);

  // Teams-hub context (add-teams-hub-formation-board 3.1): while open on the
  // fleets line, mirror the hub's roster/selection into the embed so the
  // architect sees what the owner sees. Same postMessage channel as the
  // board/facet contexts.
  const [fleetCtx, setFleetCtx] = useState<string | null>(null);
  useEffect(() => {
    if (!open || boardLine !== "fleets") {
      setFleetCtx(null);
      return;
    }
    const onSelection = (e: Event) => {
      setFleetCtx((e as CustomEvent<{ fleetId?: string | null }>).detail?.fleetId ?? null);
    };
    window.addEventListener("fleets:selection", onSelection);
    return () => window.removeEventListener("fleets:selection", onSelection);
  }, [open, boardLine]);
  useEffect(() => {
    if (!open || boardLine !== "fleets") return;
    const frame = document.querySelector<HTMLIFrameElement>("[data-testid=copilot-frame]");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "copilot_context", board: "fleets", fleetId: fleetCtx }, window.location.origin);
    }
  }, [fleetCtx, open, boardLine]);

  // The preset answer for THIS line; still in flight → hold the iframe (a
  // reload after the first frame would re-run the switch for nothing). The
  // fleets line waits the same way — its answer comes from /api/fleets/copilot.
  const resolved = !boardLine || (boardLine !== "fleets" && !lineBoardsEnabled) || preset?.line === boardLine;
  const copilot = preset?.line === boardLine ? preset.copilot : null;

  // What the open dock last injected. Kept while the dock navigates to a route
  // without a board, so closing there still restores the main chat's agent.
  useEffect(() => {
    if (open && resolved && copilot?.agentId) injectedAgentRef.current = copilot.agentId;
  }, [open, resolved, copilot]);

  // The dock's own iframe runs this same App: without this guard the embed
  // would grow a second dock inside the dock. Any framed document is a guest,
  // never a host.
  const embedded =
    new URLSearchParams(location.search).get("embed") === "copilot" ||
    (typeof window !== "undefined" && window.self !== window.top);

  // Page-held triggers open the dock (scope-copilot-dock-to-line-surfaces).
  // Capture the main chat's agent here rather than in the trigger so the
  // restore-on-close contract keeps exactly one writer.
  useEffect(() => {
    if (!copilotEnabled || embedded) return;
    const onOpen = () => {
      agentBeforeOpenRef.current = useChatStore.getState().currentAgent;
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [copilotEnabled, embedded]);

  if (!copilotEnabled || embedded) return null;

  const src = `/chat?embed=copilot${boardLine ? `&board=${encodeURIComponent(boardLine)}` : ""}${
    copilot ? `&preset=${encodeURIComponent(copilot.agentId)}` : ""
  }`;

  const closeDock = () => {
    setOpen(false);
    const injected = injectedAgentRef.current;
    const current = useChatStore.getState().currentAgent;
    const before = agentBeforeOpenRef.current;
    agentBeforeOpenRef.current = null;
    injectedAgentRef.current = null;
    // Restore only what the dock changed: the runtime must still be on the
    // injected assistant, and it must differ from where the main chat was.
    if (injected && current === injected && before !== injected) {
      send({ type: "set_agent", id: before ?? "local" });
    }
  };

  if (!open) return null;

  // Geometry from the resolved shell (unify-copilot-workbench 3.3). The
  // browser's own resize handle stays — a hand-written drag buys nothing — but
  // its result now persists through the user layer instead of localStorage,
  // and the starting size comes from the card.
  const placementClass =
    shell.placement === "right"
      ? navCollapsed
        ? "right-0 md:right-0"
        : "right-0 md:right-0"
      : "left-0";
  const widthPx = maximized ? Math.max(shell.size.width, 720) : shell.size.width;
  const heightVh = maximized ? 92 : shell.size.height ? Math.round((shell.size.height / 900) * 100) : 70;

  return (
    <aside
      data-testid="copilot-dock"
      data-maximized={maximized ? "on" : "off"}
      data-placement={shell.placement}
      // Sits beside the 240px rail so opening the dock never covers nav.
      className={`fixed bottom-0 ${placementClass} z-40 flex flex-col overflow-hidden rounded-tr-lg border border-border bg-background shadow-2xl ${
        shell.placement === "left" && !navCollapsed ? "md:left-[240px]" : ""
      }`}
      style={{
        resize: "both",
        width: `min(${widthPx}px, 92vw)`,
        height: `${heightVh}dvh`,
        minWidth: `${shell.size.minWidth}px`,
        minHeight: `${shell.size.minHeight}px`,
        maxWidth: "92vw",
        maxHeight: "92dvh",
      }}
      // A resize the user performed is an override of ONE axis; store it as
      // exactly that, and never let it clobber the card's other axes.
      onPointerUp={(e) => {
        const el = e.currentTarget;
        const size = { width: Math.round(el.offsetWidth), height: Math.round(el.offsetHeight) };
        setUserSize(size);
        void fetch("/api/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: USER_SIZE_KEY, value: JSON.stringify({ shell: { size } }) }),
        }).catch(() => {});
      }}
    >
      <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
        <span className="text-sm font-medium">{t("copilot.title", { defaultValue: "副驾" })}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="copilot-maximize"
            aria-label={maximized ? t("copilot.restore") : t("copilot.maximize")}
            title={maximized ? t("copilot.restore") : t("copilot.maximize")}
            // A transient gesture, not a stored preference: the persisted
            // geometry is the user's drag (USER_SIZE_KEY). Maximize is the
            // one-click jump, so it resets when the dock closes rather than
            // silently overriding the size the user chose next time.
            onClick={() => setMaximized((value) => !value)}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {maximized ? (
              <Minimize2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            data-testid="copilot-close"
            aria-label={t("copilot.closeLabel", { defaultValue: "关闭副驾" })}
            onClick={closeDock}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      {resolved ? (
        <iframe
          data-testid="copilot-frame"
          title={t("copilot.title", { defaultValue: "副驾" })}
          src={src}
          onLoad={sendContext}
          className="min-h-0 flex-1 border-0"
        />
      ) : (
        <div
          data-testid="copilot-frame-pending"
          className="grid min-h-0 flex-1 place-items-center text-xs text-muted-foreground"
        >
          {t("copilot.loading", { defaultValue: "正在加载副驾…" })}
        </div>
      )}
    </aside>
  );
}
