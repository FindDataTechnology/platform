// Workbench customization (openspec: layout-configuration). The user's own
// face for the layout: toggle visibility and reorder the surfaces they can
// actually affect — everything the deployment and role layers left visible.
//
// The panel NEVER offers a surface hidden above them (that would be a lie: the
// resolver would not honor it). It asks the server for the current resolved
// layout, edits a copy, and PUTs the result; the restore control clears the
// stored adjustments.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Loader2, RotateCcw } from "lucide-react";
import { registryFor, type SurfaceContainer } from "@platform/core";
import { useAppConfig, loadAppConfig } from "@/hooks/useAppConfig";
import { cn } from "@/lib/utils";

interface Props {
  onClose: () => void;
}

// The label for one surface: nav labels already exist (nav.*); settings
// sections under settings.sections.*; agents tabs under agentsPage.*.
function labelKeyFor(container: SurfaceContainer, slug: string, i18nKey: string): string {
  if (container === "nav") return `nav.${slug}` === i18nKey ? i18nKey : i18nKey;
  if (container === "settings") return `settings.sections.${slug}`;
  return i18nKey;
}

export function WorkbenchPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const { resolvedLayout } = useAppConfig();
  // The editable copy: container → ordered slugs the user currently has.
  const [draft, setDraft] = useState<Record<SurfaceContainer, string[]> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (resolvedLayout) {
      setDraft({ nav: [...resolvedLayout.nav], settings: [...resolvedLayout.settings], agentsTabs: [...resolvedLayout.agentsTabs] });
    }
  }, [resolvedLayout]);

  const containers: { container: SurfaceContainer; titleKey: string }[] = useMemo(
    () => [
      { container: "nav", titleKey: "settings.layout.groupNav" },
      { container: "agentsTabs", titleKey: "settings.layout.groupAgentsTabs" },
    ],
    [],
  );

  const save = useCallback(
    async (next: Record<string, string[]>) => {
      setSaving(true);
      setError("");
      try {
        const res = await fetch("/api/layout/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tweaks: next }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        // Pull the fresh resolution so the UI (and the sidebar behind it)
        // reflects the saved answer immediately.
        await loadAppConfig(0);
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err));
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const restore = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/layout/preferences", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadAppConfig(0);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  }, []);

  const move = (container: SurfaceContainer, slug: string, delta: number) => {
    if (!draft) return;
    const list = [...draft[container]];
    const i = list.indexOf(slug);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    const next = { ...draft, [container]: list };
    setDraft(next);
    void save(next);
  };

  if (!draft) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground" data-testid="workbench-panel">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("settings.layout.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4" data-testid="workbench-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{t("settings.layout.workbenchTitle")}</h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          data-testid="workbench-close"
        >
          {t("common.close", { defaultValue: "Close" })}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{t("settings.layout.workbenchHint")}</p>
      {error ? (
        <p className="text-sm text-destructive" data-testid="workbench-error">
          {error}
        </p>
      ) : null}

      {containers.map(({ container, titleKey }) => {
        const list = draft[container];
        if (!list.length) return null;
        const byRegistry = new Map(registryFor(container).map((e) => [e.slug, e]));
        return (
          <div key={container}>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">{t(titleKey)}</div>
            <div className="space-y-1">
              {list.map((slug, index) => {
                const entry = byRegistry.get(slug);
                if (!entry) return null;
                return (
                  <div
                    key={slug}
                    className={cn("flex items-center gap-2 rounded-md border border-border px-2 py-1.5", saving && "opacity-70")}
                    data-testid={`workbench-row-${slug}`}
                  >
                    <span className="flex-1 text-sm text-foreground">{t(labelKeyFor(container, slug, entry.i18nKey), { defaultValue: slug })}</span>
                    <button
                      type="button"
                      disabled={saving || index === 0}
                      aria-label={t("settings.layout.moveUp")}
                      onClick={() => move(container, slug, -1)}
                      className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                      data-testid={`workbench-up-${slug}`}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={saving || index === list.length - 1}
                      aria-label={t("settings.layout.moveDown")}
                      onClick={() => move(container, slug, 1)}
                      className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                      data-testid={`workbench-down-${slug}`}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      aria-pressed={false}
                      onClick={() => {
                        const next = { ...draft, [container]: list.filter((s) => s !== slug) };
                        setDraft(next);
                        void save(next);
                      }}
                      className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-destructive"
                      data-testid={`workbench-hide-${slug}`}
                    >
                      {t("settings.layout.hide")}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => void restore()}
        disabled={saving}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        data-testid="workbench-restore"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {t("settings.layout.restore")}
      </button>
      {/* Only surfaces the layers above left visible are offered — that is the
          terminality contract made visible, per layout-configuration. */}
    </div>
  );
}
