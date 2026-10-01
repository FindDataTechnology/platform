// Settings → Deployment branding (openspec: add-deployment-branding). Four
// fields, one PUT. Reads the current effective values from GET /api/config
// (stored → env) and saves via PUT /api/config/branding (admin-gated when auth
// is on; the section itself is admin-visible then, see sections.ts).

import { useEffect, useState } from "react";
import { Paintbrush } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppConfig, loadAppConfig } from "@/hooks/useAppConfig";

const FIELDS = [
  { key: "companyName", labelKey: "settings.branding.companyName", hintKey: null },
  { key: "assistantName", labelKey: "settings.branding.assistantName", hintKey: null },
  { key: "brandIconUrl", labelKey: "settings.branding.brandIconUrl", hintKey: "settings.branding.brandIconUrlHint" },
  { key: "loginFooterText", labelKey: "settings.branding.loginFooterText", hintKey: "settings.branding.loginFooterTextHint" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

export function BrandingSection() {
  const { t } = useTranslation();
  const appConfig = useAppConfig();
  const [values, setValues] = useState<Record<FieldKey, string>>({
    companyName: "",
    assistantName: "",
    brandIconUrl: "",
    loginFooterText: "",
  });
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  // Seed the form from the effective config once it resolves.
  useEffect(() => {
    setValues({
      companyName: appConfig.companyName ?? "",
      assistantName: appConfig.assistantName ?? "",
      brandIconUrl: appConfig.brandIconUrl ?? "",
      loginFooterText: appConfig.loginFooterText ?? "",
    });
  }, [appConfig]);

  const save = async () => {
    setStatus("saving");
    setError("");
    try {
      const res = await fetch("/api/config/branding", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      await loadAppConfig(); // refresh effective values without a server restart
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
      setStatus("error");
    }
  };

  return (
    <div className="flex flex-col gap-4 p-6" data-testid="settings-branding">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Paintbrush className="h-4 w-4" aria-hidden="true" />
        {t("settings.branding.title")}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t("settings.branding.hint")}</p>
      {FIELDS.map(({ key, labelKey, hintKey }) => (
        <label key={key} className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">{t(labelKey)}</span>
          <input
            type="text"
            value={values[key]}
            maxLength={200}
            data-testid={`branding-${key}`}
            onChange={(e) => {
              setValues((v) => ({ ...v, [key]: e.target.value }));
              setStatus("idle");
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          />
          {hintKey && <span className="text-xs text-muted-foreground">{t(hintKey)}</span>}
        </label>
      ))}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === "saving"}
          data-testid="branding-save"
          className="w-fit rounded-md bg-primary-deep px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary-deep/90 disabled:opacity-50"
        >
          {status === "saving" ? t("common.saving") : t("common.save")}
        </button>
        {status === "saved" && <span className="text-xs text-muted-foreground">{t("settings.branding.saved")}</span>}
        {status === "error" && (
          <span className="text-xs text-destructive" role="alert">
            {t("settings.branding.saveFailed", { error })}
          </span>
        )}
      </div>
    </div>
  );
}
