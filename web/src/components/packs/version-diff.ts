// ── 版本快照对比（pack-detail-as-page 3.3）───────────────────────────────────
//
// 「历史迭代详情」要回答的是：**这一版比上一版改了什么**。做法不是文本 diff——
// manifest 是结构化声明，文本 diff 会把「技能顺序变了」和「技能内容变了」混成
// 一片红绿。这里**按 manifest 的顶层结构逐项比**，值不同的项列出来。
//
// 边界（写进 UI 也要说明）：这是**按 manifest 声明**对比，不是按安装后的实际行为；
// 一个包在 manifest 里没声明的东西，两版之间当然比不出来。

export type ManifestShape = {
  name?: string;
  description?: string;
  roles?: number;
  skills?: number;
  mcpServers?: number;
  connectorBindings?: number;
  bots?: number;
  hasMemory?: boolean;
  hasConsole?: boolean;
  hasCluster?: boolean;
  hasFacade?: boolean;
};

/** 从一份 manifest 抽出可比的结构摘要。缺失就是缺失，不补默认值。 */
export function shapeOf(manifest: Record<string, unknown> | null | undefined): ManifestShape {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return {
    name: typeof m.name === "string" ? m.name : undefined,
    description: typeof m.description === "string" ? m.description : undefined,
    roles: len(m.agents),
    skills: len(m.skills),
    mcpServers: len(m.mcpServers),
    connectorBindings: len(m.connector_bindings),
    bots: len(m.bots),
    hasMemory: m.memory != null,
    hasConsole: m.console != null,
    hasCluster: m.cluster != null,
    hasFacade: m.facade != null,
  };
}

export type ShapeDiffRow = {
  field: keyof ManifestShape;
  before: string | number | boolean | undefined;
  after: string | number | boolean | undefined;
  changed: boolean;
};

/** 两个结构摘要逐字段比。`before` 是历史版，`after` 是当前版。 */
export function diffShape(before: ManifestShape, after: ManifestShape): ShapeDiffRow[] {
  const keys = Object.keys(after).concat(Object.keys(before).filter((k) => !(k in after))) as (keyof ManifestShape)[];
  return keys.map((field) => {
    const b = before[field];
    const a = after[field];
    return { field, before: b, after: a, changed: b !== a };
  });
}

/** 只保留变化项——「没变」的不该占用读者的注意力。 */
export function changedOnly(rows: ShapeDiffRow[]): ShapeDiffRow[] {
  return rows.filter((r) => r.changed);
}
