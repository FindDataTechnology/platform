// ── 素材目录的物种适配（unify-material-catalog-page 1.x）─────────────────────
//
// 目录页要在一个视图里呈现六个物种，而它们的端点各有一套形状：
//
//   pack          /api/marketplace/marketplace.json → { plugins: [{name, description, category, ...}] }
//   mcp           /api/mcp-catalog                  → { servers: [{name, displayName, endpoint, ...}] }
//   skill         /api/skills-catalog               → { skills:  [{name, displayName, repositoryUrl, ...}] }
//   facade        /api/facades-catalog              → { facades: [{id, name, runnable, deployment, ...}] }
//   data-anchor   /api/data-anchors-catalog         → { anchors: [{id, name, kind, summary, annotation}] }
//   plugin        （暂未接入目录页；枚举里保留）
//
// 这个文件只做一件事：把每种形状映射到同一个 `CatalogItem`。**它不发明字段**——
// 源里没有的就是 null，由 UI 决定怎么如实呈现。这一点是刻意的：目录页最容易犯的错
// 是给缺失的字段编一个默认值，让「源没给」看起来像「源给了空」。
//
// 纯函数，可在 node 下直接测（.ts 而非 .tsx，理由同 gallery-model.ts）。

export type Species = "pack" | "skill" | "mcp" | "facade" | "data-anchor" | "plugin";

/** 一个物种在目录页里怎么被取、被叫、被展示。 */
export type SpeciesSpec = {
  species: Species;
  /** 相对站点根的端点。 */
  endpoint: string;
  /** 响应里装条目数组的那个键。 */
  listKey: string;
  /** 该物种有没有深度视图（只有 mcp 与 skill 有）。 */
  hasDepth: boolean;
};

export const SPECIES_SPECS: SpeciesSpec[] = [
  { species: "pack", endpoint: "/api/marketplace/marketplace.json", listKey: "plugins", hasDepth: false },
  { species: "skill", endpoint: "/api/skills-catalog", listKey: "skills", hasDepth: true },
  { species: "mcp", endpoint: "/api/mcp-catalog", listKey: "servers", hasDepth: true },
  { species: "facade", endpoint: "/api/facades-catalog", listKey: "facades", hasDepth: false },
  { species: "data-anchor", endpoint: "/api/data-anchors-catalog", listKey: "anchors", hasDepth: false },
];

export function specFor(species: Species): SpeciesSpec | undefined {
  return SPECIES_SPECS.find((s) => s.species === species);
}

