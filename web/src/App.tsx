// Routes for the React SPA.
//
// Two kinds of surface, and the split is the whole point of the shell:
//   - Work surfaces (Chat, Knowledge, Agents, Bots, Trace) are nav tabs. You
//     come here to look at or produce something.
//   - Configuration lives in the Settings modal at /settings/:section. You come
//     to change a setting and leave — so it overlays rather than replaces, and
//     dismissing puts you back where you were.
// Legacy standalone config routes (/models, /mcp, /skills, /dashboard, and the
// older /extensions/*) redirect into their Settings section so bookmarks live.
//
// Code splitting: the chat surface (the product's primary view) stays in the
// eager entry chunk; every other page loads lazily on first navigation.

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PanelLeft } from "lucide-react";
import { registryFor, useChatStore } from "@platform/core";
import { listCacheClear, listCacheInvalidate } from "@/lib/listCache";
import { studioHref, isCrossOrigin } from "@/lib/studio-origin";
import { usePreviewStore } from "@/hooks/usePreviewStore";
import { useAuthStore } from "@/hooks/useAuth";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Sidebar } from "@/components/Sidebar";
import { ShellErrorBoundary } from "@/components/ShellErrorBoundary";
import { ToastHost } from "@/components/Toast";
import { ToastV2Host } from "@/components/ui/toast";
import { buildGMap, gKeyStep, type NavTarget } from "@/lib/gNav";
import { ChatPage } from "@/pages/ChatPage";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useSearchParams } from "react-router-dom";
import { settingsPath } from "@/components/settings/sections";

const DocumentsPage = lazy(() =>
  import("@/pages/DocumentsPage").then((m) => ({ default: m.DocumentsPage })),
);
// W2 (add-supply-studio-migration): /studio route retired — the AgentStudioPage
// lazy import goes with it (the page module stays single-sourced for the facet
// host, web/ tree alias `@`).
const AgentMarketPage = lazy(() => import("@/pages/AgentMarketPage").then((m) => ({ default: m.AgentMarketPage })));
// 渠道 (restructure-yizuo-ia): the social-bot management surface left the
// Settings modal for primary navigation — answering on Telegram/飞书/企微/
// 公众号 is an outbound-communication work surface, not configuration.
const BotsPage = lazy(() => import("@/pages/BotsPage").then((m) => ({ default: m.BotsPage })));
const TuningPage = lazy(() => import("@/pages/TuningPage").then((m) => ({ default: m.TuningPage })));
// 智能体工作室 (add-agent-studio): the visual agent builder — one surface,
// four emit targets (D8 additive: entry from the agents page, v1).
const TraceDetailPage = lazy(() =>
  import("@/pages/TracePage").then((m) => ({ default: m.TraceDetailPage })),
);
const SharePage = lazy(() => import("@/pages/SharePage").then((m) => ({ default: m.SharePage })));
const TasksPage = lazy(() => import("@/pages/TasksPage").then((m) => ({ default: m.TasksPage })));
const FleetPage = lazy(() => import("@/pages/FleetPage").then((m) => ({ default: m.FleetPage })));
const FleetsPage = lazy(() => import("@/pages/FleetsPage").then((m) => ({ default: m.FleetsPage })));
const FleetConsolePage = lazy(() =>
  import("@/pages/FleetConsolePage").then((m) => ({ default: m.FleetConsolePage })),
);
const MachinesPage = lazy(() => import("@/pages/MachinesPage").then((m) => ({ default: m.MachinesPage })));
// fold-blueprint-into-studio D2 (two-step retire): the old route redirects
// to the studio team mode. Step 2 executed 2026-10-31: the dead component is
// removed after hermetic e2e (my tree ≈ base) + blueprint regression 26/0 —
// the redirect itself stays and rides the rollout walkthrough.
// W2 redirects (add-supply-studio-migration 4.1/4.2): the creation surface
// lives on the supply domain now. The origin + href shape live in
// @/lib/studio-origin (one definition, shared with the market face and the
// fleet 来源蓝图 chip). Queries pass through untouched — ?doc= ids are
// migration-stable.
function StudioRouteRedirect({ params = {} }: { params?: Record<string, string> }) {
  const [sp] = useSearchParams();
  const merged = new URLSearchParams(sp);
  for (const [k, v] of Object.entries(params)) if (!merged.has(k)) merged.set(k, v);
  const q = merged.toString();
  const target = studioHref(q ? `?${q}` : "");
  const external = isCrossOrigin(target);
  // <Navigate> takes in-app paths only: an absolute URL is read as a path and
  // the shell lands on the catch-all error face (live 2026-11-08, /studio?doc=…
  // → 页面加载出了问题). Cross-origin targets therefore replace the document.
  useEffect(() => {
    if (external) window.location.replace(target);
  }, [external, target]);
  if (external) return null;
  return <Navigate to={target} replace />;
}
const ResourcesPage = lazy(() =>
  import("@/pages/ResourcesPage").then((m) => ({ default: m.ResourcesPage })),
);

