// Settings → Workbench layout (openspec: layout-configuration). The admin face
// for the deployment layer: choose the deployment default preset, assign a
// preset per business role, and toggle per-surface terminal hiding.
//
// The slug lists come from the shared registry (packages/core) so the editor
// can never offer a surface the resolver does not know. Saves are partial
// patches onto the stored document; the server validates whole-write-or-nothing.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Lock } from "lucide-react";
import {
  AGENTS_TAB_SURFACES,
  BUSINESS_ROLES,
  NAV_SURFACES,
  SETTINGS_SURFACES,
} from "@platform/core";

import { cn } from "@/lib/utils";

interface LayoutConfig {
  defaultPreset: string | null;
  rolePresets: Record<string, string>;
  hidden: string[];
}

const FACTORY_PRESETS = ["standard-snapshot", "simple"] as const;

const selectCls =
  "rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none";

// Surface label keys, client-side (labels are presentation; the registry
// carries slug + i18n key and the nav labels already exist under `nav.*`).
const NAV_LABEL_KEYS: Record<string, string> = {
  chat: "nav.chat",
  knowledge: "nav.knowledge",
  resources: "nav.resources",
  agents: "nav.agents",
  apps: "nav.apps",
  tasks: "nav.tasks",
  fleet: "nav.fleet",
  blueprints: "nav.blueprints",
};

export function LayoutSection() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<LayoutConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/layout/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConfig(await res.json());
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(async (body: Partial<LayoutConfig>) => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/layout/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setConfig(data);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  }, []);

  const hidden = useMemo(() => new Set(config?.hidden ?? []), [config]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="layout-section">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("settings.layout.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="layout-section">
      <p className="text-sm text-muted-foreground">{t("settings.layout.intro")}</p>
      {error ? (
        <p className="text-sm text-destructive" data-testid="layout-error">
          {error}
        </p>
      ) : null}

      {/* Deployment default preset */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="layout-default-preset">
          {t("settings.layout.defaultPreset")}
        </label>
        <select
          id="layout-default-preset"
          className={selectCls}
          data-testid="layout-default-preset"
          value={config?.defaultPreset ?? "standard-snapshot"}
          disabled={saving}
          onChange={(e) => void patch({ defaultPreset: e.target.value })}
        >
          {FACTORY_PRESETS.map((slug) => (
            <option key={slug} value={slug}>
              {t(`settings.layout.presets.${slug}`)}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{t("settings.layout.defaultPresetHint")}</p>
      </div>

      {/* Per-role preset */}
      <div className="space-y-2">
        <div className="text-sm font-medium text-foreground">{t("settings.layout.rolePresets")}</div>
        <p className="text-xs text-muted-foreground">{t("settings.layout.rolePresetsHint")}</p>
        <div className="divide-y divide-border rounded-md border border-border">
          {BUSINESS_ROLES.map((role) => (
            <div key={role} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-32 flex-1 text-sm text-foreground">{t(`roles.slug.${role}`)}</span>
              <select
                className={selectCls}
                data-testid={`layout-role-preset-${role}`}
                value={config?.rolePresets?.[role] ?? ""}
                disabled={saving}
                onChange={(e) => {
                  const next = { ...(config?.rolePresets ?? {}) };
                  if (e.target.value) next[role] = e.target.value;
                  else delete next[role];
                  void patch({ rolePresets: next });
                }}
              >
                <option value="">{t("settings.layout.roleInherit")}</option>
                {FACTORY_PRESETS.map((slug) => (
                  <option key={slug} value={slug}>
                    {t(`settings.layout.presets.${slug}`)}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* Terminal hiding */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Lock className="h-3.5 w-3.5" />
          {t("settings.layout.hiddenSurfaces")}
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.layout.hiddenSurfacesHint")}</p>
        <div className="space-y-3">
          {[
            { title: t("settings.layout.groupNav"), surfaces: NAV_SURFACES, labelKeys: NAV_LABEL_KEYS },
            { title: t("settings.layout.groupSettings"), surfaces: SETTINGS_SURFACES, labelKeys: null },
            { title: t("settings.layout.groupAgentsTabs"), surfaces: AGENTS_TAB_SURFACES, labelKeys: null },
          ].map((group) => (
            <div key={group.title}>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
                {group.title}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.surfaces
                  // The layout section cannot hide itself — that would strand
                  // the operator with no way back.
                  .filter((s) => s.slug !== "layout")
                  .map((s) => {
                    const isHidden = hidden.has(s.slug);
                    const label = group.labelKeys
                      ? t(group.labelKeys[s.slug] ?? s.i18nKey)
                      : s.container === "settings"
                        ? t(`settings.sections.${s.slug}`)
                        : t(`roles.slug.${s.slug}`, { defaultValue: s.slug });
                    return (
                      <button
                        key={s.slug}
                        type="button"
                        aria-pressed={isHidden}
                        disabled={saving}
                        data-testid={`layout-hide-${s.slug}`}
                        onClick={() => {
                          const next = new Set(config?.hidden ?? []);
                          if (isHidden) next.delete(s.slug);
                          else next.add(s.slug);
                          void patch({ hidden: [...next] });
                        }}
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-xs",
                          isHidden
                            ? "border-destructive/60 bg-destructive/10 text-destructive"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
