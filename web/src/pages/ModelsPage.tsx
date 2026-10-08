// ModelsPage — first-class /models surface for LLM provider management.
//
// Lists configured providers (env Volces + user-added), supports Add / Edit /
// Delete with a confirmation dialog, tests live connections, and sets the
// default model. Provider writes hot-reload dsh (settings.yaml +
// .credentials.yaml are Chokidar-watched), so a successful save shows a
// "settings updated" toast and refetches; the WS `models` event refreshes the
// sidebar model chip. API keys never reach the client (hasKey only).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ProviderCard } from "@/components/llm/ProviderCard";
import { ProviderForm, type ProviderFormValue } from "@/components/llm/ProviderForm";
import { showToast } from "@/components/Toast";
import { useAuthStore } from "@/hooks/useAuth";
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  getDefault,
  type LlmProvider,
} from "@platform/core";

type FormState =
  | { mode: "closed" }
  | { mode: "add" }
  | { mode: "edit"; provider: LlmProvider };

export function ModelsPage() {
  const { t } = useTranslation();
  // Admin-only actions (sync, model-list editing) mirror the server gate:
  // hidden for non-admins when auth is on, shown to everyone when auth is off
  // (the machine owner — the same semantics as ctx.requireAdmin).
  const auth = useAuthStore();
  const authOn = auth.mode !== null && auth.mode !== "none";
  const adminGroups = auth.adminGroups ?? ["admin"];
  const isAdmin = !authOn || Boolean(auth.groups?.some?.((g) => adminGroups.includes(g)));
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [form, setForm] = useState<FormState>({ mode: "closed" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<LlmProvider | null>(null);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, def] = await Promise.all([listProviders(), getDefault()]);
      setProviders(list);
      setDefaultModelId(def.modelId);
    } catch (e) {
      showToast((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openAdd = () => {
    setFormError(null);
    setForm({ mode: "add" });
  };

  const openEdit = (p: LlmProvider) => {
    setFormError(null);
    setForm({ mode: "edit", provider: p });
  };

  const closeForm = () => {
    if (!saving) setForm({ mode: "closed" });
  };

  const submitForm = async (value: ProviderFormValue) => {
    setSaving(true);
    setFormError(null);
    try {
      if (form.mode === "add") {
        await createProvider(value);
      } else if (form.mode === "edit") {
        // Omit apiKey when blank → "keep current" on the server.
        const payload: ProviderFormValue = { ...value };
        if (!payload.apiKey) delete (payload as { apiKey?: string }).apiKey;
        await updateProvider(form.provider.id, payload);
      }
      setForm({ mode: "closed" });
      showToast(t("modelsPage.settingsUpdated"));
      await refresh();
    } catch (e) {
      const msg = (e as Error).message;
      setFormError(msg);
      if ((e as { status?: number }).status === 409 && msg.includes("another edit")) {
        showToast(t("modelsPage.anotherEditInProgress"));
      }
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      await deleteProvider(toDelete.id);
      setToDelete(null);
      showToast(t("modelsPage.settingsUpdated"));
      await refresh();
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const currentDefaultName = (() => {
    for (const p of providers) {
      const m = p.models.find((id) => id === defaultModelId);
      if (m) return `${p.name} · ${m}`;
    }
    return defaultModelId;
  })();

  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      data-testid="models-page"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{t("modelsPage.title")}</h1>
            {currentDefaultName && (
              <p className="mt-1 text-sm text-muted-foreground">
                {t("modelsPage.defaultLabel")}: <span className="font-medium text-foreground">{currentDefaultName}</span>
              </p>
            )}
          </div>
          <Button onClick={openAdd} data-testid="llm-add-provider">
            <Plus className="mr-1 h-4 w-4" />
            {t("modelsPage.addProvider")}
          </Button>
        </header>

        {providers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            {t("modelsPage.empty")}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {providers.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                isAdmin={isAdmin}
                onEdit={openEdit}
                onDelete={setToDelete}
                onModelsChanged={refresh}
              />
            ))}
          </div>
        )}
      </div>

      <ProviderForm
        open={form.mode !== "closed"}
        provider={form.mode === "edit" ? form.provider : null}
        saving={saving}
        error={formError}
        onClose={closeForm}
        onSubmit={submitForm}
      />

      {/* Delete confirmation */}
      <Dialog open={Boolean(toDelete)} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("modelsPage.confirmDeleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("modelsPage.confirmDelete", { name: toDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>
              {t("modelsPage.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              data-testid="llm-delete-confirm"
            >
              {t("modelsPage.deleteProvider")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
