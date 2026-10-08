// ModelList — lists a provider's model ids with a "Set as default" action.
// The active model (from the chat store) is highlighted. Setting the default
// calls PUT /api/llm/default; the server broadcasts model_changed so the
// sidebar chip updates.
//
// When a discovery map is present (add-llm-model-discovery), each roster row
// carries a status chip: serving = green; anything else = flagged (muted,
// tooltip with the sanitized probe message + probedAt) but still selectable —
// a flagged id keeps its seat until manually removed. Discovery ids that are
// NOT on the roster render below as visible-but-not-selectable suggestions.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setDefault, type DiscoveryStatus } from "@platform/core";
import { useChatStore } from "@platform/core";
import { wsSend } from "@/hooks/useWebSocket";
import { cn } from "@/lib/utils";

interface Props {
  providerId: string;
  models: string[];
  discovery?: Record<string, DiscoveryStatus> | null;
  // A Set-as-default in flight disables the row; only one at a time.
  onChanged: () => void;
}

function relativeTime(iso?: string) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function StatusChip({ status }: { status?: DiscoveryStatus }) {
  const { t } = useTranslation();
  if (!status) return null;
  const serving = status.status === "serving";
  const label = t(`modelsPage.discoveryStatus.${status.status}`);
  const tooltip = serving
    ? label
    : [status.error ? `${label}: ${status.error}` : label, relativeTime(status.probedAt)]
        .filter(Boolean)
        .join(" · ");
  return (
    <span
      role="status"
      aria-label={`${status.status}: ${tooltip}`}
      title={tooltip}
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
        serving
          ? "bg-success/15 text-success"
          : "bg-muted text-muted-foreground line-through decoration-muted-foreground/60",
      )}
      data-testid={serving ? "llm-status-serving" : "llm-status-flagged"}
      data-status={status.status}
    >
      {label}
    </span>
  );
}

export function ModelList({ providerId, models, discovery, onChanged }: Props) {
  const { t } = useTranslation();
  const currentModel = useChatStore((s) => s.currentModel);
  const currentEffort = useChatStore((s) => s.currentEffort);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const modelInfo = useChatStore((s) => s.models);
  const [busy, setBusy] = useState<string | null>(null);

  const choose = async (modelId: string) => {
    setBusy(modelId);
    try {
      await setDefault(modelId, providerId);
      onChanged();
    } catch (e) {
      // surfaced by the page-level toast; keep the row usable
      console.warn("[models] set default failed:", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Discovery ids not on the roster: operator signal (e.g. "mimo: upstream
  // down ×6"), visible but not selectable.
  const others = Object.entries(discovery ?? {})
    .filter(([id, s]) => !models.includes(id) && s.status !== "serving")
    .sort(([a], [b]) => a.localeCompare(b));

  if (!models.length && !others.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {models.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="llm-model-list">
          {models.map((m) => {
            const active = currentModel === m;
            const isBusy = busy === m;
            // The thinking level applies to the running session, so the picker is
            // only meaningful on the active model's row.
            const efforts = active ? modelInfo.find((i) => i.id === m)?.reasoningEfforts ?? [] : [];
            return (
              <li
                key={m}
                className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-1.5 text-xs"
              >
                <span className="flex min-w-0 items-center gap-2 font-mono text-foreground">
                  {active && <Check className="h-3.5 w-3.5 shrink-0 text-success" data-testid="llm-default-check" />}
                  <span className="truncate" title={m}>{m}</span>
                  <StatusChip status={discovery?.[m]} />
                </span>
                <span className="flex items-center gap-2">
                  {efforts.length > 0 && (
                    <select
                      aria-label={t("modelsPage.thinkingLevel")}
                      data-testid="llm-effort-select"
                      value={currentEffort ?? ""}
                      disabled={isStreaming}
                      onChange={(e) => wsSend({ type: "set_effort", effort: e.target.value || null })}
                      className="rounded-md border border-input bg-background px-1.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="">{t("modelsPage.thinkingDefault")}</option>
                      {efforts.map((lvl) => (
                        <option key={lvl} value={lvl}>
                          {lvl}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    disabled={active || isBusy}
                    onClick={() => choose(m)}
                    data-testid="llm-set-default"
                  >
                    {isBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                    {active ? t("modelsPage.default") : t("modelsPage.setDefault")}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {others.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="llm-discovered-others">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("modelsPage.otherDiscovered")}
          </p>
          <ul className="flex flex-col gap-1">
            {others.map(([id, s]) => (
              <li
                key={id}
                className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-xs"
                aria-disabled="true"
              >
                <span className="flex min-w-0 items-center gap-2 font-mono text-muted-foreground">
                  <span className="truncate" title={id}>{id}</span>
                  <StatusChip status={s} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
