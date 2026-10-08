// ModelListEditor — admin-only runtime roster editing (add-llm-model-discovery;
// contextWindow input added in add-editable-llm-route). Rows of the
// provider's current models with remove buttons, an add-id input whose
// metadata is pre-filled from the client family table (editable
// contextWindow/maxTokens), and a Save that PUTs the whole `models` array —
// the same hot-reload path as every provider edit, so the chat picker updates
// without a restart. Works for the reserved env route too (persisted
// override).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { showToast } from "@/components/Toast";
import { updateProvider, clientModelFamilyMeta, type ModelEntryInput } from "@platform/core";

interface Props {
  providerId: string;
  models: string[];
  onSaved: () => void;
}

interface Row extends ModelEntryInput {}

export function ModelListEditor({ providerId, models, onSaved }: Props) {
  const { t } = useTranslation();
  // Seed rows from the current roster; contextWindow/maxTokens fall back to
  // the family table server-side, so the client only sends explicit values.
  const [rows, setRows] = useState<Row[]>(
    models.map((id) => {
      const meta = clientModelFamilyMeta(id);
      return { id, contextWindow: meta.contextWindow, maxTokens: meta.maxTokens };
    }),
  );
  const [newId, setNewId] = useState("");
  const [newContextWindow, setNewContextWindow] = useState<string>("");
  const [newMaxTokens, setNewMaxTokens] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const id = newId.trim();
    if (!id) return;
    if (rows.some((r) => r.id === id)) {
      setError(t("modelsPage.duplicateModelId"));
      return;
    }
    const meta = clientModelFamilyMeta(id);
    setRows((rs) => [
      ...rs,
      {
        id,
        contextWindow: newContextWindow ? Number(newContextWindow) : meta.contextWindow,
        maxTokens: newMaxTokens ? Number(newMaxTokens) : meta.maxTokens,
      },
    ]);
    setNewId("");
    setNewContextWindow("");
    setNewMaxTokens("");
    setError(null);
  };

  const save = async () => {
    // Re-validate dupes (a paste can bypass the add() check).
    const ids = rows.map((r) => r.id.trim()).filter(Boolean);
    if (new Set(ids).size !== ids.length || ids.length !== rows.length) {
      setError(t("modelsPage.duplicateModelId"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateProvider(providerId, {
        models: rows.map((r) => ({
          id: r.id.trim(),
          ...(r.contextWindow ? { contextWindow: r.contextWindow } : {}),
          ...(r.maxTokens ? { maxTokens: r.maxTokens } : {}),
        })),
      });
      showToast(t("modelsPage.settingsUpdated"));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="llm-model-editor">
      <ul className="flex flex-col gap-1">
        {rows.map((row, i) => (
          <li key={row.id} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={row.id}>
              {row.id}
            </span>
            <label className="sr-only" htmlFor={`context-window-${providerId}-${i}`}>
              {t("modelsPage.contextWindowLabel", { id: row.id })}
            </label>
            <input
              id={`context-window-${providerId}-${i}`}
              type="number"
              min={1}
              className="w-24 rounded-md border border-input bg-background px-2 py-1 text-xs"
              value={row.contextWindow ?? ""}
              onChange={(e) =>
                setRows((rs) =>
                  rs.map((r, j) => (j === i ? { ...r, contextWindow: e.target.value ? Number(e.target.value) : undefined } : r)),
                )
              }
              data-testid="llm-model-context-window"
            />
            <label className="sr-only" htmlFor={`max-tokens-${providerId}-${i}`}>
              {t("modelsPage.maxTokensLabel", { id: row.id })}
            </label>
            <input
              id={`max-tokens-${providerId}-${i}`}
              type="number"
              min={1}
              className="w-24 rounded-md border border-input bg-background px-2 py-1 text-xs"
              value={row.maxTokens ?? ""}
              onChange={(e) =>
                setRows((rs) =>
                  rs.map((r, j) => (j === i ? { ...r, maxTokens: e.target.value ? Number(e.target.value) : undefined } : r)),
                )
              }
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive hover:text-destructive"
              aria-label={t("modelsPage.removeModel", { id: row.id })}
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              data-testid="llm-model-remove"
            >
              <X className="h-3 w-3" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          placeholder={t("modelsPage.addModelPlaceholder")}
          aria-label={t("modelsPage.addModelPlaceholder")}
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          data-testid="llm-model-add-id"
        />
        <input
          className="h-8 w-24 rounded-md border border-input bg-background px-2 text-xs"
          placeholder={t("modelsPage.contextWindowLabelShort")}
          aria-label={t("modelsPage.contextWindowLabelShort")}
          type="number"
          min={1}
          value={newContextWindow}
          onChange={(e) => setNewContextWindow(e.target.value)}
          data-testid="llm-model-add-context-window"
        />
        <input
          className="h-8 w-24 rounded-md border border-input bg-background px-2 text-xs"
          placeholder={t("modelsPage.maxTokensLabelShort")}
          aria-label={t("modelsPage.maxTokensLabelShort")}
          type="number"
          min={1}
          value={newMaxTokens}
          onChange={(e) => setNewMaxTokens(e.target.value)}
          data-testid="llm-model-add-max-tokens"
        />
        {newId.trim() && (
          <span className="text-[10px] text-muted-foreground" data-testid="llm-model-add-prefill">
            {t("modelsPage.prefillHint", {
              context: String(clientModelFamilyMeta(newId.trim()).contextWindow),
              maxTokens: String(clientModelFamilyMeta(newId.trim()).maxTokens),
            })}
          </span>
        )}
        <Button variant="outline" size="sm" className="h-8" onClick={add} disabled={!newId.trim()} data-testid="llm-model-add-btn">
          <Plus className="mr-1 h-3 w-3" />
          {t("modelsPage.addModel")}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive" data-testid="llm-model-editor-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onSaved} disabled={saving}>
          {t("modelsPage.cancel")}
        </Button>
        <Button size="sm" onClick={save} disabled={saving} data-testid="llm-model-save">
          {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          {t("modelsPage.saveModels")}
        </Button>
      </div>
    </div>
  );
}
