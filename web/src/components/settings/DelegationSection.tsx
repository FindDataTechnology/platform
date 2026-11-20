// 委托策略设置面 (add-deputy-decision-delegate 5.2)：
// cell 级默认的编辑入口——类别路由、严重度上限、日预算。舰队覆写在舰队页的
// 拍板抽屉里做（那里有上下文）。写走 PUT /api/fleets/delegation-policy，
// 归一化即硬闸：config-change/hr/spend 写进来也会被服务端归一为 owner。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type Policy = {
  enabled: boolean;
  routes: Record<string, string>;
  maxSeverity: "low" | "normal" | "high";
  dailyBudget: number;
  digest: "daily" | "weekly" | "off";
  model: string | null;
};

const CATEGORIES = ["routine-ops", "infra-ticket", "config-change", "hr", "spend"];

export function DelegationSection() {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/fleets/delegation-policy");
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `read ${r.status}`);
      setPolicy(body.effective ?? null);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (next: Policy) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/fleets/delegation-policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "cell", policy: next }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `write ${r.status}`);
      setPolicy(body.effective ?? next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !policy) {
    return <p className="text-sm text-destructive" data-testid="delegation-error">{error}</p>;
  }
  if (!policy) return <p className="text-sm text-muted-foreground" data-testid="delegation-loading">…</p>;

  const patch = (part: Partial<Policy>) => setPolicy({ ...policy, ...part });

  return (
    <div className="flex flex-col gap-4" data-testid="delegation-section">
      <p className="text-sm text-muted-foreground">{t("settings.delegation.hint")}</p>
      {error ? <p className="text-sm text-destructive" data-testid="delegation-write-error">{error}</p> : null}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={policy.enabled}
          data-testid="delegation-enabled"
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        {t("settings.delegation.enabled")}
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t("settings.delegation.routes")}</span>
        {CATEGORIES.map((cat) => {
          // 归一化即硬闸：这三类服务端永远归一为 owner——UI 直接置灰说明。
          const hardLocked = cat === "config-change" || cat === "hr" || cat === "spend";
          const value = hardLocked ? "owner" : (policy.routes[cat] ?? policy.routes.default ?? "owner");
          return (
            <label key={cat} className="flex items-center justify-between gap-2 text-sm">
              <span className={hardLocked ? "text-muted-foreground" : ""}>
                {t(`settings.delegation.category.${cat}`)}
                {hardLocked ? ` · ${t("settings.delegation.ownerOnly")}` : ""}
              </span>
              <select
                disabled={hardLocked || busy}
                data-testid={`delegation-route-${cat}`}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                value={value}
                onChange={(e) => patch({ routes: { ...policy.routes, [cat]: e.target.value } })}
              >
                <option value="owner">{t("settings.delegation.routeOwner")}</option>
                {!hardLocked ? <option value="deputy">{t("settings.delegation.routeDeputy")}</option> : null}
                {cat === "infra-ticket" ? <option value="deputy-triage">{t("settings.delegation.routeTriage")}</option> : null}
              </select>
            </label>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("settings.delegation.maxSeverity")}</span>
          <select
            data-testid="delegation-max-severity"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={policy.maxSeverity}
            onChange={(e) => patch({ maxSeverity: e.target.value as Policy["maxSeverity"] })}
          >
            <option value="low">{t("fleets.decisions.severity.low")}</option>
            <option value="normal">{t("fleets.decisions.severity.normal")}</option>
            <option value="high">{t("fleets.decisions.severity.high")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("settings.delegation.dailyBudget")}</span>
          <input
            type="number"
            min={1}
            data-testid="delegation-daily-budget"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={policy.dailyBudget}
            onChange={(e) => patch({ dailyBudget: Math.max(1, Number(e.target.value) || 1) })}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("settings.delegation.digest")}</span>
          <select
            data-testid="delegation-digest"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={policy.digest}
            onChange={(e) => patch({ digest: e.target.value as Policy["digest"] })}
          >
            <option value="daily">{t("settings.delegation.digestDaily")}</option>
            <option value="weekly">{t("settings.delegation.digestWeekly")}</option>
            <option value="off">{t("settings.delegation.digestOff")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("settings.delegation.model")}</span>
          <input
            type="text"
            data-testid="delegation-model"
            placeholder={t("settings.delegation.modelInherit")}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={policy.model ?? ""}
            onChange={(e) => patch({ model: e.target.value.trim() || null })}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t("settings.delegation.modelHint")}</p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="delegation-save"
          disabled={busy}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          onClick={() => void save(policy)}
        >
          {t("settings.delegation.save")}
        </button>
        {saved ? (
          <span className="text-sm text-muted-foreground" data-testid="delegation-saved">
            {t("settings.delegation.saved")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
