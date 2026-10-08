// Left nav: brand, work-surface tabs, Workspaces section (workspace-grouped
// session list, search, pagination), status + settings.
//
// The tabs are WORK SURFACES only — places you go to look at or produce
// something. Configuration (models, MCP, skills, system status) lives in the
// Settings modal behind the gear, so the nav stays a short, stable list rather
// than mixing the product with its admin panel.
//
// The session region groups sessions under the workspace they were stamped
// with at creation (add-sidebar-workspaces). Grouping/search/pagination are
// client-side over the existing sessions payload; the new-workspace action
// reuses the set_workspace contract (validation + mid-conversation confirm +
// restart) rather than introducing a second server path.
//
// Nav items use react-router <NavLink> for in-app navigation (no page reload,
// WebSocket stays connected). The active route is highlighted automatically.
// All visible labels resolve through the i18n bundle (keys, not literals);
// tab identity/ordering/icons are stable across locales.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Bot,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  PanelLeftClose,
  Search,
  Settings,
  Sparkles,
  Waypoints,
  X,
} from "lucide-react";
import { useChatStore } from "@platform/core";
import type { ClientMessage, SessionMeta } from "@platform/core";
import { cn } from "@/lib/utils";
import { getLastSeen, markSessionSeen, isSessionUnseen } from "@/lib/unread";
import { ChatSessionMenu } from "@/components/ChatSessionMenu";
import { useBranding } from "@/hooks/useAppConfig";
import { settingsPath } from "@/components/settings/sections";

interface Props {
  send: (m: ClientMessage) => void;
  // Called after in-drawer navigation so App can close the off-canvas drawer.
  onNavigate?: () => void;
  // Desktop rail collapse (App owns the state). Provided only for the md+
  // rail — the below-md drawer renders without it, so its header carries no
  // collapse toggle there.
  onCollapse?: () => void;
}

// Icon is part of a tab's identity and stays fixed across locales — the label
// translates, the glyph does not.
const NAV_BASE = [
  { to: "/chat", key: "nav.chat", testId: "nav-chat", icon: MessageSquare },
  { to: "/knowledge", key: "nav.knowledge", testId: "nav-knowledge", icon: BookOpen },
  { to: "/resources", key: "nav.resources", testId: "nav-resources", icon: FolderOpen },
  { to: "/agents", key: "nav.agents", testId: "nav-agents", icon: Sparkles },
  { to: "/bots", key: "nav.bots", testId: "nav-bots", icon: Bot },
  { to: "/trace", key: "nav.trace", testId: "nav-trace", icon: Waypoints },
  { to: "/tasks", key: "nav.tasks", testId: "nav-tasks", icon: Clock },
];

// Sessions whose workspace stamp is missing (rows written before the
// capability) group under this sentinel key.
const UNGROUPED = "__ungrouped__";
// Per-group preview cap — mirrors the welcome screen's recent-list preview.
const GROUP_PREVIEW = 5;

// The native folder picker exists only inside the Electron shell (exposed via
// the preload bridge); in a plain browser the path input is the only entry.
const CAN_PICK_NATIVE =
  typeof window !== "undefined" && typeof window.platform?.pickWorkdir === "function";

