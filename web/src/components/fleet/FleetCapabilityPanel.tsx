// ── 团队能力面板（capability-layer scope=team）────────────────────────────────
//
// 回答一个问题：**这支团队的各岗实际拿到了什么能力**。
//
// 数据来自来源 pack 的 manifest（读面 `/api/fleets/:id/capabilities`），不是运行时
// 状态——能力的真源是包，团队只是它的实例。所以这里呈现的是「按编制该有的」，
// 不是「此刻跑着的」；两者不同时，差异由别的面（回合/报数）负责说。
//
// 三条如实纪律：
//   · 没从 pack 建队 / manifest 读不出 ⇒ 说清原因，**不画空表**。空表会让读者
//     以为这个团队没有能力，而实际是查不到。
//   · 不可见条目是 opaque 占位，不是缺席——服务端给的就是这个，照画。
//   · 未解析的技能声明单独列出来（`unresolvedSkills`）：那是配置问题，不是
//     「没有这个技能」，混进正常条目里会被当成已生效。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";

type Cap = { kind: string; name: string | null; origin?: string | null; visibility?: string | null; scope?: string | null; opaque?: boolean; note?: string | null };
type Payload = {
  ok: boolean;
  reason?: string;
  packId?: string;
  capabilities?: Cap[];
  unresolvedSkills?: { name: string; reason: string }[];
};

export function FleetCapabilityPanel({ fleetId }: { fleetId: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/fleets/${encodeURIComponent(fleetId)}/capabilities`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => alive && setData(b))
      .catch((e) => alive && setError(String(e?.message || e)));
    return () => { alive = false; };
  }, [fleetId]);

  if (error) {
    return <Card className="p-3 text-sm text-destructive" data-testid="fleet-cap-error">{t("fleets.capability.loadFailed")}：{error}</Card>;
  }
  if (!data) return null;
  // 查不到来源包时**不画空表**——如实说原因。
  if (!data.ok) {
    return (
      <Card className="p-3 text-sm text-muted-foreground" data-testid="fleet-cap-unavailable">
        {t("fleets.capability.unavailable")}：{data.reason}
      </Card>
    );
  }

  const caps = data.capabilities ?? [];
  const groups = new Map<string, Cap[]>();
  for (const c of caps) {
    const list = groups.get(c.kind) ?? [];
    list.push(c);
    groups.set(c.kind, list);
  }

  return (
    <Card className="p-3 space-y-2" data-testid="fleet-capability">
      <div className="flex items-baseline gap-2">
        <span className="font-medium text-sm">{t("fleets.capability.title")}</span>
        <span className="text-xs text-muted-foreground">{t("fleets.capability.count", { n: caps.length })}</span>
      </div>
      {[...groups.entries()].map(([kind, list]) => (
        <div key={kind}>
          <div className="text-xs text-muted-foreground">{t(`fleets.capability.kind.${kind}`, { defaultValue: kind })} · {list.length}</div>
          <ul className="mt-1 flex flex-wrap gap-1">
            {list.map((c, i) => (
              <li
                key={`${kind}:${c.name ?? i}`}
                data-testid={`fleet-cap-${c.opaque ? `opaque-${i}` : c.name}`}
                className="rounded-sm border border-border px-1.5 py-1 font-mono text-[11px]"
                title={c.opaque ? (c.note ?? t("fleets.capability.opaque")) : `${c.origin ?? "?"} / ${c.visibility ?? "?"} / ${c.scope ?? "?"}`}
              >
                {c.opaque ? <span className="italic text-muted-foreground">{t("fleets.capability.opaque")}</span> : c.name}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {(data.unresolvedSkills ?? []).length > 0 && (
        <div className="pt-1" data-testid="fleet-cap-unresolved">
          <div className="text-xs text-warning">{t("fleets.capability.unresolved")}</div>
          <ul className="mt-1 space-y-0.5">
            {(data.unresolvedSkills ?? []).map((u) => (
              <li key={u.name} className="text-[11px] text-muted-foreground">
                <span className="font-mono">{u.name}</span> — {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}