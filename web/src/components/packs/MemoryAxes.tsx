// ── 记忆四轴（overhaul-pack-detail-presentation D2）───────────────────────────
//
// 输入是 `derivePillars()` 的 `memory.rows`（server lib/pack-pillars.js），
// 唯一派生点，本文件只做呈现、不二次派生。
//
// 为什么不是一张键值表：原来的 `<dl>` 把七个点号键平铺成七行，回答的是
// 「manifest 里写了什么」；读者问的是四件不同的事——存在哪 / 读什么 / 谁能写 /
// 怎么老化。同一个答案换一种排布就变成了回答读者。
//
// 三个可见态，**不合并**（这是本组件的全部价值）：
//   · 作者声明   declared !== null            → 生效值 + 来源级别
//   · 平台默认   declared === null            → 生效值 + 「平台默认」
//   · 未执行     executed === false 且已声明  → 上面任一态再加「未执行」
// 把「平台默认」印成作者声明，读者会把默认值当成这个包的设计意图；把 `null`
// 印出来，读者会以为数据坏了。

import { useTranslation } from "react-i18next";
import type { SpecPillars } from "@/lib/packs-api";

/** 渲染顺序即阅读顺序：四轴按这个次序，与 `MEMORY_AXES` 的声明序一致。 */
const AXIS_ORDER = ["store", "read", "write", "process"] as const;

type Row = NonNullable<SpecPillars["memory"]["rows"]>[string];

/** 一个值怎么念。`null` 不念成 "null"——它要么是未设置，要么被平台默认填上了。
 *
 *  枚举值的闭集（STORE_HOMES / READ_SCOPES / WRITE_AUTHORITIES / DISTILL_VALUES，
 *  见 lib/pack-memory.js）翻译成人话：`own+shared` 是机器标识，不是句子
 *  （overhaul-pack-detail-presentation「不得把枚举成员当主文本」）。 */
function readValue(sub: string, value: unknown, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (value === null || value === undefined) return t("packs.specSheet.memoryValue.empty");
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    // `cold_after_days: 0` 在语义上是「不冷却」，不是一个 0。
    if (sub === "process.cold_after_days" && value === 0) return t("packs.specSheet.memoryValue.process.cold_after_days");
    return String(value);
  }
  const raw = String(value);
  // 只有闭集里的枚举成员才有人话翻译；自由文本原样。
  return t(`packs.specSheet.memoryValueLabel.${sub}.${raw}`, { defaultValue: raw });
}

export function MemoryAxes({
  rows,
  testId,
}: {
  rows: Record<string, Row>;
  testId: string;
}) {
  const { t } = useTranslation();

  if (!rows || Object.keys(rows).length === 0) return null;

  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid={testId}>
      {AXIS_ORDER.map((axis) => {
        const entries = Object.entries(rows).filter(([sub]) => sub.startsWith(`${axis}.`));
        if (entries.length === 0) return null;
        return (
          <section
            key={axis}
            className="rounded-md border border-border/60 bg-background/60 p-3"
            data-testid={`${testId}-${axis}`}
          >
            <h5 className="text-xs font-medium text-foreground">{t(`packs.specSheet.memoryAxis.${axis}`)}</h5>
            <dl className="mt-1.5 space-y-1">
              {entries.map(([sub, row]) => {
                const declared = row.declared !== null && row.declared !== undefined;
                const differs = declared && String(row.declared) !== String(row.effective);
                // 来源判据用 `inherited_from`，不是「declared 为空」——两者不等价：
                // `write.authority` 平台**没有默认值**（inherited_from=null, effective=null），
                // 按 declared 判会把它误标成「平台默认」（2026-11-24 线上实见）。
                const fromPlatform = row.inherited_from === "platform";
                const fromRole = row.inherited_from === "agent";
                const unexecuted = declared && row.executed === false;
                // 既非作者声明、也非任何来源：这一项根本没有值，如实标「未设置」。
                const unset = !declared && !fromPlatform && !fromRole && (row.effective === null || row.effective === undefined);
                return (
                  <div key={sub} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
                    <dt className="text-muted-foreground">{t(`packs.specSheet.memorySubkey.${sub}`)}</dt>
                    <dd className={differs ? "text-warning" : "text-foreground"}>
                      {readValue(sub, row.effective, t)}
                    </dd>
                    {differs && (
                      <dd className="text-muted-foreground" data-testid={`${testId}-diverged-${sub}`}>
                        {t("packs.specSheet.memoryDeclaredWas", { v: readValue(sub, row.declared, t) })}
                      </dd>
                    )}
                    {fromPlatform && (
                      <dd className="text-muted-foreground" data-testid={`${testId}-platform-${sub}`}>
                        {t("packs.specSheet.memoryFromPlatform")}
                      </dd>
                    )}
                    {fromRole && (
                      <dd className="text-muted-foreground" data-testid={`${testId}-role-${sub}`}>
                        {t("packs.specSheet.memoryFromRole")}
                      </dd>
                    )}
                    {unset && (
                      <dd className="text-muted-foreground" data-testid={`${testId}-unset-${sub}`}>
                        {t("packs.specSheet.memoryUnset")}
                      </dd>
                    )}
                    {unexecuted && (
                      <dd
                        className="rounded-sm bg-warning/15 px-1 py-px text-warning"
                        data-testid={`${testId}-unexecuted-${sub}`}
                      >
                        {t("packs.specSheet.memoryUnexecuted")}
                      </dd>
                    )}
                  </div>
                );
              })}
            </dl>
          </section>
        );
      })}
    </div>
  );
}

export default MemoryAxes;
