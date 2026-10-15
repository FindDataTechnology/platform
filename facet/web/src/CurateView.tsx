// 策展板 — the facet curation board (add-facet-content-management), the
// admin surface that finally makes 谦面's content manageable in its own
// domain: every pack (unlisted and private included, via the admin viewer),
// inline category/featured writes, and per-pack usage from the platform
// gateway's aggregate (weekly actives / turns — the M1 exit metric). Usage
// degrades honestly; curation never depends on it. Presentation-level only:
// curation never changes visibility, content, or installability.
import { useCallback, useEffect, useState } from "react";
import * as api from "@/lib/packs-api";
import type { PackSummary } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";

type UsageRow = { packId: string | null; turns: number; activeUsers: number; lastUsedAt: number };

export function CurateView() {
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const r = await api.listPacks({ pageSize: 100 });
      setPacks(r.packs);
    } catch (err) {
      setNotice(`列表加载失败 / listing failed: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api
      .getPackUsageBoard()
      .then((r) => setUsage(r.rows))
      .catch((e: Error) => setUsageError(e.message));
  }, [refresh]);

  const save = async (pack: PackSummary, body: { category?: string; featured?: boolean }) => {
    try {
      await api.setPackCuration(pack.id, body);
      setNotice(`已保存 / saved: ${pack.name}`);
      await refresh();
    } catch (err) {
      setNotice(`保存失败 / failed: ${pack.name} — ${(err as Error).message}`);
    }
  };

  const usageOf = (id: string) => usage?.find((r) => r.packId === id) ?? null;

  if (!packs) return <p className="text-sm text-muted-foreground">加载中… / Loading…</p>;

  return (
    <section data-testid="facet-curate-view" className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">策展板 · Curation board</h2>
        <p className="text-xs text-muted-foreground mt-1">
          垂类与精选是呈现层管理（不影响可见性/版本/可安装）；用量来自壹座网关聚合（近 7 天）。
          <br />
          Category & featured are presentation-level; usage reads the platform aggregate (last 7 days).
        </p>
      </header>

      {notice && (
        <p data-testid="facet-curate-notice" className="text-xs text-muted-foreground border border-border rounded-md px-3 py-2">
          {notice}
        </p>
      )}

      {usageError && (
        <p data-testid="facet-curate-usage-degraded" className="text-xs text-amber-600 border border-amber-600/30 bg-amber-500/5 rounded-md px-3 py-2">
          用量面不可用（策展不受影响）/ Usage source unavailable (curation unaffected): {usageError}
        </p>
      )}

      <div className="grid gap-3">
        {packs.map((p) => {
          const u = usageOf(p.id);
          return (
            <div key={p.id} data-testid={`facet-curate-row-${p.id}`} className="border border-border rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-medium text-foreground">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  v{p.version} · {p.authorEmail}
                  {p.unlisted ? " · 已下架 unlisted" : ""}
                  {p.visibility === "private" ? " · 私有 private" : ""}
                  {u ? ` · 周活跃 ${u.activeUsers} / ${u.turns} 回合` : ""}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={drafts[p.id] ?? p.category ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                  placeholder="垂类 slug（如 legal）/ category slug"
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs w-56"
                  data-testid={`facet-curate-category-${p.id}`}
                />
                <Button variant="outline" size="sm" onClick={() => void save(p, { category: (drafts[p.id] ?? p.category ?? "").trim() })}>
                  改垂类 / Set category
                </Button>
                <Button
                  variant={p.featured ? "default" : "outline"}
                  size="sm"
                  onClick={() => void save(p, { featured: !p.featured })}
                  data-testid={`facet-curate-featured-${p.id}`}
                >
                  {p.featured ? "取消精选 / Unfeature" : "精选 / Feature"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
