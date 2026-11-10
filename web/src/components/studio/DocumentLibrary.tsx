// DocumentLibrary — the workspace's left rail (add-agent-builder-workspace
// 1.1): every document is a persisted blueprint record; the library answers
// "which document am I editing" (the roster of agents was demoted to canvas
// chips — the old roster tab answered neither question well). Status rides the
// shared StatusPill (statusTokens; color never speaks alone).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayoutTemplate, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import type { StatusKind } from "@/lib/statusTokens";
import type { BlueprintSummary } from "@/lib/blueprint-api";
import { fetchStarterSeed, listOfficialStarters, type StarterSummary } from "@/lib/starter-seed";
import { cn } from "@/lib/utils";

// The three blueprint statuses mapped onto the design system's semantic
// tokens: a draft is neutral, an approval waits on its cast, a cast document
// is the live one.
export const DOC_STATUS_TONE: Record<BlueprintSummary["status"], StatusKind> = {
  draft: "neutral",
  approved: "waiting",
  cast: "running",
};

export function DocumentLibrary({
  docs,
  activeId,
  onOpen,
  onNew,
  onNewFromStarter,
  busy,
}: {
  docs: BlueprintSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: (kind: "agent" | "team") => void;
  onNewFromStarter: (seed: Awaited<ReturnType<typeof fetchStarterSeed>>) => void;
  busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  // 8.2: the official starter picker lives in the EMPTY state — the moment the
  // owner has documents, the blank-page affordances are noise. Picking a
  // starter fetches its market manifest and hands the projected seed to the
  // page (same createBlueprint lane as any other document).
  const [starters, setStarters] = useState<StarterSummary[] | null>(null);
  const [starterBusy, setStarterBusy] = useState<string | null>(null);
  const [starterError, setStarterError] = useState<string | null>(null);

  const openStarters = async () => {
    if (starters) {
      setStarters(null);
      return;
    }
    setStarterError(null);
    const list = await listOfficialStarters();
    setStarters(list);
  };

  const adoptStarter = async (s: StarterSummary) => {
    setStarterBusy(s.id);
    setStarterError(null);
    try {
      const seed = await fetchStarterSeed(s.id);
      if (!seed) {
        setStarterError(t("studio.workspace.library.starterUnavailable"));
        return;
      }
      onNewFromStarter(seed);
    } finally {
      setStarterBusy(null);
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...docs].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return q ? sorted.filter((d) => (d.name ?? "").toLowerCase().includes(q)) : sorted;
  }, [docs, query]);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border" data-testid="ws-library">
      <div className="p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("studio.workspace.library.search")}
            className="pl-7 text-xs"
            data-testid="ws-library-search"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {shown.map((d) => (
          <button
            key={d.id}
            type="button"
            data-testid={`ws-library-item-${d.id}`}
            onClick={() => onOpen(d.id)}
            className={cn(
              "w-full rounded-md px-2 py-1.5 text-left",
              activeId === d.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
            )}
          >
            <div className="truncate text-xs font-medium">{d.name || t("studio.blueprint.untitled")}</div>
            <div className="mt-1 flex items-center gap-1.5">
              <StatusPill status={DOC_STATUS_TONE[d.status]} label={t(`studio.blueprint.status.${d.status}`)} className="px-1.5 py-0 text-[10px]" />
              {/* 4.4: 两 kind 统一列，kind 以静默徽章区分（不是第二套列表）。 */}
              <span className="rounded-full border border-border px-1 py-0 text-[9px] text-muted-foreground" data-testid={`ws-library-kind-${d.id}`}>
                {t(`studio.workspace.kind.${d.kind === "agent" ? "agent" : "team"}`)}
              </span>
              <span className="text-[10px] text-muted-foreground">{new Date(d.updatedAt).toLocaleDateString(i18n.language)}</span>
            </div>
          </button>
        ))}
        {shown.length === 0 && (
          <div className="space-y-2 px-1 py-3 text-xs text-muted-foreground" data-testid="ws-library-empty">
            <p>{t("studio.workspace.library.empty")}</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>{t("studio.workspace.library.guideBlank")}</li>
              <li>{t("studio.workspace.library.guideAi")}</li>
              <li>{t("studio.workspace.library.guideMarket")}</li>
            </ul>
            {/* 8.2: seed from the official starter shelf (the SAME list the
                market showcases — no second roster). */}
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => void openStarters()}
              data-testid="ws-library-starters-toggle"
            >
              <LayoutTemplate className="h-3.5 w-3.5" /> {t("studio.workspace.library.starters")}
            </Button>
            {starters ? (
              starters.length > 0 ? (
                <ul className="space-y-1" data-testid="ws-library-starters">
                  {starters.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="w-full rounded-md px-2 py-1 text-left hover:bg-muted/60"
                        disabled={starterBusy !== null}
                        onClick={() => void adoptStarter(s)}
                        data-testid={`ws-starter-${s.id}`}
                      >
                        <span className="block truncate font-medium">{starterBusy === s.id ? "…" : s.name}</span>
                        {s.description ? <span className="block truncate text-[10px]">{s.description}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p data-testid="ws-library-starters-empty">{t("studio.workspace.library.startersEmpty")}</p>
              )
            ) : null}
            {starterError && <p className="text-destructive" data-testid="ws-library-starters-error">{starterError}</p>}
          </div>
        )}
      </div>
      <div className="space-y-1 border-t border-border p-2">
        <Button size="sm" className="w-full" onClick={() => onNew("agent")} disabled={busy} data-testid="ws-new-agent">
          <Plus className="h-3.5 w-3.5" /> {t("studio.workspace.library.newAgent")}
        </Button>
        <Button size="sm" variant="outline" className="w-full" onClick={() => onNew("team")} disabled={busy} data-testid="ws-new-team">
          <Plus className="h-3.5 w-3.5" /> {t("studio.workspace.library.newTeam")}
        </Button>
      </div>
    </aside>
  );
}
