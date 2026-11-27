// ── 声明契约的两个渲染器（surface-team-contract-on-console D2）────────────────
//
// `acceptance[]` 与 `monitoring` 是 pack 在**发布时冻结的声明**。它们在三个面
// 出现：市场详情页（订阅前看清）、壹座舰队页控制台、谦面分享控制台。三处必须
// 同形同词——同一份声明在两个页面用两套渲染，词汇（`post-materialized` 的中文名）、
// 顺序、缺省文案都会漂。
//
// 所以这两个组件只存在于这里，消费方只 import。`scripts/test-contract-sections-shared.mjs`
// 钉住这一点。
//
// 词汇来源：`packs.specSheet.assertion.*` / `monitoringSeverityValue.*`。控制台契约区
// 复用同一组键，不新造一套（见该 change 的 tasks 4.2）。

import { useTranslation } from "react-i18next";
import type { PackManifest, SpecTeam } from "@/lib/packs-api";

/** 一条验收断言。`rubric` 永远不在这里——`deriveAcceptance()` 只投 kind/target/expect。 */
export function AcceptanceSection({ acceptance, testId, anchor }: {
  acceptance: NonNullable<SpecTeam["acceptance"]>;
  testId: string;
  anchor?: string;
}) {
  const { t } = useTranslation();
  return (
    <section data-testid={testId} data-section={anchor}>
      <h2 className="mb-2 font-medium">{t("packs.specSheet.acceptance")}</h2>
      <ul className="space-y-1">
        {acceptance.map((a) => (
          <li key={a.id} className="flex flex-wrap items-baseline gap-2 text-xs" data-testid={`${testId}-${a.id}`}>
            <span className="text-foreground">{t(`packs.specSheet.assertion.${a.kind}`, { defaultValue: a.kind })}</span>
            <span className="text-muted-foreground">
              {t("packs.specSheet.acceptanceTarget", { target: a.target ?? t("packs.specSheet.acceptanceAnyPost") })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 「什么算异常、什么时候升级、通知走哪」——三件都是本仓真实事故换来的
 * （`lib/monitoring-spec.js` 头注）。
 *
 * `monitoring.notify` 在 share 面由**服务端**裁掉（surface-team-contract-on-console
 * D3）；这个组件不判断 surface——它渲染什么就是响应里有什么。
 */
export function MonitoringSection({ monitoring, testId, anchor }: {
  monitoring: NonNullable<PackManifest["monitoring"]>;
  testId: string;
  anchor?: string;
}) {
  const { t } = useTranslation();
  const criteria = monitoring.anomaly_criteria ?? [];
  const threshold = monitoring.escalate?.threshold ?? "";
  const severity = monitoring.escalate?.severity_default;
  return (
    <section data-testid={testId} data-section={anchor}>
      <h2 className="mb-2 font-medium">{t("packs.specSheet.monitoring")}</h2>
      {criteria.length > 0 && (
        <>
          <p className="text-xs font-medium text-muted-foreground">{t("packs.specSheet.monitoringCriteria")}</p>
          <ul className="mb-2 mt-0.5 space-y-0.5">
            {criteria.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 判据是自由文本，可能完全重复；索引是这一行唯一稳定的身份。
              <li key={`${i}-${c.slice(0, 12)}`} className="text-xs leading-5 text-foreground">· {c}</li>
            ))}
          </ul>
        </>
      )}
      {threshold && (
        <p className="text-xs text-foreground">
          <span className="text-muted-foreground">{t("packs.specSheet.monitoringEscalate")}</span> — {threshold}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {severity && (
          <span data-testid={`${testId}-severity`}>
            {t("packs.specSheet.monitoringSeverity", { severity: t(`packs.specSheet.monitoringSeverityValue.${severity}`, { defaultValue: severity }) })}
          </span>
        )}
        {monitoring.notify && (
          <span data-testid={`${testId}-notify`}>{t("packs.specSheet.monitoringNotify", { channel: monitoring.notify })}</span>
        )}
      </div>
    </section>
  );
}
