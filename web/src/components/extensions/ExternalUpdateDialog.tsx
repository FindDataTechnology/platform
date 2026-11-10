// ExternalUpdateDialog.tsx — the diff-preview panel for explicitly updating an
// installed external-market skill (chat-interaction-round2).
//
// Mirrors ExternalInstallDialog's shape: loading / preview / result. The diff
// comes from the server (read-only fetch + compare); the confirm button is the
// only write path and reuses the install chain's replace semantics server-side
// (local name pinned, hot-reload via the watched directory). When the upstream
// carries scripts, the same informed-consent checkbox as install applies — a
// new version may introduce scripts the user has never seen.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  previewExternalUpdate,
  updateExternalSkill,
  type ExternalUpdatePreview,
} from "@platform/core";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const LicenseChip = ({ state }: { state: ExternalUpdatePreview["licenseState"] }) => {
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

const STATUS_CLS: Record<string, string> = {
  added: "text-emerald-600 dark:text-emerald-400",
  changed: "text-amber-600 dark:text-amber-400",
  removed: "text-destructive",
  unchanged: "text-muted-foreground",
};

export function ExternalUpdateDialog({
  name,
  onOpenChange,
}: {
  name: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ExternalUpdatePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setResult(null);
    setAcknowledged(false);
    try {
      setPreview(await previewExternalUpdate(name));
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      const out = await updateExternalSkill(name);
      setResult({ ok: true, message: t("extensions.external.update.success", { name: out.skill.name }) });
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setUpdating(false);
    }
  };

  const needsAck = preview?.hasScripts ?? false;
  const canUpdate =
    preview != null && preview.diff.changed && !updating && (!needsAck || acknowledged) && result?.ok !== true;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="external-update-dialog">
        <DialogHeader>
          <DialogTitle>{t("extensions.external.update.title", { name })}</DialogTitle>
        </DialogHeader>

        {loading && (
          <p className="text-sm text-muted-foreground" data-testid="update-loading">
            {t("common.loading")}
          </p>
        )}

        {!loading && loadError && (
          <div className="space-y-3">
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="update-load-error">
              {loadError}
            </div>
            <button
              onClick={() => void load()}
              className="h-8 rounded-md border border-input px-3 text-sm"
              data-testid="update-retry"
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
              <span className="text-xs text-muted-foreground" data-testid="update-version-line">
                {t("extensions.external.update.versionLine", {
                  current: preview.currentVersion ?? "—",
                  upstream: preview.upstreamVersion ?? "—",
                })}
              </span>
            </div>

            {!preview.diff.changed ? (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground" data-testid="update-nochanges">
                {t("extensions.external.update.noChanges")}
              </div>
            ) : (
              <>
                <p data-testid="update-body-status">
                  {preview.diff.bodyStatus === "changed"
                    ? t("extensions.external.update.bodyChanged")
                    : t("extensions.external.update.bodyUnchanged")}
                </p>
                <p className="text-xs text-muted-foreground" data-testid="update-counts">
                  {t("extensions.external.update.countsLine", preview.diff.counts)}
                </p>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("extensions.external.update.filesLabel", { count: preview.diff.files.length })}
                  </p>
                  <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto" data-testid="update-file-list">
                    {preview.diff.files.map((f) => (
                      <li key={f.path} className="flex items-center justify-between gap-2 rounded px-2 py-0.5 text-xs odd:bg-muted/40">
                        <span className="truncate" title={f.path}>{f.path}</span>
                        <span className={`shrink-0 ${STATUS_CLS[f.status] ?? ""}`}>
                          {t(`extensions.external.update.status.${f.status}`)} · {fmtBytes(f.bytes)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}

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

            {needsAck && preview.diff.changed && (
              <label className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5"
                  data-testid="update-ack-scripts"
                />
                <span>{t("extensions.external.install.scriptWarning")}</span>
              </label>
            )}

            <button
              onClick={() => void handleUpdate()}
              disabled={!canUpdate}
              className="h-9 w-full rounded-md bg-primary text-sm text-primary-foreground disabled:opacity-50"
              data-testid="update-confirm"
            >
              {updating ? t("extensions.external.update.updating") : t("extensions.external.update.confirm")}
            </button>
          </div>
        )}

        {!loading && result && (
          <div className="space-y-3 text-sm">
            <div
              className={`rounded-md px-3 py-2 ${result.ok ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-destructive/10 text-destructive"}`}
              data-testid={result.ok ? "update-success" : "update-failure"}
            >
              {result.message}
            </div>
            {!result.ok && (
              <button
                onClick={() => void load()}
                className="h-8 rounded-md border border-input px-3 text-sm"
                data-testid="update-retry"
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