/** 目录页的公共卡片形状。字段缺失就是 null，绝不补默认值。 */
export type CatalogItem = {
  /** 在目录页内唯一（物种前缀 + 源 id）。 */
  key: string;
  species: Species;
  /** 稳定标识（详情/深度视图要用）。 */
  id: string;
  /** 展示名。 */
  title: string;
  /** 一句话描述。 */
  summary: string;
  /** 角标：官方 / 已部署 / 类别等。 */
  badges: string[];
  /** 详情或机器可读页的目的地（无则 null）。 */
  href: string | null;
  /** 有深度视图的物种才有（mcp / skill）。 */
  depth: boolean;
  /** 该条目存在但尚未运行（facade 的 undeployed）：卡片要显式标出来，否则
   *  它和「正在服务」长得一样，访客点开才发现聊不了。不影响它被列出——
   *  supply-catalog 既有要求写明未部署的 agent 必须以 undeployed facade 出现。 */
  notRunning?: boolean;
  /** 有详情页可跳的物种（pack）：目录页链到 `#/packs/<id>`，与市场同一个地址。 */
  detail: boolean;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const firstStr = (...vs: unknown[]): string => {
  for (const v of vs) {
    const s = str(v);
    if (s) return s;
  }
  return "";
};

/** 把一条源记录映射成目录卡片。species 决定读哪几个字段。 */
export function toCatalogItem(species: Species, raw: Record<string, unknown>): CatalogItem | null {
  if (!raw || typeof raw !== "object") return null;

  const spec = specFor(species);
  const depth = spec?.hasDepth ?? false;

  switch (species) {
    case "pack": {
      const name = firstStr(raw.name);
      if (!name) return null;
      return {
        key: `pack:${name}`,
        species,
        id: name,
        title: name,
        summary: firstStr(raw.description),
        badges: [firstStr(raw.category)].filter(Boolean),
        // 目录页就地打开详情（catalog-owns-browse-market-owns-trade D2）：
        // 以前链到 #/packs 会把访客甩出目录、丢掉浏览位置。
        href: null,
        depth: false,
        detail: true,
      };
    }
    case "mcp": {
      const name = firstStr(raw.name);
      if (!name) return null;
      const ann = (raw.annotation ?? {}) as Record<string, unknown>;
      return {
        key: `mcp:${name}`,
        species,
        id: name,
        title: firstStr(ann.name, raw.displayName, name),
        summary: firstStr(ann.summary, raw.description),
        badges: Array.isArray(raw.requiredGroups) && raw.requiredGroups.length ? ["受限"] : [],
        href: null,
        depth,
        detail: false,
      };
    }
    case "skill": {
      const name = firstStr(raw.name);
      if (!name) return null;
      const ann = (raw.annotation ?? {}) as Record<string, unknown>;
      return {
        key: `skill:${name}`,
        species,
        id: name,
        title: firstStr(ann.name, raw.displayName, name),
        summary: firstStr(ann.summary, raw.description),
        badges: Array.isArray(raw.tags) ? (raw.tags as unknown[]).map(str).filter(Boolean).slice(0, 2) : [],
        href: firstStr(raw.repositoryUrl) || null,
        depth,
        detail: false,
      };
    }
    case "facade": {
      const id = firstStr(raw.id, raw.slug, raw.name);
      if (!id) return null;
      const d = (raw.deployment ?? {}) as Record<string, unknown>;
      const state = firstStr(d.state);
      return {
        key: `facade:${id}`,
        species,
        id,
        title: firstStr(raw.name, id),
        summary: firstStr(raw.description),
        // 部署状态如实显示；未知就不给角标，不写「运行中」这种编造的乐观值。
        // undeployed 不再混进徽标（那里原是中文硬编码，五语下也显示中文）——
        // 它单独成 notRunning 标记，由 UI 用当前语言的标签显式呈现。
        badges: [firstStr(raw.runnable), state && state !== "undeployed" ? state : ""].filter(Boolean),
        // 无 deployment 记录也读作「未运行」——缺记录不等于正在服务。
        notRunning: state !== "serving" && state !== "idle",
        href: null,
        depth: false,
        detail: false,
      };
    }
    case "data-anchor": {
      const id = firstStr(raw.id, raw.name);
      if (!id) return null;
      const ann = (raw.annotation ?? {}) as Record<string, unknown>;
      return {
        key: `anchor:${id}`,
        species,
        id,
        title: firstStr(ann.name, raw.name, id),
        summary: firstStr(ann.summary, raw.summary),
        badges: [firstStr(raw.kind)].filter(Boolean),
        href: null,
        depth: false,
        detail: false,
      };
    }
    default:
      return null;
  }
}

/** 把一个端点的响应体映射成卡片数组；形状不符时返回空的并报出原因。 */
export type MapOutcome = {
  items: CatalogItem[];
  error: string | null;
  /**
   * 端点自己声明了「这个物种的源没有接入」（`source_absent: true`）。
   * 它与「源接入了但此刻是 0 条」是**两件事**，UI 必须分开说：
   * 前者是部署缺配置，后者是内容为空。混成一句「暂时没有条目」会把
   * 一个配置故障说成正常状态——这正是本仓反复记的那类假绿。
   */
  sourceAbsent: boolean;
};

export function mapResponse(species: Species, body: unknown): MapOutcome {
  const spec = specFor(species);
  if (!spec) return { items: [], error: `unknown species: ${species}`, sourceAbsent: false };
  if (!body || typeof body !== "object") {
    return { items: [], error: "response is not an object", sourceAbsent: false };
  }
  const obj = body as Record<string, unknown>;
  const sourceAbsent = obj.source_absent === true;
  const list = obj[spec.listKey];
  if (!Array.isArray(list)) {
    return { items: [], error: `response carries no "${spec.listKey}" array`, sourceAbsent };
  }
  const items: CatalogItem[] = [];
  for (const raw of list) {
    const item = toCatalogItem(species, raw as Record<string, unknown>);
    if (item) items.push(item);
  }
  return { items, error: null, sourceAbsent };
}

// ── 数据锚的分层（facet-catalog-species-curation D1 / 2.3）────────────────────
//
// 数据锚混合了两种东西：22 个数据源（「寻数有什么数据」的答案）与 461 个单项
// 指标（SPY_ma5 这类，给机器挂靠用）。前者是逛点，后者不是。
//
// 这个函数只回答「默认该列哪些、折起哪些」，**不删任何条目**——端点与机器面
// 仍返回全量；是否展开由调用方决定。纯函数，可在 node 下测。
export type AnchorSplit = { sources: CatalogItem[]; indicators: CatalogItem[] };

/** 按 kind 把数据锚切成「源」与「指标」两组。kind 落在 badges 里（见上面
 *  data-anchor 分支）。非数据锚物种返回 null——分层只对这一个物种有意义。 */
export function splitAnchors(species: Species | "all", items: CatalogItem[]): AnchorSplit | null {
  if (species !== "data-anchor") return null;
  const sources: CatalogItem[] = [];
  const indicators: CatalogItem[] = [];
  for (const i of items) {
    // 未标 kind 的条目当作源：宁可多列一条，也不让一条真实数据在默认视图消失。
    if (i.badges.includes("indicator")) indicators.push(i);
    else sources.push(i);
  }
  return { sources, indicators };
}

/** 默认视图：数据锚只列源；其他物种原样返回；展开时也原样返回。 */
export function defaultView(species: Species | "all", items: CatalogItem[], expanded = false): CatalogItem[] {
  const split = splitAnchors(species, items);
  if (!split || expanded) return items;
  return split.sources;
}
