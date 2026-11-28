// ── 能力视图（capability-layer 的读面）────────────────────────────────────────
//
// 后端已经把每个 pack 的能力推导成一张条目表，每条带三轴（origin / visibility /
// scope）。在它之前，读者只能看到「技能」和「MCP」两个分桶，看不到「哪些是包给的、
// 哪些是 agent 自己长出来的」「哪些对匿名访客不可见」——而这些恰是租赁场景里
// 最先被问到的两件事。
//
// 三条呈现纪律：
//   · 不可见的能力**不是缺席**：服务端给的是 opaque 占位，这里如实画成一行
//     「由提供方维护」，而不是把它从列表里抹掉。抹掉会让读者以为这个包没有它。
//   · 三轴各自独立成一列，不合并成一句短语：同一个 agent 可以既有 shared 的连接、
//     又有 local 的自演化技能，合成「共享/本地」一个词就分不清是哪一条。
//   · 空表不渲染。一个没有任何能力的 pack 不该出现一个空章节。

import { useTranslation } from "react-i18next";
import type { PackCapability } from "@/lib/packs-api";

/** 能力大类的中文/本地化名。未知 kind 原样显示，不猜。 */
const KIND_LABEL_KEY: Record<string, string> = {
  skill: "packPage.capability.kind.skill",
  mcp: "packPage.capability.kind.mcp",
  bench: "packPage.capability.kind.bench",
};

const AXIS_LABEL_KEY = {
  origin: "packPage.capability.origin",
  visibility: "packPage.capability.visibility",
  scope: "packPage.capability.scope",
} as const;

const AXIS_VALUES: Record<string, Record<string, string>> = {
  origin: {
    pack: "packPage.capability.originValue.pack",
    team: "packPage.capability.originValue.team",
    agent: "packPage.capability.originValue.agent",
    evolved: "packPage.capability.originValue.evolved",
  },
  visibility: {
    private: "packPage.capability.visibilityValue.private",
    tenant: "packPage.capability.visibilityValue.tenant",
    public: "packPage.capability.visibilityValue.public",
  },
  scope: {
    shared: "packPage.capability.scopeValue.shared",
    pinned: "packPage.capability.scopeValue.pinned",
    local: "packPage.capability.scopeValue.local",
  },
};

function Axis({ axis, value }: { axis: keyof typeof AXIS_LABEL_KEY; value?: string | null }) {
  const { t } = useTranslation();
  const key = value ? AXIS_VALUES[axis]?.[value] : null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <span className="opacity-70">{t(AXIS_LABEL_KEY[axis])}</span>
      <span className="rounded-sm bg-muted px-1 py-px">
        {/* 未知取值原样显示：把没见过的值映射成「未知」会掩盖服务端新增的轴值 */}
        {key ? t(key) : (value ?? t("packPage.capability.unset"))}
      </span>
    </span>
  );
}

export function CapabilitySection({
  capabilities,
  testId = "pack-capabilities",
  anchor,
}: {
  capabilities: PackCapability[] | null | undefined;
  testId?: string;
  /** 章节锚点：详情页左栏的导航项靠它跳转。 */
  anchor?: string;
}) {
  const { t } = useTranslation();
  const rows = Array.isArray(capabilities) ? capabilities : [];
  if (rows.length === 0) return null;

  // 按 kind 分组，组的顺序按首次出现——服务端已经按 skills → mcp → bench 给过一次，
  // 这里不重排，免得两处顺序各说一套。
  const groups = new Map<string, PackCapability[]>();
  for (const c of rows) {
    const k = c.kind ?? "other";
    const list = groups.get(k) ?? [];
    list.push(c);
    groups.set(k, list);
  }

  return (
    <section data-section={anchor} data-testid={testId} className="mt-8">
      <h2 className="mb-1 text-lg font-semibold">{t("packPage.capability.title")}</h2>
      <p className="mb-3 text-xs text-muted-foreground">{t("packPage.capability.intro")}</p>
      <div className="space-y-4">
        {[...groups.entries()].map(([kind, list]) => (
          <div key={kind}>
            <div className="mb-1.5 flex items-baseline gap-2 text-xs font-medium">
              <span>{KIND_LABEL_KEY[kind] ? t(KIND_LABEL_KEY[kind]) : kind}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{list.length}</span>
            </div>
            <ul className="space-y-1">
              {list.map((c, i) => (
                <li
                  key={`${kind}:${c.name ?? `opaque-${i}`}`}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border px-2.5 py-1.5"
                  data-testid={`${testId}-row-${c.opaque ? `opaque-${i}` : c.name}`}
                >
                  {c.opaque ? (
                    // 占位：有这个能力但当前读者看不见。如实说「由提供方维护」，
                    // 不显示名字（服务端也不给），更不整行删掉。
                    <span className="text-xs italic text-muted-foreground">
                      {c.note ?? t("packPage.capability.opaque")}
                    </span>
                  ) : (
                    <>
                      <span className="font-mono text-xs text-foreground">{c.name}</span>
                      <Axis axis="origin" value={c.origin} />
                      <Axis axis="visibility" value={c.visibility} />
                      <Axis axis="scope" value={c.scope} />
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
