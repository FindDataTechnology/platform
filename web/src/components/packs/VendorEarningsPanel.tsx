// VendorEarningsPanel — 供应商收益账的轻呈现（add-market-revenue-share 4.3）。
//
// 数据纪律与 API 同源: 只渲染 /api/vendors/:slug/earnings 与
// /api/market/purchases/mine 的投影值 —— 无 bindings = 整个面板纯缺席
// （免费作者见市场面逐字节不变）。金额一律保留两位呈现, 口径随行标注。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { VendorEarnings, MarketPurchase } from "@/lib/packs-api";

const money = (n: number) => `$${n.toFixed(2)}`;

export function VendorEarningsPanel() {
  const { t } = useTranslation();
  const [slugs, setSlugs] = useState<{ slug: string; displayName: string }[] | null>(null);
  const [earnings, setEarnings] = useState<Record<string, VendorEarnings>>({});
  const [mine, setMine] = useState<MarketPurchase[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const w = await api.whoamiVendors();
        const vs = (w.vendors ?? []).map((v) => ({ slug: v.slug, displayName: v.displayName }));
        if (!alive) return;
        setSlugs(vs);
        if (vs.length === 0) return;
        const rows: Record<string, VendorEarnings> = {};
        for (const v of vs) {
          rows[v.slug] = await api.vendorEarnings(v.slug);
        }
        if (alive) setEarnings(rows);
      } catch {
        // 未登录/无 vendor 体系的市场面: 面板如不存在 — 从来不是阻断面。
        if (alive) setSlugs([]);
      }
      api
        .myMarketPurchases()
        .then((r) => alive && setMine((r.purchases ?? []).slice(0, 10)))
        .catch(() => {});
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!slugs || slugs.length === 0) return null;

  return (
    <section className="border border-border rounded-lg p-4 space-y-3" data-testid="vendor-earnings-panel">
      <h3 className="font-medium" data-testid="vendor-earnings-title">
        {t("packs.earnings.title")}
      </h3>
      {slugs.map((v) => {
        const e = earnings[v.slug]?.earnings;
        return (
          <div key={v.slug} className="text-sm" data-testid={`vendor-earnings-${v.slug}`}>
            <div className="flex items-center gap-2">
              <span className="font-medium">{v.displayName}</span>
              <span className="text-xs text-muted-foreground">@{v.slug}</span>
            </div>
            {e && (
              <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                <span data-testid={`vendor-earnings-settled-${v.slug}`}>
                  {t("packs.earnings.settled")}: <b className="text-foreground">{money(e.settledUsd)}</b>
                </span>
                <span data-testid={`vendor-earnings-pending-${v.slug}`}>
                  {t("packs.earnings.pending")}: <b className="text-foreground">{money(e.pendingUsd)}</b>
                </span>
                <span data-testid={`vendor-earnings-credit-${v.slug}`}>
                  {t("packs.earnings.credit")}: <b className="text-foreground">{money(e.availableCreditUsd)}</b>
                </span>
                <span data-testid={`vendor-earnings-spent-${v.slug}`}>
                  {t("packs.earnings.creditSpent")}: <b className="text-foreground">{money(e.creditSpentUsd)}</b>
                </span>
              </div>
            )}
          </div>
        );
      })}
      {mine.length > 0 && (
        <div className="border-t border-border pt-2">
          <p className="text-xs mb-1.5 text-muted-foreground">{t("packs.earnings.myPurchases")}</p>
          <ul className="space-y-1 text-xs">
            {mine.map((p) => (
              <li key={p.id} className="flex gap-2 items-baseline" data-testid={`my-purchase-${p.id}`}>
                <span className={p.direction === "refund" ? "text-amber-600" : "text-foreground"}>
                  {p.direction === "refund" ? "−" : "+"}
                  {money(p.priceUsd)}
                </span>
                <span className="text-muted-foreground">
                  {p.kind === "period" ? t("packs.earnings.periodKind", { days: p.periodDays }) : t("packs.earnings.onceKind")}
                </span>
                <span
                  className={`ml-auto font-mono text-[10px] ${p.status === "settled" ? "text-primary" : "text-amber-600"}`}
                  data-testid={`my-purchase-status-${p.id}`}
                >
                  {p.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
