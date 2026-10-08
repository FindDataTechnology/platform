// ProviderForm — Add/Edit dialog for an LLM provider.
//
// Fields: name, baseUrl, apiKey. On Edit, the apiKey input is left blank and
// acts as "keep current" (the existing key is never sent back); a non-empty
// value replaces it. Save is disabled until name + baseUrl are valid (and
// apiKey is present on Add). The dialog is a thin wrapper around the shared
// dialog primitive; the parent owns the fetch + error toast.

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

export interface ProviderFormValue {
  name: string;
  baseUrl: string;
  apiKey: string;
  reasoningEfforts: string;
}

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

  useEffect(() => {
    if (open) {
      setName(provider?.name ?? "");
      setBaseUrl(provider?.baseUrl ?? "");
      setApiKey("");
      setEfforts((provider?.reasoningEfforts ?? []).join(", "));
    }
  }, [open, provider]);

  const urlOk = /^https?:\/\/[^\s]+$/i.test(baseUrl.trim());
  const canSave =
    name.trim().length > 0 &&
    name.trim().length <= 60 &&
    urlOk &&
    (isEdit || apiKey.trim().length > 0);

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
            onClick={() => onSubmit({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), reasoningEfforts: efforts.trim() })}
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