// /packs → the merged 智能体市场 surface (restructure-yizuo-ia). The old page's
// two tabs map 1:1 onto the market surface's tabs, and every other query
// parameter rides along — the facet Studio's `deployCastPack=` handoff lands on
// the market tab's detail dialog exactly as before.
function PacksRedirect() {
  const [sp] = useSearchParams();
  const merged = new URLSearchParams(sp);
  const tab = merged.get("tab");
  if (tab !== "market" && tab !== "mine") merged.delete("tab");
  const q = merged.toString();
  return <Navigate to={`/agents${q ? `?${q}` : "?tab=market"}`} replace />;
}
const MemoryPage = lazy(() => import("@/pages/MemoryPage").then((m) => ({ default: m.MemoryPage })));
const ExternalServicePage = lazy(() =>
  import("@/pages/EmbeddedServicePages").then((m) => ({ default: m.ExternalServicePage })),
);
const AppCenterPage = lazy(() => import("@/pages/AppCenterPage").then((m) => ({ default: m.AppCenterPage })));
const BoardsPage = lazy(() => import("@/pages/BoardsPage").then((m) => ({ default: m.BoardsPage })));
const ZhiyuPage = lazy(() => import("@/pages/ZhiyuPage").then((m) => ({ default: m.ZhiyuPage })));
const ZhiyuRoomPage = lazy(() => import("@/pages/ZhiyuRoomPage").then((m) => ({ default: m.ZhiyuRoomPage })));
const ZhiyuEmbedPage = lazy(() => import("@/pages/ZhiyuEmbedPage").then((m) => ({ default: m.ZhiyuEmbedPage })));
const CopilotDock = lazy(() => import("@/components/CopilotDock").then((m) => ({ default: m.CopilotDock })));
// The preview drawer is code-split for the same reason as the pages above, and
// one more: a session that never previews a file should not download the
// renderers (mammoth among them).
const PreviewDrawer = lazy(() => import("@/components/preview/PreviewDrawer"));

function RouteFallback() {
  return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
}

