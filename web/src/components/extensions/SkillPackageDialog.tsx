// SkillPackageDialog.tsx — upload a skill package (zip) into this instance
// (add-packaged-skills D7, entry 1: 设置→技能).
//
// Mirrors ExternalInstallDialog's consent shape with a local file source:
// pick a zip → server-side preview (body excerpt, file inventory with script
// highlight and honest omission marks) → optional name/description override →
// script acknowledgment when needed → install. The consent gate is enforced
// server-side; this panel exists so the user knows what they are installing.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  installSkillPackage,
  previewSkillPackage,
  type SkillPackagePreview,
} from "@platform/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SkillPackageDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Fired after a successful install; the parent switches to the Installed tab.
  onInstalled?: () => void;
}) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SkillPackagePreview | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPreview(null);
    setName("");
    setDescription("");
    setError("");
    setAcknowledged(false);
    setResult(null);
    setLoading(false);
    setInstalling(false);
  }, [open]);

  const loadPreview = async (f: File) => {
    setLoading(true);
    setError("");
    setResult(null);
    setAcknowledged(false);
    try {
      const p = await previewSkillPackage(f, { name: name.trim(), description: description.trim() });
      setPreview(p);
      if (!name.trim()) setName(p.name);
      if (!description.trim()) setDescription(p.description ?? "");
    } catch (err) {
      setError((err as Error).message);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  const handlePick = (f: File | null) => {
    setFile(f);
    setPreview(null);
    setError("");
    setResult(null);
    if (f) void loadPreview(f);
  };

  const handleInstall = async () => {
    if (!file) return;
    setInstalling(true);
    setError("");
    try {
      const out = await installSkillPackage(file, {
        name: name.trim(),
        description: description.trim(),
        confirm: true,
      });
      setResult({
        ok: true,
        message: out.replaced
          ? t("extensions.skills.package.successReplaced", { name: out.skill.name })
          : t("extensions.skills.package.success", { name: out.skill.name, count: out.skill.fileCount }),
      });
      onInstalled?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  const needsAck = preview?.hasScripts ?? false;
  const canInstall = file != null && preview != null && !installing && (!needsAck || acknowledged);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="skill-package-dialog">
        <DialogHeader>
          <DialogTitle>
            <Icon name="package" size={20} />
            {t("extensions.skills.package.title")}
          </DialogTitle>
          <DialogDescription>{t("extensions.skills.package.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4 text-sm">
          <input
            ref={fileInput}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
            data-testid="skill-package-file-input"
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="flex w-full flex-col items-center gap-1 rounded-md border border-dashed border-input px-4 py-6 text-muted-foreground hover:border-primary/50 hover:text-foreground"
            data-testid="skill-package-pick"
          >
            <Icon name="upload" size={18} />
            <span>{file ? file.name : t("extensions.skills.package.pick")}</span>
            {file && <span className="text-xs">{fmtBytes(file.size)}</span>}
          </button>

          {loading && (
            <p className="text-sm text-muted-foreground" data-testid="skill-package-loading">
              {t("common.loading")}
            </p>
          )}

          {error && (
            <div
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="skill-package-error"
              role="alert"
            >
              {error}
            </div>
          )}

          {preview && !result && (
            <>
              <div className="space-y-2">
                <Label htmlFor="pkg-name">{t("extensions.skills.fields.name")}</Label>
                <Input
                  id="pkg-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={preview.name}
                  data-testid="skill-package-name"
                />
                {preview.upstreamName && preview.upstreamName !== preview.name && (
                  <p className="text-xs text-muted-foreground">
                    {t("extensions.skills.package.normalizedAs", { name: preview.name, upstream: preview.upstreamName })}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="pkg-description">{t("extensions.skills.fields.description")}</Label>
                <Input
                  id="pkg-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  data-testid="skill-package-description"
                />
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {t("extensions.skills.package.bodyLabel")}
                </p>
                <pre className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs" data-testid="skill-package-body">
                  {preview.bodyExcerpt}
                </pre>
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {t("extensions.skills.package.filesLabel", {
                    count: preview.storedFileCount,
                    total: preview.files.length,
                  })}
                </p>
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto" data-testid="skill-package-files">
                  {preview.files.map((f) => (
                    <li key={f.path} className="flex items-center justify-between gap-2 rounded px-2 py-0.5 text-xs odd:bg-muted/40">
                      <span className="flex items-center gap-1.5 truncate">
                        {f.script && <Icon name="terminal" className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />}
                        <span className="truncate" title={f.path}>{f.path}</span>
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {fmtBytes(f.bytes)}
                        {f.action === "omitted-binary" && ` · ${t("extensions.skills.package.omittedBinary")}`}
                        {f.action === "omitted-large" && ` · ${t("extensions.skills.package.omittedLarge")}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {needsAck && (
                <label className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    className="mt-0.5"
                    data-testid="skill-package-ack-scripts"
                  />
                  <span>{t("extensions.skills.package.scriptWarning")}</span>
                </label>
              )}

              <Button onClick={() => void handleInstall()} disabled={!canInstall} className="w-full" data-testid="skill-package-install">
                {installing ? t("common.saving") : t("extensions.skills.package.install")}
              </Button>
            </>
          )}

          {result && (
            <div
              className={`rounded-md px-3 py-2 ${result.ok ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-destructive/10 text-destructive"}`}
              data-testid={result.ok ? "skill-package-success" : "skill-package-failure"}
            >
              {result.message}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
