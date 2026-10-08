// RhythmEditor — the two-shape work-rhythm entry list (add-agent-residency
// D2): every (Nm/Nh, floor 5m) or daily (HH:MM), optional `do` prompt. Used by
// the draft editor (authoring serving.rhythm) and the deploy dialog (the
// deployer's effective-rhythm override). Validation mirrors lib/rhythm.js —
// invalid entries surface a hint and are excluded from the submitted payload.

import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface RhythmEntry {
  every?: string;
  daily?: string;
  do?: string;
}

const EVERY_RE = /^\d{1,4}(m|h)$/;
const DAILY_RE = /^\d{1,2}:\d{2}$/;

export function rhythmEntryValid(e: RhythmEntry) {
  const hasEvery = typeof e.every === "string" && e.every.trim().length > 0;
  const hasDaily = typeof e.daily === "string" && e.daily.trim().length > 0;
  if (hasEvery === hasDaily) return false;
  if (hasEvery) {
    const m = EVERY_RE.exec(e.every!.trim());
    if (!m) return false;
    const minutes = m[2] === "h" ? Number(m[1]) * 60 : Number(m[1]);
    return minutes >= 5;
  }
  const m = DAILY_RE.exec(e.daily!.trim());
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

export function RhythmEditor({
  value,
  onChange,
  testIdPrefix,
  maxEntries = 5,
}: {
  value: RhythmEntry[];
  onChange: (entries: RhythmEntry[]) => void;
  testIdPrefix: string;
  maxEntries?: number;
}) {
  const { t } = useTranslation();
  const entries = value ?? [];

  const setEntry = (i: number, patch: Partial<RhythmEntry>) =>
    onChange(entries.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <div className="space-y-2" data-testid={testIdPrefix}>
      {entries.map((e, i) => {
        const invalid = !rhythmEntryValid(e);
        return (
          /* biome-ignore lint/suspicious/noArrayIndexKey: rows are fully controlled by the parent array and entries carry no identity field */
          <div key={i}
            className={cn(
              "border rounded-md p-2 space-y-1.5",
              invalid ? "border-destructive/50" : "border-border",
            )}
            data-testid={`${testIdPrefix}-entry-${i}`}
          >
            <div className="flex items-center gap-1.5">
              <select
                value={e.daily !== undefined ? "daily" : "every"}
                onChange={(ev) =>
                  setEntry(i, ev.target.value === "daily" ? { daily: "", every: undefined } : { every: "", daily: undefined })
                }
                className="border border-border rounded px-1.5 py-1 text-xs bg-background"
                data-testid={`${testIdPrefix}-shape-${i}`}
              >
                <option value="every">{t("packs.rhythm.every")}</option>
                <option value="daily">{t("packs.rhythm.daily")}</option>
              </select>
              <Input
                value={(e.daily !== undefined ? e.daily : e.every) ?? ""}
                onChange={(ev) => setEntry(i, e.daily !== undefined ? { daily: ev.target.value } : { every: ev.target.value })}
                placeholder={e.daily !== undefined ? "09:30" : "90m"}
                className="h-7 w-24 font-mono text-xs"
                data-testid={`${testIdPrefix}-value-${i}`}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onChange(entries.filter((_, j) => j !== i))}
                aria-label={t("packs.rhythm.remove")}
                data-testid={`${testIdPrefix}-remove-${i}`}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
            <Textarea
              value={e.do ?? ""}
              onChange={(ev) => setEntry(i, { do: ev.target.value })}
              placeholder={t("packs.rhythm.doPlaceholder")}
              rows={2}
              className="text-xs"
              data-testid={`${testIdPrefix}-do-${i}`}
            />
            {invalid && (
              <p className="text-[10px] text-destructive" data-testid={`${testIdPrefix}-invalid-${i}`}>
                {t("packs.rhythm.invalid")}
              </p>
            )}
          </div>
        );
      })}
      {entries.length < maxEntries && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange([...entries, { every: "" }])}
          data-testid={`${testIdPrefix}-add`}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t("packs.rhythm.add")}
        </Button>
      )}
      <p className="text-[10px] text-muted-foreground">{t("packs.rhythm.hint")}</p>
    </div>
  );
}
