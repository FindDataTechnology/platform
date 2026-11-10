// MemoryDrawer.tsx — 萬星 console 部署者记忆浏览（add-unified-memory-and-outputs
// 4.1, spec: memory-portal-ui「萬星 console 部署者记忆浏览」）。部署者看自己
// 部署的记忆根（d-<packId>，project=<agentId>），经 /api/memory/deployer-entries
// 的 platform lane，与壹座面板共用同一 visibility 读面语义。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listDeployerMemoryEntries, type MemoryEntry } from "@/api/memory";

const LAYERS = ["L0", "L1", "L2"] as const;

export function MemoryDrawer({
  agentId,
  packId,
  onClose,
}: {
  agentId: string | null;
  packId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<MemoryEntry[]>([]);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [layer, setLayer] = useState<string | null>(null);

  const rootKey = packId ? `d-${packId}` : null;
  const scope = agentId || undefined;

  const load = useCallback(async () => {
    if (!rootKey) return;
    setLoading(true);
    setDegraded(null);
    try {
      const out = await listDeployerMemoryEntries(rootKey, { scope, layer: layer ?? undefined, limit: 100 });
      setItems(out.items);
    } catch {
      setDegraded(t("memory.degraded.unavailable"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [rootKey, scope, layer, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col" data-testid="fleet-memory-drawer">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="text-sm font-semibold">{t("memory.deployer.title")}</div>
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={onClose} data-testid="fleet-memory-close">
          {t("memory.deployer.close")}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2">
        {([null, ...LAYERS] as const).map((l) => (
          <button
            key={String(l)}
            className={`rounded-md px-2 py-0.5 text-xs ${layer === l ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"}`}
            onClick={() => setLayer(l)}
            data-testid={`fleet-memory-layer-${l ?? "all"}`}
          >
            {l ?? t("memory.all")}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">{rootKey ?? "—"}{scope ? ` / ${scope}` : ""}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!rootKey ? (
          <div className="text-sm text-muted-foreground" data-testid="fleet-memory-nopack">
            {t("memory.deployer.noPack")}
          </div>
        ) : degraded ? (
          <div className="text-sm text-muted-foreground" data-testid="fleet-memory-degraded">{degraded}</div>
        ) : loading ? (
          <div className="text-sm text-muted-foreground">{t("memory.loading")}</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-muted-foreground" data-testid="fleet-memory-empty">{t("memory.deployer.empty")}</div>
        ) : (
          <div className="space-y-2">
            {items.map((it) => (
              <div key={it.path} className="rounded-md border border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{it.layer}·{it.type ?? "page"}</span>
                  {it.tier && it.tier !== "draft" ? (
                    <span className={`rounded-full px-2 py-0.5 text-xs border ${it.tier === "canonical" ? "border-amber-500/50 bg-amber-500/10 text-amber-500" : "border-primary/40 bg-primary/10 text-primary"}`}>
                      {t(`resources.memory.tier.${it.tier}`)}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm">{it.title}</span>
                  <span className="text-xs text-muted-foreground">{String(it.ts ?? "").slice(0, 10)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
