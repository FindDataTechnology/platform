// ProviderForm — Add/Edit dialog for an LLM provider.
//
// Fields: name, baseUrl, apiKey, plus LOCAL MODEL presets
// (add-local-model-lane): Ollama / LM Studio fill the URL and switch auth to
// "none" — no key needed for local model servers. On Edit, the apiKey input is
// left blank and acts as "keep current" (the existing key is never sent back);
// a non-empty value replaces it. Save is disabled until name + baseUrl are
// valid (and apiKey is present on Add for bearer providers). The dialog is a
// thin wrapper around the shared dialog primitive; the parent owns the fetch +
// error toast.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { LlmProvider } from "@platform/core";

export type ProviderAuth = "bearer" | "none";

export interface ProviderFormValue {
  name: string;
  baseUrl: string;
  apiKey: string;
  reasoningEfforts: string;
  auth: ProviderAuth;
}

// The local model presets (add-local-model-lane): one click fills the URL,
// switches auth to "none", and the key field stops being required.
export const LOCAL_PRESETS: { id: string; label: string; baseUrl: string }[] = [
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
];

interface Props {
  open: boolean;
  // When set, the form edits this provider; otherwise it creates one.
  provider?: LlmProvider | null;
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (value: ProviderFormValue) => void;
}

export function ProviderForm({ open, provider, saving, error, onClose, onSubmit }: Props) {
  const { t } = useTranslation();
  const isEdit = Boolean(provider);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [efforts, setEfforts] = useState("");
  const [auth, setAuth] = useState<ProviderAuth>("bearer");

  useEffect(() => {
    if (open) {
      setName(provider?.name ?? "");
      setBaseUrl(provider?.baseUrl ?? "");
      setApiKey("");
      setEfforts((provider?.reasoningEfforts ?? []).join(", "));
      setAuth(provider ? (provider.auth === "none" ? "none" : "bearer") : "bearer");
    }
  }, [open, provider]);

  const applyPreset = (id: string) => {
    const preset = LOCAL_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setBaseUrl(preset.baseUrl);
    setAuth("none");
  };

  const urlOk = /^https?:\/\/[^\s]+$/i.test(baseUrl.trim());
  const canSave =
    name.trim().length > 0 &&
    name.trim().length <= 60 &&
    urlOk &&
    (isEdit || auth === "none" || apiKey.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("modelsPage.editProvider") : t("modelsPage.addProvider")}
          </DialogTitle>
          <DialogDescription>
            {isEdit ? t("modelsPage.editHint") : t("modelsPage.addHint")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {!isEdit && (
            <div className="flex flex-wrap items-center gap-2" data-testid="llm-local-presets">
              <span className="text-xs font-medium text-muted-foreground">
                {t("modelsPage.localPresets")}
              </span>
              {LOCAL_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p.id)}
                  data-testid={`llm-preset-${p.id}`}
                  className="rounded-full border border-border px-3 py-1 text-xs hover:bg-muted"
                >
                  {p.label}
                </button>
              ))}
              {auth === "none" && (
                <span className="text-xs text-muted-foreground">{t("modelsPage.localAuthHint")}</span>
              )}
            </div>
          )}
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">{t("modelsPage.fieldName")}</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Provider"
              data-testid="llm-provider-name"
              maxLength={60}
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">{t("modelsPage.fieldBaseUrl")}</span>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              data-testid="llm-provider-baseurl"
              spellCheck={false}
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">{t("modelsPage.fieldApiKey")}</span>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isEdit ? t("modelsPage.keyPlaceholder") : t("modelsPage.apiKeyRequired")}
              data-testid="llm-provider-apikey"
              autoComplete="off"
              spellCheck={false}
            />
            {auth === "none" && (
              <span className="text-xs text-muted-foreground">{t("modelsPage.keyNotNeeded")}</span>
            )}
            {isEdit && (
              <span className="text-xs text-muted-foreground">
                {t("modelsPage.keyMasked")}
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">{t("modelsPage.fieldEfforts")}</span>
            <Input
              value={efforts}
              onChange={(e) => setEfforts(e.target.value)}
              placeholder="low, medium, high"
              data-testid="llm-provider-efforts"
              spellCheck={false}
            />
            <span className="text-xs text-muted-foreground">{t("modelsPage.effortsHint")}</span>
          </label>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("modelsPage.cancel")}
          </Button>
          <Button
            onClick={() =>
              onSubmit({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), reasoningEfforts: efforts.trim(), auth })
            }
            disabled={!canSave || saving}
            data-testid="llm-provider-save"
          >
            {saving ? t("modelsPage.saving") : t("modelsPage.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
