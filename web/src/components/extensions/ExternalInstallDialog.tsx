// ExternalInstallDialog.tsx — the informed-consent panel for installing an
// external-market skill (add-external-skill-install 刀二).
//
// Three states: loading the preview, consent (what will install + the script
// warning + the explicit checkbox), and the result. The consent checkbox is a
// real gate in this UI, but the ENFORCEMENT lives server-side (a request
// without confirm:true is refused) — this panel exists so the user actually
// knows what they are installing, not to be the security boundary.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  installExternalSkill,
  previewExternalInstall,
  type ExternalInstallPreview,
} from "@platform/core";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";

const LicenseChip = ({ state }: { state: ExternalInstallPreview["licenseState"] }) => {
  const { t } = useTranslation();
  const cls =
    state === "declared"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : state === "not-declared"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${cls}`}>
      {t(`extensions.external.license.${state}`)}
    </span>
  );
};

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ExternalInstallDialog({
  source,
  slug,
  onOpenChange,
}: {
  source: string;
  slug: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ExternalInstallPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setResult(null);
    setAcknowledged(false);
    try {
      setPreview(await previewExternalInstall(source, slug));
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [source, slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleInstall = async () => {
    setInstalling(true);
    try {
      const out = await installExternalSkill(source, slug);
      setResult({
        ok: true,
        message: out.replaced
          ? t("extensions.external.install.successReplaced", { name: out.skill.name })
          : t("extensions.external.install.success", { name: out.skill.name }),
      });
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setInstalling(false);
    }
  };

  const needsAck = preview?.hasScripts ?? false;
  const canInstall = preview != null && !installing && (!needsAck || acknowledged) && result?.ok !== true;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="external-install-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("extensions.external.install.title", { name: preview?.displayName ?? slug })}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <p className="text-sm text-muted-foreground" data-testid="install-loading">
            {t("common.loading")}
          </p>
        )}

        {!loading && loadError && (
          <div className="space-y-3">
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="install-load-error">
              {loadError}
            </div>
            <button
              onClick={() => void load()}
              className="h-8 rounded-md border border-input px-3 text-sm"
              data-testid="install-retry"
            >
              {t("extensions.external.install.retry")}
            </button>
          </div>
        )}

        {!loading && preview && !result && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <LicenseChip state={preview.licenseState} />
              <span className="inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
                {t("extensions.external.notReviewed")}
              </span>
              {preview.normalizedName && preview.normalizedName !== preview.upstreamName && (
                <span className="text-xs text-muted-foreground" data-testid="install-normalized-name">
                  {t("extensions.external.install.normalizedAs", { name: preview.normalizedName })}
                </span>
              )}
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground">{t("extensions.external.install.bodyLabel")}</p>
              <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs" data-testid="install-body-excerpt">
                {preview.bodyExcerpt}
              </pre>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t("extensions.external.install.filesLabel", { count: preview.files.length })}
              </p>
              <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto" data-testid="install-file-list">
                {preview.files.map((f) => (
                  <li key={f.path} className="flex items-center justify-between gap-2 rounded px-2 py-0.5 text-xs odd:bg-muted/40">
                    <span className="flex items-center gap-1.5 truncate">
                      {f.script && <Icon name="terminal" className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />}
                      <span className="truncate" title={f.path}>{f.path}</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {fmtBytes(f.bytes)}
                      {f.action === "omitted-binary" && ` · ${t("extensions.external.install.omittedBinary")}`}
                      {f.action === "omitted-large" && ` · ${t("extensions.external.install.omittedLarge")}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {preview.originUrl && (
              <p className="text-xs">
                <a
                  href={preview.originUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  {t("extensions.external.install.upstream")}
                </a>
              </p>
            )}

            {needsAck && (
              <label className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5"
                  data-testid="install-ack-scripts"
                />
                <span>{t("extensions.external.install.scriptWarning")}</span>
              </label>
            )}

            <button
              onClick={() => void handleInstall()}
              disabled={!canInstall}
              className="h-9 w-full rounded-md bg-primary text-sm text-primary-foreground disabled:opacity-50"
              data-testid="install-confirm"
            >
              {installing ? t("extensions.external.install.installing") : t("extensions.external.install.confirm")}
            </button>
          </div>
        )}

        {!loading && result && (
          <div className="space-y-3 text-sm">
            <div
              className={`rounded-md px-3 py-2 ${result.ok ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-destructive/10 text-destructive"}`}
              data-testid={result.ok ? "install-success" : "install-failure"}
            >
              {result.message}
            </div>
            {result.ok && (
              <p className="text-xs text-muted-foreground">{t("extensions.external.install.findInInstalled")}</p>
            )}
            {!result.ok && (
              <button
                onClick={() => void load()}
                className="h-8 rounded-md border border-input px-3 text-sm"
                data-testid="install-retry"
              >
                {t("extensions.external.install.retry")}
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
