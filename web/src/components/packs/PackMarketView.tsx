// PackMarketView — browse, search, inspect, subscribe (add-pack-marketplace).
// All parts of a pack are inspectable BEFORE subscribing: the detail dialog
// shows every skill's full body, MCP references with required groups, and
// agent personas (spec: pack-marketplace, browse-and-inspect).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackSummary, PackReport } from "@/lib/packs-api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/packs/Badge";
import { PackDetailDialog } from "./PackDetailDialog";

export function PackMarketView({ onSubscribed }: { onSubscribed?: () => void }) {
  const { t } = useTranslation();
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const refresh = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listPacks(q ? { search: q } : {});
      setPacks(r.packs);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh("");
  }, [refresh]);

  const [report, setReport] = useState<PackReport | null>(null);
  const [reportPack, setReportPack] = useState<string>("");

  return (
    <section data-testid="pack-market-section">
      <div className="flex items-center gap-2 mb-4">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void refresh(search)}
          placeholder={t("packs.market.searchPlaceholder")}
          className="max-w-sm"
          data-testid="pack-search-input"
        />
        <Button variant="outline" size="sm" onClick={() => void refresh(search)}>
          {t("packs.market.search")}
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md mb-4">{error}</div>
      )}
      {!loading && !error && packs.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("packs.market.empty")}</p>
      )}

      <div className="grid gap-3">
        {packs.map((pack) => (
          <button
            key={pack.id}
            onClick={() => setDetailId(pack.id)}
            data-testid={`pack-card-${pack.id}`}
            className="text-left border border-border rounded-lg p-4 hover:border-primary/50 transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">{pack.name}</span>
              <span className="text-xs text-muted-foreground">v{pack.version}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{pack.description}</p>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {pack.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
              <span className="text-xs text-muted-foreground ml-auto">{pack.authorEmail}</span>
            </div>
          </button>
        ))}
      </div>

      <PackDetailDialog
        packId={detailId}
        onOpenChange={(open) => !open && setDetailId(null)}
        onSubscribed={(r, name) => {
          setReport(r);
          setReportPack(name);
          void refresh(search);
        }}
        onGotoMine={onSubscribed}
      />

      {/* Post-subscribe per-part report (spec: pack-installation). */}
      {report && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          data-testid="pack-install-report"
          onClick={() => setReport(null)}
        >
          <div
            className="bg-background border border-border rounded-lg max-w-lg w-full max-h-[80vh] overflow-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold text-foreground mb-1">{t("packs.report.title", { name: reportPack })}</h3>
            <p className="text-xs text-muted-foreground mb-3">{t("packs.report.hint")}</p>
            <div className="space-y-1 text-sm">
              {report.skills.map((s) => (
                <div key={s.name} className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.skill")}</span>
                  <span className="text-foreground">{s.name}</span>
                  <span className="ml-auto">{statusLabel(t, s.status)}</span>
                  {s.reason && <span className="text-xs text-destructive w-full">{s.reason}</span>}
                </div>
              ))}
              {report.mcpServers.map((m) => (
                <div key={m.name} className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.mcp")}</span>
                  <span className="text-foreground">{m.name}</span>
                  <span className="ml-auto">{statusLabel(t, m.status)}</span>
                  {m.reason && <span className="text-xs text-destructive w-full">{m.reason}</span>}
                </div>
              ))}
              {report.agents.map((a) => (
                <div key={a.id} className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.agent")}</span>
                  <span className="text-foreground">{a.name}</span>
                  <span className="ml-auto">{statusLabel(t, a.status)}</span>
                  {a.reason && <span className="text-xs text-destructive w-full">{a.reason}</span>}
                </div>
              ))}
            </div>
            <div className="flex justify-end mt-4">
              <Button size="sm" onClick={() => setReport(null)}>
                {t("common.close")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function statusLabel(t: (k: string) => string, status: string) {
  const key = `packs.report.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}
