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
import { ModelList } from "./ModelList";
import { ModelListEditor } from "./ModelListEditor";
import { updateProvider, clearOverride, type LlmProvider } from "@platform/core";

interface Props {
  provider: LlmProvider;
  isAdmin: boolean;
  onEdit: (p: LlmProvider) => void;
  onDelete: (p: LlmProvider) => void;
  onModelsChanged: () => void;
}

function relativeTime(iso?: string) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}d ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function ProviderCard({ provider, isAdmin, onEdit, onDelete, onModelsChanged }: Props) {
  const { t } = useTranslation();
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
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
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
                className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400"
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
          {!reserved && (
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
        {!reserved && <TestConnectionButton providerId={provider.id} lastTest={provider.lastTest} />}
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
