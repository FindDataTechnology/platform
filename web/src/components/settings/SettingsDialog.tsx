// SettingsDialog — the modal that hosts every configuration surface.
//
// Routed, not stateful: `/settings/:section` drives it, so a section is
// deep-linkable, the back button walks section history, and legacy routes can
// redirect into it. App.tsx renders this as a sibling of <Routes> and keeps the
// underlying view mounted beneath, which is the whole point — you change a
// model and land back in your conversation, scroll position intact.
//
// Dismissal always navigates to the background location rather than calling
// history.back(), so a deep-linked open (no background) lands on /chat instead
// of leaving the app.

import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { DEFAULT_SECTION, SETTINGS_SECTIONS, settingsPath } from "./sections";
import { useAuthStore } from "@/hooks/useAuth";
import { useAppConfig } from "@/hooks/useAppConfig";
import { cn } from "@/lib/utils";

// Focusable descendants, for the focus trap.
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function SettingsDialog({ backgroundPath }: { backgroundPath: string }) {
  const { t } = useTranslation();
  const { section: slug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const panelRef = useRef<HTMLDivElement>(null);
  // The element focused before the modal opened, restored on close.
  const returnFocusRef = useRef<Element | null>(null);
  const auth = useAuthStore();
  const { packMarketplace } = useAppConfig();

  // Auth-on: admin-only sections (branding) are hidden from non-admins, and
  // deep links to them fall through to the first visible section. Auth-off:
  // every section shows (the server routes are open then too). The group
  // names are deployment-configured (ADMIN_GROUPS; e.g. a Logto org role
  // named platform-admin), reported by /api/auth/me.
  // Pack sections additionally require the gateway-fronted deployment flag
  // (design D15): local deployments never show pack UI.
  const authOn = auth.mode !== null && auth.mode !== "none";
  const adminGroups = auth.adminGroups ?? ["admin"];
  const isAdmin = Boolean(auth.groups?.some?.((g) => adminGroups.includes(g)));
  const sections = useMemo(
    () =>
      SETTINGS_SECTIONS.filter(
        (s) => (!s.adminOnly || !authOn || isAdmin) && (!s.requiresPackMarketplace || packMarketplace),
      ),
    [authOn, isAdmin, packMarketplace],
  );
  // The registry always contains at least the General section, so the chain
  // resolves; the bang keeps TS from narrowing through two runtime fallbacks.
  const active = useMemo(
    () =>
      sections.find((s) => s.slug === slug) ??
      sections.find((s) => s.slug === DEFAULT_SECTION) ??
      sections[0]!,
    [sections, slug],
  );

  const close = useCallback(() => {
    navigate(backgroundPath, { replace: true });
  }, [navigate, backgroundPath]);

  // Normalize an unknown or missing slug to the canonical URL, so the address
  // bar never shows a section that is not the one being rendered.
  useEffect(() => {
    if (slug !== active.slug) {
      navigate(settingsPath(active.slug), {
        replace: true,
        state: location.state,
      });
    }
  }, [slug, active.slug, navigate, location.state]);

  // Capture the trigger, move focus into the panel, restore on unmount.
  // Focus the ACTIVE section rather than the first focusable element — on a
  // deep link to /settings/mcp the first element is the General button, which
  // would leave a focus ring on General while MCP is the selected pane.
  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    const target =
      panelRef.current?.querySelector<HTMLElement>('[data-active="true"]') ??
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      (returnFocusRef.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  // Escape closes; Tab cycles within the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  const Section = active.Component;

  return (
    <div className="fixed inset-0 z-50" data-testid="settings-dialog">
      {/* Backdrop and centering wrapper are ONE element. As two, the centering
          wrapper sat on top and swallowed every click meant for the backdrop,
          so clicking outside the panel did nothing. */}
      <div
        className="fixed inset-0 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm"
        data-testid="settings-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("settings.title")}
          data-testid="settings-panel"
          data-section={active.slug}
          className="flex h-[min(85vh,44rem)] w-full max-w-4xl overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        >
          <nav
            className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border p-2"
            data-testid="settings-nav"
          >
            <div className="px-2 pb-2 pt-1 text-sm font-semibold text-foreground">
              {t("settings.title")}
            </div>
            {sections.map((s) => {
              const Icon = s.icon;
              const isActive = s.slug === active.slug;
              return (
                <button
                  key={s.slug}
                  type="button"
                  data-testid={s.testId}
                  data-active={isActive ? "true" : "false"}
                  onClick={() => navigate(settingsPath(s.slug), { state: location.state })}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground",
                    "hover:bg-muted hover:text-foreground",
                    isActive &&
                      "bg-primary-deep text-primary-foreground hover:bg-primary-deep hover:text-primary-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {t(s.labelKey)}
                </button>
              );
            })}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 justify-end border-b border-border p-2">
              <button
                type="button"
                onClick={close}
                data-testid="settings-close"
                aria-label={t("common.close")}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="settings-content">
              <Suspense
                fallback={
                  <div className="p-6 text-sm text-muted-foreground">{t("common.loading")}</div>
                }
              >
                <Section {...(active.props ?? {})} />
              </Suspense>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
