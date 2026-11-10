// ── Copilot dock (add-line-boards-and-action-gate, tasks 14-15) ─────────────
//
// A global floating entry (bottom-right) that opens a right-side dock holding
// a same-origin iframe of /chat?embed=copilot&board=<line>&preset=<agentId>.
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

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Bot, X } from "lucide-react";
import { useChatStore } from "@platform/core";
import type { ClientMessage } from "@platform/core";
import { useAppConfig } from "@/hooks/useAppConfig";
import { subscribePackInspection, type CopilotPackContext } from "@/lib/copilot-pack-context";

export interface CopilotPreset {
  line: string;
  agentId: string;
  agentName: string;
  packId: string;
  packName: string;
}

interface Props {
  send: (m: ClientMessage) => void;
}

/**
 * Whether an `/agents` `?tab=` value addresses the pack market — the surface
 * whose focused assistant is the 谦面 line.
 *
 * Three values qualify, and the old check only accepted the middle one: the
 * market page normalizes its own slug (`LEGACY_TAB.market → agents`) and writes
 * the normalized value back to the URL, so by the time the dock reads it the
 * string is `agents`. With only `"market"` accepted, opening the dock on the
 * market surface produced a context-free frame — no `board=facet`, no focused
 * preset (caught by e2e/copilot-dock.spec.js). An absent tab is the same
 * surface too: `agents` is the first tab, i.e. the default.
 */
function isMarketTab(tab: string | null): boolean {
  return tab === null || tab === "" || tab === "market" || tab === "agents";
}

export function CopilotDock({ send }: Props) {
  const location = useLocation();
  const { copilotEnabled, lineBoardsEnabled } = useAppConfig();
  const [open, setOpen] = useState(false);
  const [boardLine, setBoardLine] = useState<string | null>(null);
  // The resolved preset for `boardLine`, keyed on the line it was fetched for
  // so a stale answer from a previous board never rides into the iframe URL.
  const [preset, setPreset] = useState<{ line: string; copilot: CopilotPreset | null } | null>(null);
  const agentBeforeOpenRef = useRef<string | null>(null);
  const injectedAgentRef = useRef<string | null>(null);

  // Derive the dock's line context from the route. /boards/:line is the
  // board path; the 壹座 pack market carries the facet line (add-facet-copilot
  // D1) — the same focused-preset resolution serves both. The market surface
  // moved out of the (now dissolved) agents hub to its own /packs route, and
  // the dock's facet line had to move with it: without this the market opened
  // a context-free dock on the one surface whose whole contract is the 谦面
  // assistant line. The legacy /agents?tab=market URL stays mapped so old
  // bookmarks keep behaving. Other routes open context-free.
  useEffect(() => {
    const match = location.pathname.match(/^\/boards\/([^/]+)/);    if (match?.[1]) {
      setBoardLine(match[1]);
      return;
    }
    if (
      location.pathname === "/packs" ||
      (location.pathname === "/agents" && isMarketTab(new URLSearchParams(location.search).get("tab")))
    ) {
      setBoardLine("facet");
      return;
    }
    // Teams hub (add-teams-hub-formation-board 3.1): /fleets and /fleets/:id
    // open the dock with the fleets line — the focused preset resolves to the
    // fleet architect when one is installed (honest null otherwise), and the
    // hub's roster/selection rides the fleets:selection event as context.
    if (location.pathname === "/fleets" || location.pathname.startsWith("/fleets/")) {
      setBoardLine("fleets");
      return;
    }
    setBoardLine(null);
  }, [location.pathname, location.search]);

  // Resolve the line's focused assistant as soon as the line is known (before
  // the FAB is clicked), so opening the dock does not wait on the request.
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
  useEffect(() => {
    if (!open || !boardLine) return;
    const frame = document.querySelector<HTMLIFrameElement>("[data-testid=copilot-frame]");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "copilot_context", board: boardLine }, window.location.origin);
    }
  }, [boardLine, open]);

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
  // reload after the first frame would re-run the switch for nothing).
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
  // would grow a second FAB inside the dock. Any framed document is a guest,
  // never a host.
  const embedded =
    new URLSearchParams(location.search).get("embed") === "copilot" ||
    (typeof window !== "undefined" && window.self !== window.top);
  if (!copilotEnabled || embedded) return null;

  const src = `/chat?embed=copilot${boardLine ? `&board=${encodeURIComponent(boardLine)}` : ""}${
    copilot ? `&preset=${encodeURIComponent(copilot.agentId)}` : ""
  }`;

  const openDock = () => {
    agentBeforeOpenRef.current = useChatStore.getState().currentAgent;
    setOpen(true);
  };

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

  return (
    <>
      {!open && (
        <button
          type="button"
          data-testid="copilot-fab"
          aria-label="打开副驾"
          onClick={openDock}
          className="fixed bottom-5 right-5 z-40 grid h-12 w-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90"
        >
          <Bot className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      {open && (
        <aside
          data-testid="copilot-dock"
          className="fixed bottom-0 right-0 z-40 flex h-[70vh] w-[min(420px,92vw)] flex-col overflow-hidden rounded-tl-lg border border-border bg-background shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
            <span className="text-sm font-medium">副驾</span>
            <button
              type="button"
              data-testid="copilot-close"
              aria-label="关闭副驾"
              onClick={closeDock}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {resolved ? (
            <iframe
              data-testid="copilot-frame"
              title="副驾"
              src={src}
              className="min-h-0 flex-1 border-0"
            />
          ) : (
            <div
              data-testid="copilot-frame-pending"
              className="grid min-h-0 flex-1 place-items-center text-xs text-muted-foreground"
            >
              正在加载副驾…
            </div>
          )}
        </aside>
      )}
    </>
  );
}