export default function App() {
  const auth = useAuthStore();
  // The socket identity is fixed at upgrade. Reconnecting when the trusted
  // identity changes is what lets optional SSO swap the anonymous socket for
  // an identity-scoped one (and back on sign-out).
  const identityKey = auth.authenticated
    ? `fwd:${auth.email ?? ""}`
    : auth.ssoAuthenticated
      ? `sso:${auth.ssoEmail ?? ""}`
      : "";
  const authEnabled = auth.mode === "forward_auth" || auth.mode === "logto";
  const { send } = useWebSocket(
    !auth.loading && (!authEnabled || auth.authenticated),
    identityKey,
  );
  const { t } = useTranslation();
  const toggleAllGroups = useChatStore((s) => s.toggleAllGroups);
  const previewOpen = usePreviewStore((s) => s.target !== null);
  const location = useLocation();
  const navigate = useNavigate();
  // Off-canvas nav drawer (below md the 240px rail would starve the content
  // column to a sliver — the drawer restores it without a second layout).
  const [navOpen, setNavOpen] = useState(false);
  // Desktop rail collapse (md+): a full hide, not an icon rail — the tabs
  // carry labels and the session region has no meaningful collapsed form.
  // Persisted per browser; the lazy initializer reads it in the same render
  // pass so the first commit is already in the saved state (no flash).
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("sidebar.collapsed") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    void auth.refresh();
  }, [auth.refresh]);

  // List-cache wiring (openspec: polish-web-surfaces, web-list-surfaces). The
  // catalog is role-filtered per user, so the cache must never cross identities:
  // clear it whenever the authenticated identity changes. window-focus
  // revalidation lives in the hook itself.
  const catalogVersion = useChatStore((s) => s.catalogVersion);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `identityKey` is the deliberate trigger — an identity switch invalidates everything cached for the previous one
  useEffect(() => {
    listCacheClear();
  }, [identityKey]);
  // `catalog_changed` (cloud catalog edits, catalogVersion bump) invalidates the
  // catalog read so live edits show up without a manual reload.
  useEffect(() => {
    if (catalogVersion === 0) return;
    listCacheInvalidate("catalog");
  }, [catalogVersion]);

  const authReady = !auth.loading;
  const loginRequired = authEnabled && !auth.authenticated;

  const toggleNavCollapsed = useCallback(() => {
    setNavCollapsed((v) => {
      try {
        localStorage.setItem("sidebar.collapsed", String(!v));
      } catch {
        // Private-mode quota errors are non-fatal: the state still toggles.
      }
      return !v;
    });
  }, []);

  // Ctrl/Cmd + O toggles all activity groups (the master collapse; was
  // thinking blocks — see chat-activity-collapse).
  // Ctrl/Cmd + , opens Settings — the universal shortcut for it.
  // Ctrl/Cmd + B toggles the desktop nav rail (the convention most tools share).
  // g-prefix navigation (web-operate-states 4.3): press-and-release "g", then a
  // surface slug's first letter inside the window — g c jumps to chat. Inputs
  // are exempt (typing "g" in the composer must never navigate).
  const gTargets = useMemo<NavTarget[]>(
    () => registryFor("nav").map((e) => ({ slug: e.slug, path: `/${e.slug}` })),
    [],
  );
  const gMap = useMemo(() => buildGMap(gTargets), [gTargets]);
  const gStateRef = useRef<{ gAt: number | null }>({ gAt: null });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey) && !e.altKey) {
        const step = gKeyStep(gStateRef.current, Date.now(), e.key, gMap);
        gStateRef.current = step.next;
        if (step.goto) {
          e.preventDefault();
          navigate(step.goto);
        }
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        toggleAllGroups();
      } else if (e.key === ",") {
        e.preventDefault();
        // Already open? The modal owns its section state; do not stack.
        if (location.pathname.startsWith("/settings")) return;
        navigate(settingsPath("general"), { state: { backgroundLocation: location } });
      } else if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleNavCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAllGroups, navigate, location, toggleNavCollapsed, gMap]);

  if (!authReady) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background text-foreground">
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      </div>
    );
  }

  if (auth.mode === null) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background p-6 text-center" data-testid="auth-error">
        <div>
          <p className="text-sm font-medium text-destructive">{t("login.loadFailed", { error: auth.error })}</p>
          <button
            type="button"
            onClick={() => void auth.refresh()}
            className="mt-4 rounded-md bg-primary-deep px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {t("chat.retry")}
          </button>
        </div>
      </div>
    );
  }

  // The public share view is exempt from EVERY auth posture: an anonymous
  // recipient opening /share/:token must land on the shared session whether
  // the deployment gates logins or not (openspec: add-session-share). It
  // renders standalone — no rail, no websocket — and talks only to the
  // gateway's public share endpoint.
  if (authReady && location.pathname.startsWith("/share/")) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <SharePage />
      </Suspense>
    );
  }

  // Zhiyu visitor lanes (add-zhiyu-website-embed): the widget iframe shell and
  // the join-link full page render STANDALONE — guests hold no platform login,
  // and the host-page rail would be nonsense inside an iframe.
  if (location.pathname.startsWith("/zhiyu/embed/") || location.pathname.startsWith("/zhiyu/join/")) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <ZhiyuEmbedPage />
      </Suspense>
    );
  }

  if (loginRequired) {
    if (location.pathname !== "/login") return <Navigate to={`/login${location.search}`} replace />;
    return <LoginPage />;
  }

  if (location.pathname === "/login") {
    // Cross-domain deploy handoff (add-supply-studio-migration 2.2): facet
    // Studio's 部署团队 sends us to /login?deployCastPack=<id>&v=<n>, and the
    // SSO callback returns to that same URL with the session cookie already
    // set. Bouncing unconditionally to /chat dropped the pack id and the
    // handoff dead-ended on the chat home (live 2026-11-08).
    const params = new URLSearchParams(location.search);
    if (params.get("deployCastPack")) {
      // Lands on the merged 智能体市场 surface directly (restructure-yizuo-ia):
      // /packs redirects there anyway, so going through it only adds a hop. The
      // handoff query rides verbatim — the surface defaults to its market tab.
      return <Navigate to={`/agents?${params.toString()}`} replace />;
    }
    return <Navigate to="/chat" replace />;
  }

  // The modal renders over whatever the user was looking at. On a direct load
  // of /settings/* there is no background, so /chat stands in — the same
  // resolution `/` and unmatched paths already use.
  const state = location.state as { backgroundLocation?: typeof location } | null;
  const settingsOpen = location.pathname.startsWith("/settings");
  const backgroundLocation = state?.backgroundLocation;
  const routedLocation = settingsOpen
    ? (backgroundLocation ?? { ...location, pathname: "/chat", search: "", hash: "" })
    : location;
  const backgroundPath = backgroundLocation
    ? `${backgroundLocation.pathname}${backgroundLocation.search ?? ""}`
    : "/chat";

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {/* md+: the permanent 240px rail, collapsible (add-sidebar-collapse).
          Collapsed unmounts the rail entirely — the content column takes the
          full width and a pinned affordance below restores it. */}
      {!navCollapsed && (
        <div className="hidden w-[240px] shrink-0 md:block">
          <Sidebar send={send} onCollapse={toggleNavCollapsed} />
        </div>
      )}
      {/* Below md, every surface that is NOT chat needs its own way into the
          drawer: the chat header carries the toggle, but the market / tuning /
          channels pages had none at all, so a narrow window stranded the user
          on whatever page they were on (measured 2026-11-09 at 640px: sidebar
          gone, no affordance). One shell-level control covers them all. */}
      {!navOpen && !location.pathname.startsWith("/chat") && (
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label={t("nav.openMenu")}
          title={t("nav.openMenu")}
          data-testid="nav-drawer-open"
          className="fixed left-2 top-2.5 z-30 rounded-md border border-border bg-card p-1.5 text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground md:hidden"
        >
          <PanelLeft className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {/* Below md: the same rail as an overlay drawer. Backdrop click dismisses. */}
      {navOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-scrim md:hidden"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          <div
            className="fixed inset-y-0 left-0 z-50 w-[240px] md:hidden"
            data-testid="nav-drawer"
          >
            <Sidebar send={send} onNavigate={() => setNavOpen(false)} />
          </div>
        </>
      )}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Restore affordance while the rail is collapsed: pinned exactly
            where the rail's edge was, so restoration never needs the
            keyboard. Desktop only — the drawer has its own toggle. */}
        {navCollapsed && (
          <button
            type="button"
            onClick={toggleNavCollapsed}
            aria-label={t("sidebar.expand")}
            title={t("sidebar.expand")}
            data-testid="nav-expand"
            className="absolute left-2 top-2 z-30 hidden rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground md:block"
          >
            <PanelLeft className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        {/* Inner render boundary (openspec: harden-spa-shell-resilience): a
            route-level crash or a stale-shell chunk failure degrades the
            CONTENT area only — the rail and nav above stay alive. */}
        <ShellErrorBoundary><Suspense fallback={<RouteFallback />}>
          <Routes location={routedLocation}>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            {/* One route with an OPTIONAL session param: navigating /chat ↔
                /chat/:id must NOT remount ChatPage — a remount re-runs the
                deep-link effect, which re-sends switch_session and fights the
                server's session_loaded broadcasts (turns clobbered to zero). */}
            <Route
              path="/chat/:sessionId?"
              element={<ChatPage send={send} onToggleNav={() => setNavOpen((v) => !v)} />}
            />

            {/* Work surfaces — the nav tabs. Bots and Trace were demoted to
                Settings sections (channels / diagnostics); the former page
                routes redirect so bookmarks keep resolving. /trace/:turnId
                stays a top-level page — chat turn deep links land on it. */}
            <Route path="/knowledge" element={<DocumentsPage send={send} />} />
            <Route path="/resources" element={<ResourcesPage send={send} />} />
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="/agents" element={<AgentMarketPage />} />
            {/* 装包深链靶 (restructure-yizuo-ia): the pack surface merged INTO
                /agents, so /packs redirects into the matching tab and keeps
                every other query param (`deployCastPack=` handoff included). */}
            <Route path="/packs" element={<PacksRedirect />} />
            {/* 渠道 (restructure-yizuo-ia): nav work surface; the old Settings
                address and /bots redirect here (settings-surface). */}
            <Route path="/channels" element={<BotsPage />} />
            {/* 原生调优面 (add-supply-studio-migration 4.4): tuning leaves the
                dissolved four-zone facade — same candidate-review behavior,
                its own doorway (skill-self-evolution contract untouched). */}
            <Route path="/tuning" element={<TuningPage />} />
            <Route path="/apps" element={<AppCenterPage />} />
            <Route path="/bots" element={<Navigate to="/channels" replace />} />
            <Route path="/trace" element={<Navigate to={settingsPath("diagnostics")} replace />} />
            <Route path="/trace/:turnId" element={<TraceDetailPage />} />
            <Route path="/tasks" element={<TasksPage send={send} />} />
            {/* Desktop Wanxing fleet console (add-desktop-fleet-console): the
                seat's live snapshot + the public catalog, read-only via the
                cell's proxy lane. */}
            <Route path="/fleet" element={<FleetPage />} />
            {/* Agent fleets (agent-fleet-core + agent-fleet-templates): the
                organization layer and its cockpit — /fleets/:id IS the cockpit
                (single-page merge, D6). */}
            <Route path="/fleets" element={<FleetsPage />} />
            <Route path="/fleets/:fleetId" element={<FleetsPage />} />
            {/* Team console (add-pack-console): the team's own face — the blocks
                its pack declared, read-only. The facet share page mounts the
                same component with surface="share". */}
            <Route path="/fleets/:fleetId/console" element={<FleetConsolePage />} />

            {/* Machines console (add-unified-fleet-console): steward-paired
                machines, derived health, desired-state editing. Read-mostly:
                edits land in the cloud desired set; machines pull and apply. */}
            <Route path="/machines" element={<MachinesPage />} />

            {/* 蓝图构造间/智能体工作室 (add-blueprint-studio + add-agent-studio)
                RETIRED (add-supply-studio-migration 4.1, W2): /studio 退役为
                供给域重定向 — query 原样透传（?doc= 文档 id 跨迁移稳定，回归钉
                在 e2e）。构建面唯一宿主=供给域 Studio（facet）。 */}
            <Route path="/studio" element={<StudioRouteRedirect />} />

            <Route path="/blueprints" element={<StudioRouteRedirect params={{ from: "blueprint" }} />} />

            {/* 萬星·智语 (add-zhiyu-room): rooms list + the room itself. */}
            <Route path="/zhiyu" element={<ZhiyuPage />} />
            <Route path="/zhiyu/:roomId" element={<ZhiyuRoomPage />} />

            {/* Line boards (add-line-boards-and-action-gate): /boards/:line renders
                a board for each integrated product line (facet/wanxing). */}
            <Route path="/boards/:line" element={<BoardsPage />} />

            <Route path="/documents" element={<Navigate to="/knowledge" replace />} />
            <Route path="/external/:appId" element={<ExternalServicePage />} />

            {/* Configuration moved into the Settings modal. These redirects
                keep existing deep links and bookmarks resolving. */}
            <Route path="/models" element={<Navigate to={settingsPath("models")} replace />} />
            {/* unify-material-market: tools/skills moved out of Settings into the
                materials market. These stay as route-level redirects (the modal
                must never open for them). */}
            <Route path="/mcp" element={<Navigate to="/agents?tab=tools" replace />} />
            <Route path="/skills" element={<Navigate to="/agents?tab=skills" replace />} />
            <Route path="/extensions" element={<Navigate to="/agents?tab=tools" replace />} />
            <Route path="/extensions/mcp" element={<Navigate to="/agents?tab=tools" replace />} />
            <Route
              path="/extensions/skills"
              element={<Navigate to="/agents?tab=skills" replace />}
            />
            <Route path="/dashboard" element={<Navigate to={settingsPath("status")} replace />} />

            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </Suspense></ShellErrorBoundary>
        <ToastHost />
        {/* Toast v2 (web-design-system): the queued multi-severity host. Mounted
            once at the root; page wiring moves onto showToast() in batch ③.
            closeLabel is locale-supplied so the primitive carries no strings. */}
        <ToastV2Host closeLabel={t("common.close")} />
      </div>

      {/* Copilot dock (add-line-boards-and-action-gate): FAB + iframe dock.
          `send` restores the main chat's agent when the dock closes
          (copilot-dock-focused-preset). */}
      <Suspense fallback={null}>
        <CopilotDock send={send} />
      </Suspense>

      {/* File preview overlays the shell instead of replacing a region, so the
          chat (and its socket) stays mounted while a file is open. */}
      {previewOpen && (
        <Suspense fallback={null}>
          <PreviewDrawer />
        </Suspense>
      )}

      {settingsOpen && (
        <Routes>
          <Route
            path="/settings"
            element={<Navigate to={settingsPath("general")} replace state={location.state} />}
          />
          {/* Retired sections redirect into the builder hub (their surfaces
              moved there): presets → the Creations area, packs → the Supply
              area. The legacy tab slugs canonicalize per add-agent-builder-hub
              D5 (surfaces.ts SURFACE_SLUG_ALIASES). */}
          {/* Retired sections (add-supply-studio-migration 4.5): presets →
              Settings 原生面; packs → the agent-market face (install panel).
              MUST NOT 404 (e2e 回归钉). */}
          <Route
            path="/settings/presets"
            element={<Navigate to={settingsPath("general")} replace state={location.state} />}
          />
          <Route
            path="/settings/packs"
            element={<Navigate to="/agents" replace state={location.state} />}
          />
          {/* Retired section (settings-connect-center): the search wiring moved
              into the connections section's search-service card. The slug stays
              addressable via this stable redirect, per settings-surface. */}
          <Route
            path="/settings/websearch"
            element={<Navigate to="/settings/connections?panel=search" replace state={location.state} />}
          />
          {/* restructure-yizuo-ia: `channels` left the Settings container for
              primary navigation — the old address must not open the modal. */}
          <Route path="/settings/channels" element={<Navigate to="/channels" replace />} />
          {/* unify-material-market: tools/skills/plugins are market tabs now. */}
          <Route path="/settings/mcp" element={<Navigate to="/agents?tab=tools" replace />} />
          <Route path="/settings/skills" element={<Navigate to="/agents?tab=skills" replace />} />
          <Route path="/settings/plugins" element={<Navigate to="/agents?tab=plugins" replace />} />
          <Route
            path="/settings/:section"
            element={<SettingsDialog backgroundPath={backgroundPath} />}
          />
        </Routes>
      )}
    </div>
  );
}
