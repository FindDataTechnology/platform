// 事项接入与证据面 (widen-deputy-to-personal-domains 6.1/6.2)。
//
// 两个问题合成一个分区，因为它们回答同一件事：「代理现在凭什么替我判断」。
//   · 事项接入：哪类事项进哪个域（默认全关）；
//   · 证据面：每域的行为一致率与样本量——没有这个数字，升不升「先做后报」
//     只能凭感觉。
//
// 开关只决定「进不进得来」，能不能自主仍由委托状（上一个分区）决定。这句话
// 必须写在界面上：否则关掉一个开关看起来像降权，其实只影响有没有事项进来。
//
// 判例候选不做在这里：它是舰队级的（`/:id/precedent-candidates`），本分区是
// cell 级、没有 fleetId。放一个永远读不到数据的面板，等于让人以为「没有待审
// 候选」，而真相是「没接上」——候选审阅在舰队控制台。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type Mapping = { source: string; domain: string; enabled: boolean };
type Stats = { samples: number; agrees: number; rate: number | null };

type ReadinessItem = { id: string; severity: "blocked" | "warn"; ok: boolean; title: string; detail: string; fix: string };
type Readiness = { ready: boolean; blocked: number; warns: number; verdict: string; items: ReadinessItem[] };

const SOURCES = ["cross-line-blocker", "supplier-thread", "people-schedule"] as const;
const LEVELS = ["public", "internal", "confidential", "hr", "finance"] as const;

export function MandateIntakeSection() {
  const { t } = useTranslation();
  const [map, setMap] = useState<Mapping[] | null>(null);
  const [consistency, setConsistency] = useState<Record<string, Stats>>({});
  const [levelSamples, setLevelSamples] = useState<Record<string, number>>({});
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const policyRes = await fetch("/api/fleets/delegation-policy");
      const policyBody = await policyRes.json().catch(() => ({}));
      if (!policyRes.ok) throw new Error(policyBody.error ?? `read ${policyRes.status}`);
      setMap(Array.isArray(policyBody.domainMap) ? policyBody.domainMap : []);
      setConsistency(policyBody.consistency ?? {});
      setLevelSamples(policyBody.levelSamples ?? {});
      const rRes = await fetch("/api/fleets/personal-agent/readiness");
      if (rRes.ok) setReadiness(await rRes.json().catch(() => null));
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (source: string) => {
    if (!map) return;
    const next = map.map((m) => (m.source === source ? { ...m, enabled: !m.enabled } : m));
    setMap(next);
    setBusy(true);
    setError(null);
    try {
      // 走同一条 PUT：domainMap 与 mandate 同一个读写面，避免两处配置漂移。
      const r = await fetch("/api/fleets/delegation-policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "cell", domainMap: next }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `write ${r.status}`);
      if (Array.isArray(body.domainMap)) setMap(body.domainMap);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const pct = (rate: number | null) => (rate === null ? null : `${Math.round(rate * 100)}%`);

  if (error && !map) {
    return <p className="text-sm text-destructive" data-testid="mandate-intake-error">{error}</p>;
  }
  if (!map) return <p className="text-sm text-muted-foreground" data-testid="mandate-intake-loading">…</p>;

  return (
    <div className="flex flex-col gap-6" data-testid="mandate-intake-section">
      <p className="text-sm text-muted-foreground">{t("settings.mandate.intake.hint")}</p>

      {/* 就绪结论：七个开关分散在三处，配错的表现是「代理很安静」——和「没配好」
          一模一样。这里先给一句结论，再给每条修法。 */}
      {readiness ? (
        <div
          data-testid="mandate-readiness"
          data-ready={readiness.ready ? "1" : "0"}
          className={
            readiness.ready
              ? "rounded-lg border border-border bg-muted px-3 py-2 text-sm"
              : "rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
          }
        >
          <div className="font-medium">{readiness.verdict}</div>
          <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
            {readiness.items.filter((i) => !i.ok).slice(0, 4).map((i) => (
              <li key={i.id} data-testid={`mandate-readiness-${i.id}`}>
                {i.severity === "blocked" ? "✗" : "!"} {i.title} — {i.fix}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive" data-testid="mandate-intake-write-error">{error}</p> : null}

      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {SOURCES.map((source) => {
          const entry = map.find((m) => m.source === source);
          const enabled = entry?.enabled === true;
          return (
            <li
              key={source}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              data-testid={`mandate-intake-row-${source}`}
            >
              <span>{t(`settings.mandate.intake.source.${source}`)}</span>
              <span className="text-xs text-muted-foreground">
                {t("settings.mandate.intake.targetDomain")}: {entry?.domain ?? "—"}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                disabled={busy}
                data-testid={`mandate-intake-toggle-${source}`}
                onClick={() => void toggle(source)}
                className={
                  enabled
                    ? "rounded-full border border-primary bg-primary px-3 py-1 text-xs text-primary-foreground"
                    : "rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground"
                }
              >
                {t("settings.mandate.intake.enable")}
              </button>
            </li>
          );
        })}
      </ul>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t("settings.mandate.intake.levelSamples")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings.mandate.intake.levelSamplesHint")}</p>
        <ul className="flex flex-col gap-1 text-sm">
          {LEVELS.map((level) => {
            const n = levelSamples[level] ?? 0;
            const ready = n >= 20;
            return (
              <li key={level} className="flex items-baseline justify-between gap-2" data-testid={`mandate-level-${level}`}>
                <span>{t(`settings.mandate.level.${level}`)}</span>
                <span className={ready ? "text-xs text-muted-foreground" : "text-xs text-warning"} data-testid={`mandate-level-state-${level}`}>
                  {n} · {ready ? t("settings.mandate.intake.levelReady") : t("settings.mandate.intake.levelMissing")}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t("settings.mandate.intake.consistency")}</h3>
        <ul className="flex flex-col gap-1 text-sm">
          {Object.entries(consistency).map(([domain, stats]) => {
            const value = pct(stats?.rate ?? null);
            const enough = (stats?.samples ?? 0) >= 20 && (stats?.rate ?? 0) >= 0.8;
            return (
              <li key={domain} className="flex flex-wrap items-baseline justify-between gap-2" data-testid={`mandate-consistency-${domain}`}>
                <span>{t(`settings.mandate.domain.${domain}`, { defaultValue: domain })}</span>
                <span className="text-xs text-muted-foreground">
                  {value === null
                    ? t("settings.mandate.intake.consistencyNone")
                    : t("settings.mandate.intake.consistencyValue", { rate: value, samples: stats.samples })}
                </span>
                {!enough ? (
                  <span className="text-xs text-warning" data-testid={`mandate-cannot-promote-${domain}`}>
                    {t("settings.mandate.intake.cannotPromote")}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

    </div>
  );
}
