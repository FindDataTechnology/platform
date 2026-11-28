// ── 外部系统表（overhaul-pack-detail-presentation D4）─────────────────────────
//
// 输入是 manifest 的 `connector_bindings[]`，发布前让客户看清「这个包要用到你
// 自己的哪些系统、碰什么、要不要写权限、凭据谁出」。
//
// 为什么从行内散文改成表：原来把 surface / direction / credential / note 用
// ` · ` 连成一句，五个系统读下来是一段话，读者无法跨系统比较「哪个需要写权限」。
// 三列以上的同构数据，表格才是对的形状；`note` 是自由文本，独占整行。
//
// 窄屏（<640px）退化为每行一张卡：五列表格在 390px 必然横向滚动，而
// facet/web/DESIGN.md §8 要求窄屏不出现横向滚动。

import { useTranslation } from "react-i18next";
import type { SpecBinding } from "@/components/packs/AgentSpecSheet";

/** 一个绑定的读面事实。缺就是缺——不补默认值。 */
function fields(b: SpecBinding): {
  system: string;
  surface: string;
  direction: string;
  credential: string;
  required: boolean;
} {
  const ops = (b.allowOperations ?? [])
    .map((op) => (typeof op === "string" ? op : op.operationType))
    .filter(Boolean);
  return {
    system: b.external_system ?? (b.provider || b.key),
    surface: (b.surface ?? "").trim(),
    // 方向优先用作者写的；没写才用 allowOperations 折出来的读写集合。
    direction: (b.direction ?? ops.join(" + ")).trim(),
    credential: (b.credential ?? "").trim(),
    required: b.optional !== true,
  };
}

export function ConnectorTable({ bindings, testId }: { bindings: SpecBinding[]; testId: string }) {
  const { t } = useTranslation();
  if (!bindings || bindings.length === 0) return null;

  const rows = bindings.map((b) => ({ key: b.key, raw: b, f: fields(b) }));

  return (
    <div data-testid={testId}>
      {/* 宽屏：真表格。关键列标了表头，读者可以逐列比较。 */}
      <table className="hidden w-full table-fixed border-collapse text-xs sm:table" data-testid={`${testId}-table`}>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="w-[20%] border-b border-border py-1.5 pr-2 font-normal">
              {t("packs.specSheet.bindingSystem")}
            </th>
            <th scope="col" className="w-[34%] border-b border-border py-1.5 pr-2 font-normal">
              {t("packs.specSheet.bindingSurface")}
            </th>
            <th scope="col" className="w-[20%] border-b border-border py-1.5 pr-2 font-normal">
              {t("packs.specSheet.bindingDirection")}
            </th>
            <th scope="col" className="w-[16%] border-b border-border py-1.5 pr-2 font-normal">
              {t("packs.specSheet.bindingCredential")}
            </th>
            <th scope="col" className="w-[10%] border-b border-border py-1.5 font-normal">
              {t("packs.specSheet.bindingRequired")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, raw, f }) => (
            <tr key={key} className="align-top" data-testid={`${testId}-${key}`}>
              <td className="border-b border-border/40 py-2 pr-2">
                <div className="text-foreground">{f.system}</div>
                <div className="font-mono text-muted-foreground" data-testid={`${testId}-machine-${key}`}>{key}</div>
              </td>
              <td className="border-b border-border/40 py-2 pr-2 text-muted-foreground">
                {f.surface || t("packs.specSheet.memoryValue.empty")}
                {raw.note && (
                  <p className="mt-1 leading-snug text-muted-foreground/80">{raw.note}</p>
                )}
              </td>
              <td className="border-b border-border/40 py-2 pr-2 text-muted-foreground">
                {f.direction || t("packs.specSheet.memoryValue.empty")}
              </td>
              <td className="border-b border-border/40 py-2 pr-2 text-muted-foreground">
                {f.credential || t("packs.specSheet.memoryValue.empty")}
              </td>
              <td className="border-b border-border/40 py-2 text-muted-foreground">
                {/* 旧锚点只在「可选」时存在（e2e 用它断言必填项没有这枚标记）；
                    必填项改成纯文本，不新增锚点。 */}
                {f.required ? (
                  t("packs.specSheet.bindingRequired")
                ) : (
                  <span data-testid={`${testId}-optional-${key}`}>{t("packs.specSheet.bindingOptional")}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 窄屏：每行一张卡。字段名在上、值在下，避免任何横向滚动。 */}
      <ul className="space-y-2 sm:hidden" data-testid={`${testId}-cards`}>
        {rows.map(({ key, raw, f }) => (
          <li key={key} className="rounded-md border border-border/60 bg-background/60 px-3 py-2" data-testid={`${testId}-card-${key}`}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm text-foreground">{f.system}</span>
              <span className="font-mono text-muted-foreground">{key}</span>
              <span className="ml-auto text-muted-foreground">
                {f.required ? t("packs.specSheet.bindingRequired") : t("packs.specSheet.bindingOptional")}
              </span>
            </div>
            <dl className="mt-1 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
              {f.surface && (
                <>
                  <dt className="text-muted-foreground">{t("packs.specSheet.bindingSurface")}</dt>
                  <dd className="text-foreground">{f.surface}</dd>
                </>
              )}
              {f.direction && (
                <>
                  <dt className="text-muted-foreground">{t("packs.specSheet.bindingDirection")}</dt>
                  <dd className="text-foreground">{f.direction}</dd>
                </>
              )}
              {f.credential && (
                <>
                  <dt className="text-muted-foreground">{t("packs.specSheet.bindingCredential")}</dt>
                  <dd className="text-foreground">{f.credential}</dd>
                </>
              )}
            </dl>
            {raw.note && <p className="mt-1 text-xs leading-snug text-muted-foreground">{raw.note}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default ConnectorTable;
