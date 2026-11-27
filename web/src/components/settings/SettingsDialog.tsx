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

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { DEFAULT_SECTION, SETTINGS_SECTIONS, propsForSlug, sectionMatchesSlug, settingsPath, type SettingsGroup } from "./sections";
import { useAppConfig } from "@/hooks/useAppConfig";
import { useAuthStore } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

// Focusable descendants, for the focus trap — the SHARED contract from
// ui/dialog (the trap itself stays bespoke: it yields to nested dialogs and
// focuses the active section, neither of which ui/dialog does).
import { FOCUSABLE_SELECTOR as FOCUSABLE } from "@/components/ui/dialog";

export function SettingsDialog({ backgroundPath }: { backgroundPath: string }) {
  const { t } = useTranslation();
  const { section: slug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const panelRef = useRef<HTMLDivElement>(null);
  // The element focused before the modal opened, restored on close.
  const returnFocusRef = useRef<Element | null>(null);
  const auth = useAuthStore();
  const appConfig = useAppConfig();

  // Auth-on: admin-only sections (branding, user roles) are hidden from
  // non-admins, and deep links to them fall through to the first visible
  // section. Auth-off: every section shows (the server routes are open then
  // too). The composed answer comes from the server (`isAdmin`, which folds in
  // the stored role flag alongside ADMIN_GROUPS); the local group check is the
  // fallback for older servers that do not report the field.
  const authOn = auth.mode !== null && auth.mode !== "none";
  const adminGroups = auth.adminGroups ?? ["admin"];
  const isAdmin =
    auth.isAdmin ?? Boolean(auth.groups?.some?.((g) => adminGroups.includes(g)));
  // The section list the server resolved (layout-configuration) is the
  // primary filter — it already folded in the deployment/role/user layers and
  // the admin + marketplace facts. Without it (older server) the local
  // adminOnly check stands, unchanged from before.
  const sections = useMemo(() => {
    const resolved = appConfig.resolvedLayout?.settings;
    if (!resolved) return SETTINGS_SECTIONS.filter((s) => !s.adminOnly || !authOn || isAdmin);
    const bySlug = new Map(SETTINGS_SECTIONS.map((s) => [s.slug, s]));
    return resolved
      .map((slug) => bySlug.get(slug))
      .filter((s): s is (typeof SETTINGS_SECTIONS)[number] => Boolean(s));
  }, [appConfig.resolvedLayout, authOn, isAdmin]);
  // Filter the RESOLVED list only — search must never widen what the layout
  // decided (a hidden section cannot be found by typing its name). Labels are
  // matched in the active locale, which is what the user is reading.
  const [query, setQuery] = useState("");
  const visibleSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter((s) => t(s.labelKey).toLowerCase().includes(q));
  }, [sections, query, t]);
  // Group membership is the source of the headings: render each group
  // contiguously, heading once. (Deriving headings from "group changed since
  // the previous array entry" broke the moment two groups interleaved.)
  const groupedSections = useMemo(() => {
    const out: { group: SettingsGroup; items: typeof sections }[] = [];
    for (const section of visibleSections) {
      const last = out[out.length - 1];
      if (last && last.group === section.group) last.items.push(section);
      else out.push({ group: section.group, items: [section] });
    }
    return out;
  }, [visibleSections]);
  // The registry always contains at least the General section, so the chain
  // resolves; the bang keeps TS from narrowing through two runtime fallbacks.
  // Alias slugs (the merged Tools & Skills section) match their section too.
  const active = useMemo(
    () =>
      sections.find((s) => sectionMatchesSlug(s, slug)) ??
      sections.find((s) => s.slug === DEFAULT_SECTION) ??
      sections[0]!,
    [sections, slug],
  );
  // The sub-view props follow the slug used: opening via the `skills` alias
  // lands on the skills view of the merged section.
  const activeProps = propsForSlug(active, slug);

  const close = useCallback(() => {
    navigate(backgroundPath, { replace: true });
  }, [navigate, backgroundPath]);

  // Normalize an unknown or missing slug to the canonical URL, so the address
  // bar never shows a section that is not the one being rendered. Alias slugs
  // stay in the address bar — each alias carries its own sub-view state, and
  // normalizing it away would lose that on reload.
  useEffect(() => {
    if (!sectionMatchesSlug(active, slug)) {
      navigate(settingsPath(active.slug), {
        replace: true,
        state: location.state,
      });
    }
  }, [slug, active, navigate, location.state]);

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

  // Escape closes; Tab cycles within the panel. When a nested dialog is open
  // inside a section pane (e.g. the channels section's add-bot dialog), it
  // owns Escape and focus — Radix layers dismiss topmost-first, and the
  // modal-level trap must not fight it or close the whole modal out from
  // under the nested dialog. Radix portals dialogs to document.body, so the
  // lookup is document-wide; this panel itself carries no data-state, so it
  // can never match.
  useEffect(() => {
    const nestedDialogOpen = () =>
      Boolean(document.querySelector('[role="dialog"][data-state="open"]'));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (nestedDialogOpen()) return;
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      if (nestedDialogOpen()) return;
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
            className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2"
            data-testid="settings-nav"
          >
            <div className="px-2 pb-2 pt-1 text-sm font-semibold text-foreground">
              {t("settings.title")}
            </div>
            {/* 节内搜索 (restructure-yizuo-ia): two hard rules — it filters the
                already-resolved list (never re-reveals a hidden section), and an
                empty result states so instead of rendering a blank rail. */}
            <div className="px-1 pb-1">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("settings.searchPlaceholder")}
                aria-label={t("settings.searchPlaceholder")}
                data-testid="settings-search"
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
              />
            </div>
            {visibleSections.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground" data-testid="settings-search-empty">
                {t("settings.searchEmpty")}
              </p>
            ) : null}
            {groupedSections.map((group) => (
              <div key={`group-${group.group}`} className="flex flex-col gap-0.5">
                <div
                  className="micro-label px-2 pb-1 pt-2 font-semibold text-muted-foreground/70 first:pt-1"
                  data-testid={`settings-group-${group.group}`}
                >
                  {t(`settings.groups.${group.group}`)}
                </div>
                {group.items.map((s) => {
                  const Icon = s.icon;
                  const isActive = sectionMatchesSlug(s, slug);
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
              </div>
            ))}
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
                <Section {...(activeProps ?? {})} />
              </Suspense>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
