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

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PanelLeft } from "lucide-react";
import { useChatStore } from "@platform/core";
import { usePreviewStore } from "@/hooks/usePreviewStore";
import { useAuthStore } from "@/hooks/useAuth";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Sidebar } from "@/components/Sidebar";
import { ToastHost } from "@/components/Toast";
import { ChatPage } from "@/pages/ChatPage";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { settingsPath } from "@/components/settings/sections";

const DocumentsPage = lazy(() =>
  import("@/pages/DocumentsPage").then((m) => ({ default: m.DocumentsPage })),
);
const AgentsPage = lazy(() => import("@/pages/AgentsPage").then((m) => ({ default: m.AgentsPage })));
const BotsPage = lazy(() => import("@/pages/BotsPage").then((m) => ({ default: m.BotsPage })));
const TracePage = lazy(() => import("@/pages/TracePage").then((m) => ({ default: m.TracePage })));
const TraceDetailPage = lazy(() =>
  import("@/pages/TracePage").then((m) => ({ default: m.TraceDetailPage })),
);
const SharePage = lazy(() => import("@/pages/SharePage").then((m) => ({ default: m.SharePage })));
const TasksPage = lazy(() => import("@/pages/TasksPage").then((m) => ({ default: m.TasksPage })));
const ResourcesPage = lazy(() =>
  import("@/pages/ResourcesPage").then((m) => ({ default: m.ResourcesPage })),
);
const ExternalServicePage = lazy(() =>
  import("@/pages/EmbeddedServicePages").then((m) => ({ default: m.ExternalServicePage })),
);
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }, [toggleAllGroups, navigate, location, toggleNavCollapsed]);

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

  if (loginRequired) {
    if (location.pathname !== "/login") return <Navigate to={`/login${location.search}`} replace />;
    return <LoginPage />;
  }

  if (location.pathname === "/login") return <Navigate to="/chat" replace />;

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
      {/* Below md: the same rail as an overlay drawer (toggle lives in the
          chat header). Backdrop click dismisses. */}
      {navOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-scrim md:hidden"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 left-0 z-50 w-[240px] md:hidden">
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
        <Suspense fallback={<RouteFallback />}>
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

            {/* Work surfaces — the nav tabs. */}
            <Route path="/knowledge" element={<DocumentsPage send={send} />} />
            <Route path="/resources" element={<ResourcesPage send={send} />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/bots" element={<BotsPage />} />
            <Route path="/trace" element={<TracePage />} />
            <Route path="/trace/:turnId" element={<TraceDetailPage />} />
            <Route path="/tasks" element={<TasksPage send={send} />} />

            <Route path="/documents" element={<Navigate to="/knowledge" replace />} />
            <Route path="/external/:appId" element={<ExternalServicePage />} />

            {/* Configuration moved into the Settings modal. These redirects
                keep existing deep links and bookmarks resolving. */}
            <Route path="/models" element={<Navigate to={settingsPath("models")} replace />} />
            <Route path="/mcp" element={<Navigate to={settingsPath("mcp")} replace />} />
            <Route path="/skills" element={<Navigate to={settingsPath("skills")} replace />} />
            <Route path="/extensions" element={<Navigate to={settingsPath("mcp")} replace />} />
            <Route path="/extensions/mcp" element={<Navigate to={settingsPath("mcp")} replace />} />
            <Route
              path="/extensions/skills"
              element={<Navigate to={settingsPath("skills")} replace />}
            />
            <Route path="/dashboard" element={<Navigate to={settingsPath("status")} replace />} />

            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </Suspense>
        <ToastHost />
      </div>

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
          <Route
            path="/settings/:section"
            element={<SettingsDialog backgroundPath={backgroundPath} />}
          />
        </Routes>
      )}
    </div>
  );
}
