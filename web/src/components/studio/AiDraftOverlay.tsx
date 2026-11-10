// AiDraftOverlay — the drafting accelerator, re-homed (add-agent-builder-
// workspace 2.4): a right-docked review panel instead of the bar that squeezed
// the canvas. The doctrine is unchanged (studio-ai-drafting): the model's
// output is a DRAFT, the human's 「采用」 is the single write gate — only the
// granularity refined: adoption is now PER FIELD, and a skipped field leaves
// the document byte-for-byte untouched. The skills row is visible but inert
// until batch 2 opens the skills bucket (a hidden proposal would be a silent
// discard — worse than a disabled row that says why).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface DraftField {
  key: "name" | "description" | "persona" | "mcpServers" | "skills" | "fleet";
  labelKey: string;
  preview: string;
  enabled: boolean;
  disabledReasonKey?: string;
}

export function AiDraftOverlay({
  prompt,
  onPrompt,
  busy,
  error,
  draft,
  onRun,
  onClose,
  onAdopt,
}: {
  prompt: string;
  onPrompt: (v: string) => void;
  busy: boolean;
  error: string | null;
  draft: Record<string, unknown> | null;
  onRun: () => void;
  onClose: () => void;
  onAdopt: (picked: Set<DraftField["key"]>, draft: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Set<DraftField["key"]>>(new Set());
  // A fresh draft is a fresh review — never carry stale picks across runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps 即意图——回调不读 draft，但要随新草稿翻转清空勾选
  useEffect(() => setPicked(new Set()), [draft]);

  const fields: DraftField[] = draft
    ? [
        typeof draft.name === "string" && draft.name.trim()
          ? { key: "name", labelKey: "studio.workspace.draft.field.name", preview: draft.name, enabled: true }
          : null,
        typeof draft.description === "string" && draft.description
          ? { key: "description", labelKey: "studio.workspace.draft.field.description", preview: draft.description, enabled: true }
          : null,
        typeof draft.persona === "string" && draft.persona
          ? { key: "persona", labelKey: "studio.workspace.draft.field.persona", preview: draft.persona, enabled: true }
          : null,
        Array.isArray(draft.mcpServers) && draft.mcpServers.length
          ? {
              key: "mcpServers",
              labelKey: "studio.workspace.draft.field.mcpServers",
              preview: (draft.mcpServers as { registryName?: string }[]).map((m) => m?.registryName ?? "?").join(", "),
              enabled: true,
            }
          : null,
        (() => {
          const f = draft.fleet as { members?: unknown[]; name?: string } | undefined;
          if (!f || typeof f !== "object" || !Array.isArray(f.members)) return null;
          return {
            key: "fleet" as const,
            labelKey: "studio.workspace.draft.field.fleet",
            preview: `${f.members.length} × ${(f as { name?: string }).name ?? "fleet"}`,
            enabled: true,
          };
        })(),
        Array.isArray(draft.skills) && draft.skills.length
          ? {
              key: "skills",
              labelKey: "studio.workspace.draft.field.skills",
              preview: (draft.skills as { name?: string }[]).map((s) => s?.name ?? "?").join(", "),
              enabled: false,
              disabledReasonKey: "studio.workspace.draft.skillsNote",
            }
          : null,
      ].filter((f): f is DraftField => f != null)
    : [];

  const toggle = (k: DraftField["key"]) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div
      className="absolute inset-y-0 right-0 z-20 flex w-96 max-w-full flex-col border-l border-border bg-background shadow-xl"
      data-testid="ws-ai-draft"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-sm font-medium">{t("studio.aiDraft.title")}</h3>
        <button type="button" aria-label={t("studio.workspace.draft.close")} data-testid="ws-ai-draft-close" className="rounded p-1 text-muted-foreground hover:bg-muted" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <textarea
          data-testid="ws-ai-draft-prompt"
          className="w-full rounded-md border border-border bg-background p-2 text-sm"
          rows={3}
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          placeholder={t("studio.aiDraft.promptLabel")}
        />
        <Button size="sm" data-testid="ws-ai-draft-run" disabled={busy || !prompt.trim()} onClick={onRun}>
          {busy ? "…" : t("studio.aiDraft.action")}
        </Button>
        {error && <p className="text-xs text-destructive" data-testid="ws-ai-draft-error">{error}</p>}
        {draft && (
          <div className="space-y-2" data-testid="ws-ai-draft-review">
            {fields.map((f) => (
              <div key={f.key} className="rounded-md border border-border p-2" data-testid={`ws-ai-draft-row-${f.key}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{t(f.labelKey)}</span>
                  {f.enabled ? (
                    <button
                      type="button"
                      data-testid={`ws-ai-draft-pick-${f.key}`}
                      onClick={() => toggle(f.key)}
                      aria-pressed={picked.has(f.key)}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px]",
                        picked.has(f.key) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {picked.has(f.key) ? t("studio.workspace.draft.adopt") : t("studio.workspace.draft.skip")}
                    </button>
                  ) : (
                    <Tooltip content={t(f.disabledReasonKey ?? "")}>
                      <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{t("studio.workspace.draft.inert")}</span>
                    </Tooltip>
                  )}
                </div>
                <p className="mt-1 line-clamp-3 whitespace-pre-line text-[11px] text-muted-foreground">{f.preview}</p>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                size="sm"
                data-testid="ws-ai-draft-adopt-picked"
                disabled={picked.size === 0}
                onClick={() => onAdopt(new Set([...picked].filter((k) => fields.some((f) => f.key === k && f.enabled))), draft)}
              >
                {t("studio.workspace.draft.adoptPicked", { n: picked.size })}
              </Button>
              <Button size="sm" variant="outline" data-testid="ws-ai-draft-adopt-all" onClick={() => onAdopt(new Set(fields.filter((f) => f.enabled).map((f) => f.key)), draft)}>
                {t("studio.workspace.draft.adoptAll")}
              </Button>
              <Button size="sm" variant="ghost" data-testid="ws-ai-draft-discard" onClick={onClose}>
                {t("studio.aiDraft.discard")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
