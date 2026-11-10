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
  BookOpen,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronDown,
  ChevronRight,
  Clock,
  DraftingCompass,
  Folder,
  FolderOpen,
  FolderPlus,
  Brain,
  LayoutGrid,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Network,
  PanelLeftClose,
  Search,
  Server,
  Settings,
  Ship,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useChatStore } from "@platform/core";
import type { ClientMessage, SessionMeta } from "@platform/core";
import { NAV_SURFACES, NAV_FAMILIES, FACTORY_PRESETS, FACTORY_PRESET_SLUG, registryFor } from "@platform/core";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { getLastSeen, markSessionSeen, isSessionUnseen } from "@/lib/unread";
import { ChatSessionMenu } from "@/components/ChatSessionMenu";
import { WorkbenchPanel } from "@/components/WorkbenchPanel";
import { useAppConfig, useBranding } from "@/hooks/useAppConfig";
import { settingsPath } from "@/components/settings/sections";
import { useProjectsStore } from "@/hooks/useProjectsStore";

interface Props {
  send: (m: ClientMessage) => void;
  // Called after in-drawer navigation so App can close the off-canvas drawer.
  onNavigate?: () => void;
  // Desktop rail collapse (App owns the state). Provided only for the md+
  // rail — the below-md drawer renders without it, so its header carries no
  // collapse toggle there.
  onCollapse?: () => void;
}

// Icons are presentation and stay in the client (the registry carries slugs,
// i18n keys and testids — the server never needs a glyph). A nav slug the
// registry knows but this map lacks renders without an icon rather than
// dropping the tab.
const NAV_ICONS: Record<string, typeof MessageSquare> = {
  chat: MessageSquare,
  knowledge: BookOpen,
  resources: FolderOpen,
  memory: Brain,
  agents: Sparkles,
  tuning: SlidersHorizontal,
  apps: LayoutGrid,
  tasks: Clock,
  fleets: Network,
  machines: Server,
  fleet: Ship,
  channels: MessagesSquare,
  zhiyu: MessagesSquare,
  blueprints: DraftingCompass,
};


// Route for a nav slug (the registry slug IS the route segment — the R1
// "slug is public API" rule).
const navRoute = (slug: string) => `/${slug}`;

// Sessions whose workspace stamp is missing (rows written before the
// capability) group under this sentinel key.
const UNGROUPED = "__ungrouped__";
// Web-side fallback bucket (add-web-project-container): sessions with no
// project attribution (desktop origin, legacy rows) or whose project id is no
// longer listed. Read-time only — never a stored project row.
const DEFAULT_PROJECT = "__default_project__";
// Per-group preview cap — mirrors the welcome screen's recent-list preview.
const GROUP_PREVIEW = 5;

// The native folder picker exists only inside the Electron shell (exposed via
// the preload bridge); in a plain browser the path input is the only entry.
import { IS_DESKTOP } from "@/lib/environment";
const CAN_PICK_NATIVE = IS_DESKTOP;

