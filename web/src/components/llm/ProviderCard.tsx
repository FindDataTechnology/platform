// ProviderCard — one LLM provider on the Models page: name, type, truncated
// base URL, hasKey indicator, last-test status, discovered models, and the
// Edit / Test / Delete actions. The reserved env route (Volces) is the
// deployment's built-in lane: since add-editable-llm-route admins can edit
// its roster (persisted override) and override its base URL, but never its
// key (env-owned) and it cannot be deleted.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2, Lock, Unlock, Globe, ListPlus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TestConnectionButton } from "./TestConnectionButton";
import { SyncModelsButton } from "./SyncModelsButton";
import { ModelList, relativeTime } from "./ModelList";
import { ModelListEditor } from "./ModelListEditor";
import { updateProvider, clearOverride, type LlmProvider } from "@platform/core";

// 探测年龄摘要（ciyuan-roster-refresh：探测年龄 MUST 可见）。
// 用**最新**的 probedAt 当「上次探测」：它一旦早于 7 天，说明整批判定都已经过期
// （部分条目更旧的情形由逐条徽标的 tooltip 承担）。从未探测时给 null，别写成「0 天前」。
const STALE_AFTER_MS = 7 * 24 * 3600 * 1000;
function discoverySummary(discovery: LlmProvider["discovery"]) {
  const entries = Object.values(discovery ?? {});
  if (entries.length === 0) return null;
  const times = entries
    .map((e) => Date.parse(String(e?.probedAt ?? "")))
    .filter((t) => Number.isFinite(t));
  const newest = times.length ? Math.max(...times) : null;
  return {
    total: entries.length,
    unavailable: entries.filter((e) => e?.status !== "serving").length,
    newest,
    stale: newest !== null && Date.now() - newest > STALE_AFTER_MS,
  };
}

interface Props {
  provider: LlmProvider;
  isAdmin: boolean;
  onEdit: (p: LlmProvider) => void;
  onDelete: (p: LlmProvider) => void;
  onModelsChanged: () => void;
}

export function ProviderCard({ provider, isAdmin, onEdit, onDelete, onModelsChanged }: Props) {
  const { t } = useTranslation();
  const disc = discoverySummary(provider.discovery);
  const reserved = Boolean(provider.reserved);
  const [editingModels, setEditingModels] = useState(false);
  const [overrideUrl, setOverrideUrl] = useState(provider.override?.baseUrl ?? "");
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const saveOverrideUrl = async () => {
    const url = overrideUrl.trim();
    if (!url) return;
    setOverrideBusy(true);
    setOverrideError(null);
    try {
      await updateProvider(provider.id, { baseUrl: url });
      onModelsChanged();
    } catch (e) {
      setOverrideError((e as Error).message);
    } finally {
      setOverrideBusy(false);
    }
  };

  const clearRouteOverride = async () => {
    setOverrideBusy(true);
    setOverrideError(null);
    try {
      await clearOverride(provider.id);
      setOverrideUrl("");
      onModelsChanged();
    } catch (e) {
      setOverrideError((e as Error).message);
    } finally {
      setOverrideBusy(false);
    }
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5"
      data-testid="llm-provider-card"
      data-provider-id={provider.id}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">{provider.name}</h3>
            {reserved && (
              <span className="micro-label rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                {t("modelsPage.builtIn")}
              </span>
            )}
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              title={provider.hasKey ? t("modelsPage.keyPresent") : t("modelsPage.keyMissing")}
            >
              {provider.hasKey ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
            </span>
            {reserved && provider.override?.active && (
              <span
                className="micro-label rounded bg-warning/15 px-1.5 py-0.5 text-warning"
                data-testid="llm-override-active"
              >
                {t("modelsPage.overrideActive")}
              </span>
            )}
          </div>
          <p className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
            <Globe className="h-3 w-3 shrink-0" />
            <span className="truncate" title={provider.baseUrl}>{provider.baseUrl}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isAdmin && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t("modelsPage.editModels")}
              aria-pressed={editingModels}
              onClick={() => setEditingModels((v) => !v)}
              data-testid="llm-edit-models-btn"
            >
              <ListPlus className="h-4 w-4" />
            </Button>
          )}
          {/* Read-only roster for non-admins: no management controls at all —
              no add/edit/delete/test/sync (simplify-ia-non-technical). */}
          {isAdmin && !reserved && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={t("modelsPage.editProvider")}
                onClick={() => onEdit(provider)}
                data-testid="llm-edit-btn"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                aria-label={t("modelsPage.deleteProvider")}
                onClick={() => onDelete(provider)}
                data-testid="llm-delete-btn"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        {isAdmin && !reserved && (
          <TestConnectionButton providerId={provider.id} lastTest={provider.lastTest} />
        )}
        {provider.lastTest?.at && (
          <span className="text-xs text-muted-foreground">
            {relativeTime(provider.lastTest.at)}
          </span>
        )}
        {isAdmin && (
          <SyncModelsButton
            providerId={provider.id}
            onDone={onModelsChanged}
          />
        )}
        {disc && (
          <span
            className={disc.stale ? "text-xs text-warning" : "text-xs text-muted-foreground"}
            data-testid="llm-discovery-age"
            data-stale={disc.stale ? "true" : "false"}
            data-unavailable={disc.unavailable}
            title={
              disc.stale
                ? t("modelsPage.discoveryStaleHint", "判定会过期：超过 7 天的状态不代表现在还能调用")
                : undefined
            }
          >
            {disc.newest === null
              ? t("modelsPage.discoveryNever", "从未探测")
              : `${t("modelsPage.discoveryAge", "上次探测")} ${relativeTime(new Date(disc.newest).toISOString())}`}
            {disc.unavailable > 0 &&
              ` · ${disc.unavailable}/${disc.total} ${t("modelsPage.discoveryUnavailable", "不可用")}`}
            {disc.stale && ` · ${t("modelsPage.discoveryStale", "可能已过期")}`}
          </span>
        )}
      </div>

      {reserved && isAdmin && (
        <div className="flex flex-col gap-1" data-testid="llm-override-bar">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
              placeholder={t("modelsPage.overrideBaseUrlPlaceholder")}
              aria-label={t("modelsPage.overrideBaseUrlPlaceholder")}
              value={overrideUrl}
              onChange={(e) => setOverrideUrl(e.target.value)}
              data-testid="llm-override-input"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={saveOverrideUrl}
              disabled={overrideBusy || !overrideUrl.trim()}
              data-testid="llm-override-save"
            >
              {t("modelsPage.overrideSave")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={clearRouteOverride}
              disabled={overrideBusy || !provider.override?.active}
              aria-label={t("modelsPage.overrideClear")}
              data-testid="llm-override-clear"
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              {t("modelsPage.overrideClear")}
            </Button>
          </div>
          {overrideError && <p className="text-xs text-destructive" data-testid="llm-override-error">{overrideError}</p>}
        </div>
      )}

      {editingModels && isAdmin ? (
        <ModelListEditor
          providerId={provider.id}
          models={provider.models}
          modelMeta={provider.modelMeta}
          onSaved={() => {
            setEditingModels(false);
            onModelsChanged();
          }}
        />
      ) : (
        <ModelList
          providerId={provider.id}
          models={provider.models}
          discovery={provider.discovery}
          onChanged={onModelsChanged}
        />
      )}
    </section>
  );
}