export function Sidebar({ send, onNavigate, onCollapse }: Props) {
  const { t } = useTranslation();
  // The deployment's own name (ASSISTANT_NAME) wins over the localized default.
  const { brand } = useBranding();
  const status = useChatStore((s) => s.status);
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const currentWorkspace = useChatStore((s) => s.currentWorkspace);
  const turns = useChatStore((s) => s.turns);
  const setPendingConfig = useChatStore((s) => s.setPendingConfig);
  const catalogVersion = useChatStore((s) => s.catalogVersion);
  const navigate = useNavigate();
  const location = useLocation();

  // Right-click context menu on session rows: one trigger ref per row, one
  // popover anchored to the row that fired it.
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [menuTarget, setMenuTarget] = useState<{ id: string; el: HTMLElement } | null>(null);

  // Per-session last-viewed stamps (client-side unread: updatedAt > lastSeen).
  // Marked on open; a scheduled task's output in another session shows the dot.
  const [lastSeen, setLastSeen] = useState(() => getLastSeen());

  // ── Workspaces section state ─────────────────────────────────────────────
  // Search is a transient lens (component state, not the store/URL): an
  // ephemeral filter over the already-loaded payload with no deep-link use.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Group expansion is three-state: explicit user choice wins, otherwise the
  // group holding the active session (or the current workspace) is open.
  const [userExpanded, setUserExpanded] = useState<Set<string>>(new Set());
  const [userCollapsed, setUserCollapsed] = useState<Set<string>>(new Set());
  // Per-group "Show N more" — independent of the collapse state above.
  const [showAllGroups, setShowAllGroups] = useState<Set<string>>(new Set());
  // New-workspace popover (reuses the set_workspace contract).
  const [wsPopoverOpen, setWsPopoverOpen] = useState(false);
  const [wsDraft, setWsDraft] = useState("");
  const [wsError, setWsError] = useState<string | null>(null);
  const wsPopoverRef = useRef<HTMLDivElement>(null);

  // The server bumps catalogVersion via `catalog_changed`; refetch the
  // switchable agent list so catalog/role edits appear live.
  useEffect(() => {
    if (catalogVersion > 0) send({ type: "list_agents" });
  }, [catalogVersion, send]);

  // Dismiss the new-workspace popover on outside click / Escape.
  useEffect(() => {
    if (!wsPopoverOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wsPopoverRef.current && !wsPopoverRef.current.contains(e.target as Node)) {
        setWsPopoverOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWsPopoverOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [wsPopoverOpen]);

  // Search: client-side title-substring filter; groups without matches simply
  // drop out of the grouping below. Clearing restores everything.
  const q = query.trim().toLowerCase();
  const visibleSessions = useMemo(
    () => (q ? sessions.filter((s) => (s.title || "").toLowerCase().includes(q)) : sessions),
    [sessions, q],
  );

  // Group the (filtered) sessions by their workspace stamp, current workspace
  // first, Ungrouped last, the rest by their newest session.
  const groups = useMemo(() => {
    const map = new Map<string, SessionMeta[]>();
    for (const s of visibleSessions) {
      const key = s.workspace || UNGROUPED;
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return [...map.entries()]
      .map(([key, items]) => ({
        key,
        items,
        hasCurrent: items.some((s) => s.id === currentSessionId),
      }))
      .sort((a, b) => {
        if (a.key === UNGROUPED) return 1;
        if (b.key === UNGROUPED) return -1;
        if (a.key === currentWorkspace) return -1;
        if (b.key === currentWorkspace) return 1;
        return String(b.items[0]?.updatedAt || "").localeCompare(String(a.items[0]?.updatedAt || ""));
      });
  }, [visibleSessions, currentSessionId, currentWorkspace]);

  const groupLabel = (key: string) => {
    if (key === UNGROUPED) return t("sidebar.ungrouped");
    return key.split(/[/\\]/).filter(Boolean).pop() || key;
  };

  const toggleGroup = (key: string) => {
    // Explicit choice wins: flip the group's current effective state into the
    // override sets (clear the set that agrees with the flip, fill the other).
    const g = groups.find((x) => x.key === key);
    const currentlyOpen =
      userExpanded.has(key) || (!userCollapsed.has(key) && (g?.hasCurrent || g?.key === currentWorkspace));
    setUserExpanded((prev) => {
      const n = new Set(prev);
      if (currentlyOpen) n.delete(key);
      else n.add(key);
      return n;
    });
    setUserCollapsed((prev) => {
      const n = new Set(prev);
      if (currentlyOpen) n.add(key);
      else n.delete(key);
      return n;
    });
  };

  const groupIsExpanded = (g: { key: string; hasCurrent: boolean }) => {
    // A live search overrides collapse: matches hidden inside a collapsed
    // group would be invisible, which reads as "not found". All groups with
    // matches render expanded while the query is active.
    if (q) return true;
    if (userExpanded.has(g.key)) return true;
    if (userCollapsed.has(g.key)) return false;
    return g.hasCurrent || g.key === currentWorkspace;
  };

  const toggleShowAll = (key: string) => {
    setShowAllGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleDeleteSession = useCallback(async (id: string) => {
    const r = await fetch(`/api/chat-history/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${r.status}`);
    }
    // The server broadcasts the refreshed `sessions` event; the store update
    // removes the row from the sidebar. If the deleted session was the active
    // one, the server would have 409'd; if a new session is required, the
    // user can click "+ New".
  }, []);

  // Same switch contract as the composer's workspace control (the entry point
  // is new, the server path is not): absolute-path validation, a confirm when
  // the conversation could reference now-stale paths, then the restart-carrying
  // set_workspace with the standard pending treatment. A picked path goes
  // through the exact same contract — only the typing is skipped.
  const submitWorkspacePath = (input: string, close: () => void) => {
    const next = input.trim();
    if (!next) return;
    if (!next.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(next)) {
      setWsError(t("composer.strip.workspaceAbsolute"));
      return;
    }
    if (next === currentWorkspace) {
      close();
      return;
    }
    if (turns.length > 0 && !window.confirm(t("composer.strip.workspaceConfirm", { path: next }))) {
      return;
    }
    setWsError(null);
    setWsDraft("");
    setPendingConfig("workspace");
    send({ type: "set_workspace", path: next });
    close();
  };

  const submitWorkspace = (close: () => void) => submitWorkspacePath(wsDraft, close);

  // Electron only: hand the picked folder to the same path as a typed one. A
  // cancelled dialog resolves null — the popover simply stays open.
  const browseWorkspace = async (close: () => void) => {
    const picked = await window.platform?.pickWorkdir();
    if (picked) submitWorkspacePath(picked, close);
  };

  return (
    <nav className="flex h-screen flex-col border-r border-border bg-card" data-testid="sidebar">
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <div className="text-base font-semibold">{t("sidebar.brand", { brand })}</div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t("sidebar.collapse")}
            title={t("sidebar.collapse")}
            aria-expanded="true"
            data-testid="nav-collapse"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-0.5 p-2">
        {NAV_BASE.map((n) => {
          const Icon = n.icon;
          return (
            <NavLink
              key={n.to}
              to={n.to}
              data-testid={n.testId}
              onClick={() => onNavigate?.()}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground",
                  "hover:bg-muted hover:text-foreground",
                  isActive && "bg-primary-deep text-primary-foreground hover:bg-primary-deep hover:text-primary-foreground",
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t(n.key)}
            </NavLink>
          );
        })}
      </div>

      {/* Workspaces section: header + workspace-grouped session list */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border p-2" data-testid="session-list-section">
        <div
          ref={wsPopoverRef}
          className="relative flex items-center justify-between px-1 pb-2 pt-1 text-xs font-semibold text-muted-foreground"
        >
          {searchOpen ? (
            <div className="flex w-full items-center gap-1">
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQuery("");
                    setSearchOpen(false);
                  }
                }}
                placeholder={t("sidebar.searchChats")}
                aria-label={t("sidebar.searchChats")}
                data-testid="workspace-search-input"
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setSearchOpen(false);
                }}
                aria-label={t("sidebar.closeSearch")}
                title={t("sidebar.closeSearch")}
                data-testid="workspace-search-close"
                className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <>
              <span>{t("sidebar.workspaces")}</span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setWsPopoverOpen(false);
                    setSearchOpen(true);
                  }}
                  aria-label={t("sidebar.searchChats")}
                  title={t("sidebar.searchChats")}
                  data-testid="workspace-search-toggle"
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Search className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setWsPopoverOpen((o) => !o)}
                  aria-label={t("sidebar.newWorkspace")}
                  title={t("sidebar.newWorkspace")}
                  aria-haspopup="menu"
                  aria-expanded={wsPopoverOpen}
                  data-testid="workspace-new"
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  onClick={() => {
                    setWsPopoverOpen(false);
                    navigate("/chat");
                    send({ type: "new_session" });
                    onNavigate?.();
                  }}
                  data-testid="new-chat-btn"
                  className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {t("sidebar.new")}
                </button>
              </span>
              {/* Anchored to the header row (not the trigger button) and spanning
                  its width — a button-anchored, wider-than-the-rail popover gets
                  clipped by the window's left edge. */}
              {wsPopoverOpen && (
                <div
                  role="menu"
                  data-testid="workspace-new-menu"
                  className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover p-2 shadow-lg"
                >
                  <input
                    type="text"
                    value={wsDraft}
                    onChange={(e) => {
                      setWsDraft(e.target.value);
                      if (wsError) setWsError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        submitWorkspace(() => setWsPopoverOpen(false));
                      }
                    }}
                    placeholder={t("composer.strip.workspacePlaceholder")}
                    aria-label={t("sidebar.newWorkspace")}
                    data-testid="workspace-new-input"
                    className={cn(
                      "w-full rounded-md border bg-background px-2 py-1 font-mono text-xs outline-none",
                      wsError ? "border-destructive" : "border-border focus:border-primary",
                    )}
                  />
                  {wsError && (
                    <p data-testid="workspace-new-error" className="mt-1 text-[10px] text-destructive">
                      {wsError}
                    </p>
                  )}
                  {CAN_PICK_NATIVE && (
                    <button
                      type="button"
                      onClick={() => void browseWorkspace(() => setWsPopoverOpen(false))}
                      data-testid="workspace-new-browse"
                      className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {t("composer.strip.workspaceBrowse")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" data-testid="session-list">
          {groups.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {t("sidebar.noChats")}
            </div>
          )}
          {groups.map((g) => {
            const expanded = groupIsExpanded(g);
            // Search results render in full — pagination over a filtered list
            // would hide matches the user explicitly asked for.
            const showAll = showAllGroups.has(g.key);
            const preview = q || showAll ? g.items : g.items.slice(0, GROUP_PREVIEW);
            const hiddenCount = g.items.length - preview.length;
            return (
              <div key={g.key} data-testid="workspace-group" data-workspace={g.key}>
                <button
                  type="button"
                  onClick={() => toggleGroup(g.key)}
                  data-testid="workspace-group-toggle"
                  title={g.key === UNGROUPED ? undefined : g.key}
                  className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {expanded ? (
                    <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                  )}
                  <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{groupLabel(g.key)}</span>
                  <span className="ml-auto shrink-0 tabular-nums opacity-60">{g.items.length}</span>
                </button>
                {expanded && (
                  <div className="flex flex-col gap-0.5 pl-3">
                    {preview.map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        isCurrent={s.id === currentSessionId}
                        unseen={s.id !== currentSessionId && isSessionUnseen(s, lastSeen)}
                        onNavigate={onNavigate}
                        registerRef={(el) => {
                          if (el) rowRefs.current.set(s.id, el);
                          else rowRefs.current.delete(s.id);
                        }}
                        onOpen={() => {
                          // URL leads the switch (deep-link effect no-ops once
                          // the server's session_loaded lands); back/refresh
                          // keep place.
                          navigate(`/chat/${s.id}`);
                          if (s.id !== currentSessionId) send({ type: "switch_session", id: s.id });
                          else {
                            // Welcome-state trap (add-artifact-delivery): the
                            // live session IS this one but this client's view
                            // is empty (fresh tab, reload without the URL id).
                            // The deep-link effect no-ops on an id equal to
                            // current, and a bare no-op leaves the transcript
                            // unreachable — the server's same-id switch is a
                            // transcript re-request, so send it. Imperative
                            // read: subscribing turns here would re-render the
                            // sidebar per streamed token.
                            const st = useChatStore.getState();
                            if (st.turns.length === 0 && st.pendingSession === null) {
                              send({ type: "switch_session", id: s.id });
                            }
                          }
                          setLastSeen(markSessionSeen(s.id));
                          onNavigate?.();
                        }}
                        onContextMenu={(el) => setMenuTarget({ id: s.id, el })}
                      />
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleShowAll(g.key)}
                        data-testid="workspace-show-more"
                        className="rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {t("sidebar.showMore", { count: hiddenCount })}
                      </button>
                    )}
                    {showAll && g.items.length > GROUP_PREVIEW && (
                      <button
                        type="button"
                        onClick={() => toggleShowAll(g.key)}
                        data-testid="workspace-show-less"
                        className="rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {t("sidebar.showLess")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {menuTarget && (
        <ChatSessionMenu
          sessionId={menuTarget.id}
          isCurrent={menuTarget.id === currentSessionId}
          onDelete={handleDeleteSession}
          triggerRef={{ current: menuTarget.el }}
          onClose={() => setMenuTarget(null)}
        />
      )}

      {/* Footer: one row. Connection status on the left, Settings on the right.
          The agent select, model chip, clear button and locale select that used
          to stack here have moved to the control strip, the session menu, and
          Settings respectively — none of them belonged in a permanent rail. */}
      <div
        className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-3"
        data-testid="sidebar-footer"
      >
        <StatusRow status={status} />
        <button
          type="button"
          onClick={() => {
            navigate(settingsPath("general"), { state: { backgroundLocation: location } });
            onNavigate?.();
          }}
          aria-label={t("settings.title")}
          title={t("settings.title")}
          data-testid="settings-btn"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </nav>
  );
}

// One session row inside a workspace group. Extracted so the group mapping
// stays readable; the row keeps every pre-grouping behavior: click-to-switch,
// active highlight, and the right-click context menu.
function SessionRow({
  session: s,
  isCurrent,
  unseen,
  registerRef,
  onOpen,
  onContextMenu,
}: {
  session: SessionMeta;
  isCurrent: boolean;
  unseen?: boolean;
  onNavigate?: () => void;
  registerRef: (el: HTMLElement | null) => void;
  onOpen: () => void;
  onContextMenu: (el: HTMLElement) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <button
      ref={registerRef}
      data-testid="session-row"
      data-session-id={s.id}
      data-current={isCurrent ? "true" : "false"}
      data-unseen={unseen ? "true" : "false"}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.currentTarget);
      }}
      onKeyDown={(e) => {
        if (e.shiftKey && e.key === "F10") {
          e.preventDefault();
          onContextMenu(e.currentTarget);
        }
      }}
      className={cn(
        "flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
        isCurrent && "bg-muted",
      )}
    >
      <span className="flex items-center gap-1.5">
        {unseen && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            data-testid="session-unread-dot"
            aria-label={t("sidebar.unread")}
          />
        )}
        <span className="truncate text-foreground">{s.title || t("sidebar.untitled")}</span>
      </span>
      {s.updatedAt && (
        <span className="text-[10px] text-muted-foreground">
          {new Date(s.updatedAt).toLocaleString(i18n.language)}
        </span>
      )}
    </button>
  );
}

function StatusRow({ status }: { status: "connecting" | "connected" | "disconnected" }) {
  const { t } = useTranslation();
  const key =
    status === "connected" ? "status.connected" : status === "connecting" ? "status.connecting" : "status.disconnected";
  const dot =
    status === "connected"
      ? "bg-success"
      : status === "disconnected"
        ? "bg-destructive"
        : "bg-warning";
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="status">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", dot)} data-testid="status-dot" />
      <span data-testid="status-text">{t(key)}</span>
    </div>
  );
}