export function Sidebar({ send, onNavigate, onCollapse }: Props) {
  const { t } = useTranslation();
  // The deployment's own name (ASSISTANT_NAME) wins over the localized default.
  const { brand } = useBranding();
  const { resolvedLayout } = useAppConfig();
  // The nav renders from the server-resolved layout (layout-configuration).
  // A server that predates the field (null) falls back to the factory snapshot
  // — byte-identical to the pre-change hardcoded list. The desktop-only
  // predicate stays client-side: only this shell knows it is the shell.
  const visibleNav = useMemo(() => {
    const slugs = resolvedLayout?.nav ?? FACTORY_PRESETS[FACTORY_PRESET_SLUG]!.nav!;
    const byRegistry = new Map(registryFor("nav").map((e) => [e.slug, e]));
    return slugs
      .map((slug) => byRegistry.get(slug))
      .filter((e): e is (typeof NAV_SURFACES)[number] => Boolean(e))
      .filter((e) => !e.predicates?.desktopOnly || IS_DESKTOP)
      .map((e) => ({
        to: navRoute(e.slug),
        key: e.i18nKey,
        testId: e.testId,
        slug: e.slug,
        icon: NAV_ICONS[e.slug],
      }));
  }, [resolvedLayout]);
  const status = useChatStore((s) => s.status);
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const currentWorkspace = useChatStore((s) => s.currentWorkspace);
  const turns = useChatStore((s) => s.turns);
  const setPendingConfig = useChatStore((s) => s.setPendingConfig);
  const catalogVersion = useChatStore((s) => s.catalogVersion);
  const navigate = useNavigate();
  const location = useLocation();


  // ── Nav families (add-knowledge-memory-surface D1) ────────────────────────
  // Registry-resolved nav entries arranged into collapsible families
  // (Codex-style). Membership comes from @platform/core; the resolver already
  // decided which slugs exist, so a hidden slug never appears in its family.
  // The family holding the active route always renders expanded.
  const navFamilyOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of NAV_FAMILIES) for (const s of f.slugs) m.set(s, f.id);
    return m;
  }, []);
  const NAV_FAMILY_COLLAPSED_KEY = "nav.families.collapsed";
  // Families start EXPANDED (sidebar-nav-families): hiding members behind a
  // collapse state by default would re-create exactly the "surfaces I cannot
  // see" problem this change exists to fix. On a short rail the region scrolls
  // within its share of the column instead (see the nav region's max height).
  const [collapsedFamilies, setCollapsedFamilies] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(NAV_FAMILY_COLLAPSED_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const toggleFamily = (id: string) => {
    setCollapsedFamilies((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      try {
        localStorage.setItem(NAV_FAMILY_COLLAPSED_KEY, JSON.stringify([...n]));
      } catch {
        /* storage blocked — the toggle just stops persisting */
      }
      return n;
    });
  };
  // Families actually rendered (a family with one present member flattens to a
  // plain entry and has nothing to collapse).
  const renderedFamilyIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of visibleNav) {
      const fam = navFamilyOf.get(item.slug);
      if (fam) counts.set(fam, (counts.get(fam) ?? 0) + 1);
    }
    return NAV_FAMILIES.filter((f) => (counts.get(f.id) ?? 0) > 1).map((f) => f.id);
  }, [visibleNav, navFamilyOf]);
  const allFamiliesCollapsed =
    renderedFamilyIds.length > 0 && renderedFamilyIds.every((id) => collapsedFamilies.has(id));
  const toggleAllFamilies = () => {
    setCollapsedFamilies((prev) => {
      const collapseAll = !renderedFamilyIds.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of renderedFamilyIds) {
        if (collapseAll) next.add(id);
        else next.delete(id);
      }
      try {
        localStorage.setItem(NAV_FAMILY_COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* storage blocked — the toggle just stops persisting */
      }
      return next;
    });
  };
  const activeFamilyId = useMemo(() => {
    const hit = visibleNav.find((n) => location.pathname === n.to || location.pathname.startsWith(`${n.to}/`));
    return hit ? (navFamilyOf.get(hit.slug) ?? null) : null;
  }, [visibleNav, location.pathname, navFamilyOf]);

  // Reveal-on-entry (fix-ia-shell-polish): when the route CHANGES INTO a family
  // whose stored state is collapsed, expand it once, so a deep link never lands
  // on a surface the user cannot see. This is an entry-time act, not a standing
  // force — an explicit collapse afterwards is honoured even for the active
  // family (the old `!isActiveFamily` condition made that click a dead control).
  const prevActiveFamilyRef = useRef<string | null>(null);
  useEffect(() => {
    const next = activeFamilyId;
    const prev = prevActiveFamilyRef.current;
    prevActiveFamilyRef.current = next;
    if (!next || prev === next) return;
    setCollapsedFamilies((prevSet) => {
      if (!prevSet.has(next)) return prevSet;
      const n = new Set(prevSet);
      n.delete(next);
      try {
        localStorage.setItem(NAV_FAMILY_COLLAPSED_KEY, JSON.stringify([...n]));
      } catch {
        /* storage blocked — the reveal still applies for this session */
      }
      return n;
    });
  }, [activeFamilyId]);

  // Render order: a family is emitted once, at the position of its first
  // present member; single-member families flatten to a plain entry.
  const navRender = useMemo(() => {
    const out: ({ kind: "item"; item: (typeof visibleNav)[number] } | { kind: "family"; id: string; items: (typeof visibleNav)[number][] })[] = [];
    const emitted = new Set<string>();
    for (const item of visibleNav) {
      const famId = navFamilyOf.get(item.slug);
      if (!famId) {
        out.push({ kind: "item", item });
        continue;
      }
      if (emitted.has(famId)) continue;
      emitted.add(famId);
      const members = visibleNav.filter((x) => navFamilyOf.get(x.slug) === famId);
      if (members.length <= 1) out.push({ kind: "item", item: members[0] ?? item });
      else out.push({ kind: "family", id: famId, items: members });
    }
    return out;
  }, [visibleNav, navFamilyOf]);
  // Workbench customization drawer (layout-configuration): the user's own
  // visibility/order adjustments on top of what the layers above left.
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [wsConfirm, setWsConfirm] = useState<{ path: string; close: () => void } | null>(null);

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
  // Projects (add-web-project-container): the web grouping key above the
  // workspace path. Fetched once; a failure degrades to an empty list and every
  // session falls back to 默认项目 — never a blank sidebar.
  const projects = useProjectsStore((s) => s.projects);
  const loadProjects = useProjectsStore((s) => s.load);
  const refreshProjects = useProjectsStore((s) => s.refresh);
  useEffect(() => {
    if (!IS_DESKTOP) void loadProjects();
  }, [loadProjects]);
  const projectNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);
  const projectPathById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.backingPath);
    return m;
  }, [projects]);
  // Group expansion is three-state: explicit user choice wins, otherwise the
  // group holding the active session (or the current workspace) is open.
  const [userExpanded, setUserExpanded] = useState<Set<string>>(new Set());
  const [userCollapsed, setUserCollapsed] = useState<Set<string>>(new Set());
  // Per-group "Show N more" — independent of the collapse state above.
  const [showAllGroups, setShowAllGroups] = useState<Set<string>>(new Set());
  // New-project popover (reuses the set_workspace contract). The primary
  // input is a project NAME — the server materializes the directory
  // (add-projects-automation-flow) and the switch chain does the rest;
  // advanced mode keeps the raw absolute-path input for existing folders.
  const [wsPopoverOpen, setWsPopoverOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [wsMode, setWsMode] = useState<"name" | "path">("name");
  const [wsDraft, setWsDraft] = useState("");
  const [wsError, setWsError] = useState<string | null>(null);
  const [wsBusy, setWsBusy] = useState(false);
  const wsPopoverRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  // The server bumps catalogVersion via `catalog_changed`; refetch the
  // switchable agent list so catalog/role edits appear live.
  useEffect(() => {
    if (catalogVersion > 0) send({ type: "list_agents" });
  }, [catalogVersion, send]);

  // Dismiss the project switcher on outside click / Escape (same contract as
  // the new-workspace popover above it).
  useEffect(() => {
    if (!projectMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjectMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [projectMenuOpen]);

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

  // Group the (filtered) sessions. The grouping KEY forks by surface
  // (add-web-project-container, design D3 / spec: sidebar-workspaces):
  //   web     = project attribution (id) → 默认项目 for unattributed rows,
  //             so the label is a project NAME and never an absolute path;
  //   desktop = the workspace path stamp, Ungrouped for unstamped rows —
  //             exactly the pre-change behaviour.
  // Ordering is unchanged conceptually: the group holding the current session
  // leads, the fallback bucket trails, the rest by their newest session.
  const fallbackKey = IS_DESKTOP ? UNGROUPED : DEFAULT_PROJECT;
  // The current session's group key on this surface (leads the ordering and
  // defaults open), mirroring the web/desktop key above.
  const currentSession = visibleSessions.find((s) => s.id === currentSessionId);
  const activeKey = IS_DESKTOP
    ? currentWorkspace || undefined
    : currentSession
      ? currentSession.projectId && projectNameById.has(currentSession.projectId)
        ? currentSession.projectId
        : DEFAULT_PROJECT
      : undefined;

  // Which project the switcher states (web only). A live session's attribution
  // wins; with none, the workspace the runtime is pointed at decides — that is
  // the project a new session will be stamped with. Anything unknown reads as
  // 默认项目 so the control never shows a dangling name.
  const currentProjectId = useMemo(() => {
    if (IS_DESKTOP) return null;
    if (activeKey) return activeKey;
    const byPath = projects.find((p) => p.backingPath && p.backingPath === currentWorkspace);
    return byPath?.id ?? DEFAULT_PROJECT;
  }, [activeKey, projects, currentWorkspace]);
  const currentProjectName =
    currentProjectId && currentProjectId !== DEFAULT_PROJECT
      ? (projectNameById.get(currentProjectId) ?? t("sidebar.defaultProject"))
      : t("sidebar.defaultProject");

  const groups = useMemo(() => {
    const map = new Map<string, SessionMeta[]>();
    for (const s of visibleSessions) {
      // Web: a project id only groups when that project is still listed —
      // a stale id (project gone) falls back rather than showing a dangling key.
      const key = IS_DESKTOP
        ? s.workspace || UNGROUPED
        : s.projectId && projectNameById.has(s.projectId)
          ? s.projectId
          : DEFAULT_PROJECT;
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
        if (a.key === fallbackKey) return 1;
        if (b.key === fallbackKey) return -1;
        if (a.key === activeKey) return -1;
        if (b.key === activeKey) return 1;
        return String(b.items[0]?.updatedAt || "").localeCompare(String(a.items[0]?.updatedAt || ""));
      });
  }, [visibleSessions, currentSessionId, activeKey, fallbackKey, projectNameById]);

  // Web labels are project NAMES (path is a detail, never a leading label);
  // desktop labels stay the trailing path segment as before.
  const groupLabel = (key: string) => {
    if (IS_DESKTOP) {
      if (key === UNGROUPED) return t("sidebar.ungrouped");
      return key.split(/[/\\]/).filter(Boolean).pop() || key;
    }
    if (key === DEFAULT_PROJECT) return t("sidebar.defaultProject");
    return projectNameById.get(key) ?? t("sidebar.defaultProject");
  };
  // Hover title: web shows the backing path (the detail), desktop the full path.
  const groupTitle = (key: string) => {
    if (IS_DESKTOP) return key === UNGROUPED ? undefined : key;
    if (key === DEFAULT_PROJECT) return undefined;
    return projectPathById.get(key) ?? undefined;
  };

  const toggleGroup = (key: string) => {
    // Explicit choice wins: flip the group's current effective state into the
    // override sets (clear the set that agrees with the flip, fill the other).
    const g = groups.find((x) => x.key === key);
    const currentlyOpen =
      userExpanded.has(key) || (!userCollapsed.has(key) && (g?.hasCurrent || g?.key === activeKey));
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
    return g.hasCurrent || g.key === activeKey;
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
    if (turns.length > 0) {
      setWsConfirm({ path: next, close });
      return;
    }
    setWsError(null);
    setWsDraft("");
    setPendingConfig("workspace");
    send({ type: "set_workspace", path: next });
    close();
  };

  const submitWorkspace = (close: () => void) => submitWorkspacePath(wsDraft, close);

  // Create-by-name: the server materializes the directory AND the project row
  // (add-web-project-container), then the SAME switch chain takes over
  // (validation no-ops — the path is server-issued — confirm still fires
  // mid-conversation, restart and broadcast as usual). The returned id is not
  // sent anywhere by the client: session attribution is stamped server-side at
  // first mirror by backing-path backtrace (design D2), so the only client job
  // is to refresh the project list so the new group can render immediately.
  const submitProjectName = async (close: () => void) => {
    const name = wsDraft.trim();
    if (!name) return;
    setWsBusy(true);
    setWsError(null);
    try {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setWsBusy(false);
      // Refresh first so the session created under this path groups by NAME,
      // not into 默认项目 (the backtrace lands the id; the list must know it).
      await refreshProjects();
      submitWorkspacePath(data.path, close);
    } catch (e) {
      setWsError((e as Error).message);
      setWsBusy(false);
    }
  };

  // Electron only: hand the picked folder to the same path as a typed one. A
  // cancelled dialog resolves null — the popover simply stays open.
  const browseWorkspace = async (close: () => void) => {
    const picked = await window.platform?.pickWorkdir();
    if (picked) submitWorkspacePath(picked, close);
  };

  // ── Fleet decision badge (agent-fleet-decision-lane) ──────────────────────
  // 「等你 N 件」 over the fleets nav item: the sum of every fleet's OPEN
  // decisions (expired never counts). A light poll — the lane's server side is
  // unread-by-derivation, so the client owns the refresh. Visiting /fleets
  // naturally refetches via the page.
  const [fleetOpenDecisions, setFleetOpenDecisions] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.pathname re-arms the poll on navigation — an intentional trigger, not a value this effect reads
  useEffect(() => {
    let alive = true;
    const fetchOpen = async () => {
      try {
        const r = await fetch("/api/fleets");
        if (!r.ok) return;
        const body = await r.json();
        if (alive) setFleetOpenDecisions((body.fleets ?? []).reduce((n: number, f: { openDecisions?: number }) => n + (f.openDecisions ?? 0), 0));
      } catch {
        /* an unreachable server keeps the last count */
      }
    };
    void fetchOpen();
    const timer = setInterval(fetchOpen, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [location.pathname]);

  // Zhiyu unread (add-zhiyu-room): the in-app notification lane's unread
  // counter over the 智语 nav item. Same light-poll posture as the fleets
  // badge; on non-zhiyu deployments the route 404s and the badge stays silent.
  const [zhiyuUnread, setZhiyuUnread] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.pathname re-arms the poll on navigation — an intentional trigger, not a value this effect reads
  useEffect(() => {
    let alive = true;
    const fetchUnread = async () => {
      try {
        const r = await fetch("/api/zhiyu/notifications?unread=1");
        if (!r.ok) return;
        const body = await r.json();
        if (alive) setZhiyuUnread(body.unread ?? 0);
      } catch {
        /* an unreachable server keeps the last count */
      }
    };
    void fetchUnread();
    const timer = setInterval(fetchUnread, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [location.pathname]);

  // Immediate badge clear (openspec: polish-web-surfaces, zhiyu-room 通知与触达):
  // the zhiyu page marks the lane read on view and broadcasts the fresh count,
  // so the badge drops the moment the user looks — no waiting for the 60s poll.
  useEffect(() => {
    const onUnread = (e: Event) => {
      const unread = (e as CustomEvent<{ unread?: number }>).detail?.unread;
      if (typeof unread === "number") setZhiyuUnread(unread);
    };
    window.addEventListener("zhiyu:unread", onUnread);
    return () => window.removeEventListener("zhiyu:unread", onUnread);
  }, []);


  return (
    <nav className="relative flex h-screen flex-col border-r border-border bg-card" data-testid="sidebar">
      {/* Workbench customization drawer: floats over the nav column, so the
          user sees the effect of a change behind it. */}
      {workbenchOpen && (
        <div className="absolute inset-y-0 left-0 z-20 w-full overflow-y-auto border-r border-border bg-card shadow-lg">
          <WorkbenchPanel onClose={() => setWorkbenchOpen(false)} />
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <div className="text-base font-semibold">{t("sidebar.brand", { brand })}</div>
        <div className="flex shrink-0 items-center gap-0.5">
        {/* 全部折叠 / 展开 (restructure-yizuo-ia). On a short rail the expanded
            families cannot all fit; one click folds every family so all six
            top-level entries are visible at once, and one click brings them
            back. Default stays EXPANDED — a collapsed default would hide
            surfaces, which is the problem this change exists to fix. */}
        <button
          type="button"
          onClick={toggleAllFamilies}
          aria-label={allFamiliesCollapsed ? t("sidebar.expandAllFamilies") : t("sidebar.collapseAllFamilies")}
          title={allFamiliesCollapsed ? t("sidebar.expandAllFamilies") : t("sidebar.collapseAllFamilies")}
          data-testid="nav-families-toggle-all"
          data-collapsed={allFamiliesCollapsed ? "true" : "false"}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {allFamiliesCollapsed ? (
            <ChevronsUpDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronsDownUp className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
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
      </div>

      {/* The nav region scrolls on its own: with thirteen entries and four
          families plus the build-family shortcuts, a tall viewport is not a
          given — and an unbounded region used to overflow over the session
          list and the footer (the settings button became unclickable). */}
      <div
        className="flex max-h-[52%] min-h-0 shrink flex-col gap-0.5 overflow-y-auto overscroll-contain p-2 [scrollbar-color:var(--color-border)_transparent] [scrollbar-width:thin]"
        data-testid="nav-region"
      >
        {navRender.map((entry) => {
          const navLink = (n: (typeof visibleNav)[number], indented: boolean) => {
            const Icon = n.icon;
            return (
              <NavLink
                key={n.to}
                to={n.to}
                data-testid={n.testId}
                onClick={() => onNavigate?.()}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 rounded-md py-2 pr-3 text-left text-sm text-muted-foreground",
                    indented ? "pl-6" : "pl-3",
                    "hover:bg-muted hover:text-foreground",
                    isActive && "bg-primary-deep text-primary-foreground hover:bg-primary-deep hover:text-primary-foreground",
                  )
                }
              >
                {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                {t(n.key)}
                {n.to === "/fleets" && fleetOpenDecisions > 0 ? (
                  <span
                    className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
                    data-testid="nav-fleets-badge"
                    title={t("fleets.decisions.waitingBadge", { count: fleetOpenDecisions })}
                  >
                    {fleetOpenDecisions}
                  </span>
                ) : null}
                {n.to === "/zhiyu" && zhiyuUnread > 0 ? (
                  <span
                    className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
                    data-testid="nav-zhiyu-badge"
                    title={t("zhiyu.notices.title")}
                  >
                    {zhiyuUnread}
                  </span>
                ) : null}
              </NavLink>
            );
          };

          if (entry.kind === "item") return navLink(entry.item, false);

          // A family: the STORED choice decides, always — including for the
          // family holding the active route (a standing force-expand turned that
          // click into a dead control). Reveal-on-entry above keeps a deep link
          // from landing inside a collapsed family; once there, the user owns it.
          const isActiveFamily = activeFamilyId === entry.id;
          const collapsed = collapsedFamilies.has(entry.id);
          return (
            <div key={`fam-${entry.id}`} data-testid={`nav-family-${entry.id}`}>
              <button
                type="button"
                onClick={() => toggleFamily(entry.id)}
                data-testid={`nav-family-toggle-${entry.id}`}
                aria-expanded={!collapsed}
                className="micro-label flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {collapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">{t(`nav.family.${entry.id}`)}</span>
                {collapsed && isActiveFamily ? (
                  <span
                    data-testid={`nav-family-active-dot-${entry.id}`}
                    aria-label={t("nav.familyActiveHint")}
                    title={t("nav.familyActiveHint")}
                    className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                  />
                ) : null}
              </button>
              {collapsed ? null : (
                <div className="flex flex-col gap-0.5">
                  {entry.items.map((n) => navLink(n, true))}

                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Workspaces section: header (which IS the project switcher) + grouped
          session list. The switcher is the VISIBLE form of a container that used
          to exist only as an implicit grouping key (project-container): it states
          which project the next session belongs to, and selecting one only sets
          that context — group membership stays fixed at a session's first turn
          (sidebar-workspaces). */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border p-2"
        data-testid="session-list-section"
      >
        <div
          ref={(el) => {
            wsPopoverRef.current = el;
            projectMenuRef.current = el;
          }}
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
              {IS_DESKTOP ? (
                <div
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-xs"
                  title={currentWorkspace || t("sidebar.defaultProject")}
                  data-testid="project-switcher"
                >
                  <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate font-mono" data-testid="project-switcher-desktop">
                    {currentWorkspace || t("sidebar.ungrouped")}
                  </span>
                </div>
              ) : (
                <div className="relative flex min-w-0 flex-1 items-center" data-testid="project-switcher">
                  <button
                    type="button"
                    data-testid="project-switcher-current"
                    data-project={currentProjectId ?? DEFAULT_PROJECT}
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    onClick={() => setProjectMenuOpen((v) => !v)}
                    className="micro-label flex min-w-0 flex-1 items-center gap-1 font-semibold text-foreground hover:text-foreground/80"
                  >
                    <span className="truncate" data-testid="project-switcher-label">
                      {currentProjectName}
                    </span>
                    <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                  </button>
                  {projectMenuOpen ? (
                    <div
                      role="menu"
                      data-testid="project-switcher-menu"
                      className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover p-1 shadow-lg"
                    >
                      {[
                        { id: DEFAULT_PROJECT, name: t("sidebar.defaultProject"), path: null as string | null },
                        ...projects.map((p) => ({ id: p.id, name: p.name, path: p.backingPath })),
                      ].map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={option.id === (currentProjectId ?? DEFAULT_PROJECT)}
                          data-testid={`project-switcher-option-${option.id}`}
                          onClick={() => {
                            setProjectMenuOpen(false);
                            if (!option.path) return; // 默认项目 is the read-time fallback, not a switch target
                            if (option.path === currentWorkspace) return;
                            submitWorkspacePath(option.path, () => undefined);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted",
                            option.id === (currentProjectId ?? DEFAULT_PROJECT)
                              ? "font-medium text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          <span className="truncate">{option.name}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
              <span className="flex shrink-0 items-center gap-1">
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
                  {wsMode === "name" ? (
                    <>
                      <input
                        autoFocus
                        type="text"
                        value={wsDraft}
                        onChange={(e) => {
                          setWsDraft(e.target.value);
                          if (wsError) setWsError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void submitProjectName(() => {
                              setWsPopoverOpen(false);
                              setWsMode("name");
                            });
                          }
                        }}
                        placeholder={t("sidebar.projectNamePlaceholder")}
                        aria-label={t("sidebar.newWorkspace")}
                        data-testid="workspace-new-input"
                        className={cn(
                          "w-full rounded-md border bg-background px-2 py-1 text-xs outline-none",
                          wsError ? "border-destructive" : "border-border focus:border-primary",
                        )}
                      />
                      {wsError && (
                        <p data-testid="workspace-new-error" className="mt-1 text-[10px] text-destructive">
                          {wsError}
                        </p>
                      )}
                      <div className="mt-1.5 flex items-center justify-between gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setWsMode("path");
                            setWsError(null);
                          }}
                          data-testid="workspace-new-advanced"
                          className="text-left text-[10px] text-muted-foreground hover:text-foreground"
                        >
                          {t("sidebar.useExistingFolder")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void submitProjectName(() => {
                            setWsPopoverOpen(false);
                            setWsMode("name");
                          })}
                          disabled={wsBusy || !wsDraft.trim()}
                          data-testid="workspace-new-create"
                          className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                          {t("sidebar.createProject")}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <input
                        autoFocus
                        type="text"
                        value={wsDraft}
                        onChange={(e) => {
                          setWsDraft(e.target.value);
                          if (wsError) setWsError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            submitWorkspace(() => {
                              setWsPopoverOpen(false);
                              setWsMode("name");
                            });
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
                          onClick={() => void browseWorkspace(() => {
                            setWsPopoverOpen(false);
                            setWsMode("name");
                          })}
                          data-testid="workspace-new-browse"
                          className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {t("composer.strip.workspaceBrowse")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setWsMode("name");
                          setWsError(null);
                        }}
                        data-testid="workspace-new-back-to-name"
                        className="mt-1 text-left text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        {t("sidebar.backToNewProject")}
                      </button>
                    </>
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
                {/* Disclosure state for the group (spec: web-operate-states
                    「键盘与 aria 底线」): the rows below are conditional on
                    `expanded`, so a screen reader must be told the state — the
                    nav-family disclosure above already carries it. */}
                <button
                  type="button"
                  onClick={() => toggleGroup(g.key)}
                  data-testid="workspace-group-toggle"
                  aria-expanded={expanded}
                  title={groupTitle(g.key)}
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
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setWorkbenchOpen(true)}
            aria-label={t("settings.layout.workbenchTitle")}
            title={t("settings.layout.workbenchTitle")}
            data-testid="workbench-btn"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
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
      </div>
      <ConfirmDialog
        open={wsConfirm != null}
        onOpenChange={(open) => {
          if (!open) setWsConfirm(null);
        }}
        title={wsConfirm ? (t("composer.strip.workspaceConfirm", { path: wsConfirm.path }).split("\n")[0] ?? "") : ""}
        description={wsConfirm ? (t("composer.strip.workspaceConfirm", { path: wsConfirm.path }).split("\n").slice(1).join("\n").trim() || "") : ""}
        confirmLabel={t("common.confirm")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          const c = wsConfirm;
          setWsConfirm(null);
          if (!c) return;
          setWsError(null);
          setWsDraft("");
          setPendingConfig("workspace");
          send({ type: "set_workspace", path: c.path });
          c.close();
        }}
      />
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
  // A background turn's state (concurrent-chat-sessions): the row must show a
  // run the user is NOT looking at, so this reads the server's per-session
  // `turnStatus` rather than the viewed session's own isStreaming.
  const turnStatus = s.turnStatus ?? null;
  return (
    <button
      ref={registerRef}
      data-testid="session-row"
      data-session-id={s.id}
      data-current={isCurrent ? "true" : "false"}
      data-unseen={unseen ? "true" : "false"}
      data-turn-status={turnStatus ?? "idle"}
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
        {turnStatus === "running" && (
          <Loader2
            className="h-3 w-3 shrink-0 animate-spin text-muted-foreground"
            data-testid="session-running"
            aria-label={t("sidebar.running")}
          />
        )}
        {turnStatus === "queued" && (
          <Clock
            className="h-3 w-3 shrink-0 text-muted-foreground"
            data-testid="session-queued"
            aria-label={t("sidebar.queued")}
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
