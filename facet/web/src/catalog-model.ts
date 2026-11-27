// ── 素材目录的物种适配（unify-material-catalog-page 1.x）─────────────────────
//
// 目录页要在一个视图里呈现六个物种，而它们的端点各有一套形状：
//
//   pack          /api/packs                       → { packs: [{id, name, display, lineLabel, ...}] }
//   mcp           /api/mcp-catalog                  → { servers: [{name, displayName, endpoint, ...}] }
//   skill         /api/skills-catalog               → { skills:  [{name, displayName, repositoryUrl, ...}] }
//   facade        /api/facades-catalog              → { facades: [{id, name, runnable, deployment, ...}] }
//   data-anchor   /api/data-anchors-catalog         → { anchors: [{id, name, kind, summary, annotation}] }
//   plugin        （暂未接入目录页；枚举里保留）
//
// pack 读市场投影（/api/packs）而不是 marketplace.json：后者是给 Claude/Codex
// 客户端加载器用的对外契约，它的 `name` 是包 id —— 目录卡要的是「给读者看的
// 名字与那句话」，与市场同一份投影（polish-facet-read-surfaces D1）。同一个包在
// 两个面上必须读到同一个名字，这一点由 test-catalog-model 钉住。
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
  /** 端点是否分页（响应带 total/page/pageSize）。分页物种取满 total 为止，
   *  不写死页数 —— 服务端每页上限 100，而 pack 今天有 142 条。 */
  paged?: boolean;
  /** 列表是否带 locale 参数：分页物种与按 locale 投影的物种都要带。 */
  localized?: boolean;
};

export const SPECIES_SPECS: SpeciesSpec[] = [
  { species: "pack", endpoint: "/api/packs", listKey: "packs", hasDepth: false, paged: true, localized: true },
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
  /** 卡片可判断性（polish-facet-mcp-surface 2.1）：该材料的规模与「何时用」。
   *  两者都只在源真的给了的时候才有值——缺就是 null，渲染层整项不显示，
   *  绝不编一个 0 或一句套话。工具总数不能从工具面派生（列表载荷按 spec
   *  不含工具面），它用的是同一次请求里已下发的 `toolCount`。 */
  toolCount?: number | null;
  whenToUse?: string;
  /** 技能的出处字段（polish-facet-mcp-surface 4.1）：详情面板就地展开用，
   *  全部来自同一次列表响应。缺席即 undefined，渲染层写「未标注」。 */
  provenance?: { repositoryUrl: string | null; author: string | null; version: string | null; license: string | null };
  /** 作者声明的印章字块（pack 的 `display.identity.mark`）。有则用它，
   *  没有则由 UI 按名称推导 —— 与市场卡同一条规则。 */
  mark?: string;
  /** 源里确实没有一句话说明（不是取数失败）。渲染层据此用当前语言写
   *  「还没人写说明」，而不是留一块空白让人读成「查过了是空的」。 */
  undescribed?: boolean;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const firstStr = (...vs: unknown[]): string => {
  for (const v of vs) {
    const s = str(v);
    if (s) return s;
  }
  return "";
};

/** Locale 归一化，与服务端 lib/pack-locale.js 同一策略：小写、`zh*` 落 `zh`、
 *  `en-US` 先找 `en` 块。这里只做「从哪个槽读数」的判定，不做翻译。 */
export function normalizeLocaleForRead(locale: string | undefined | null): string {
  const raw = typeof locale === "string" ? locale.trim().toLowerCase() : "";
  if (!raw) return "zh";
  return raw.startsWith("zh") ? "zh" : raw;
}

/** 从五语 annotation 里按 locale 取一个槽：先精确、再主子标签、最后 zh。
 *  返回 undefined 表示源没给 —— 调用方继续走它自己的降级链。 */
function humanSlot(
  human: unknown,
  locale: string,
): { name?: string; summary?: string } | undefined {
  if (!human || typeof human !== "object") return undefined;
  const map = human as Record<string, unknown>;
  const want = normalizeLocaleForRead(locale);
  const pick = (key: string) => {
    const v = map[key];
    return v && typeof v === "object" ? (v as { name?: string; summary?: string }) : undefined;
  };
  return pick(want) ?? pick(want.split("-")[0]) ?? (want === "zh" ? undefined : pick("zh"));
}

/** 承诺位的降级链（specs/pack-display-format）：promise → 描述首句 → 名称。
 *  目录卡与市场卡共用这一条，所以同一份行喂两边不会读出两句话。 */
function firstSentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const m = t.match(/^[^。！？.!?\n]+[。！？.!?]/);
  return (m ? m[0] : t).trim();
}

/** pack 卡：读市场投影（/api/packs）。标题是包名叫不是 id —— 这条由单测钉住。 */
function packItem(raw: Record<string, unknown>): CatalogItem | null {
  const id = firstStr(raw.id);
  const name = firstStr(raw.name);
  // 没有 id 就没法打开详情；没有 name 说明这条行不可展示（绝不拿 id 顶替）。
  if (!id || !name) return null;
  const display = (raw.display ?? {}) as Record<string, unknown>;
  const summary =
    firstStr(display.promise) || firstSentence(firstStr(raw.description)) || name;
  const lineLabel = firstStr(raw.lineLabel, raw.line);
  const outcomes = Array.isArray(display.outcomes) ? (display.outcomes as unknown[]) : [];
  const firstOutcome = outcomes.length
    ? firstStr((outcomes[0] as Record<string, unknown>)?.title)
    : "";
  return {
    key: `pack:${id}`,
    species: "pack",
    id,
    title: name,
    summary,
    badges: [lineLabel, firstOutcome].filter(Boolean),
    // 目录页就地打开详情（catalog-owns-browse-market-owns-trade D2）：
    // 以前链到 #/packs 会把访客甩出目录、丢掉浏览位置。
    href: null,
    depth: false,
    detail: true,
    // v2 声明的印章字块（pack-display-format identity.mark）：市场卡用它，
    // 目录卡同源取用，避免同一个包两个面两个标记。
    ...(firstStr(((display.identity as Record<string, unknown>)?.mark as Record<string, unknown>)?.value)
      ? {
          mark: firstStr(((display.identity as Record<string, unknown>).mark as Record<string, unknown>).value),
        }
      : {}),
  };
}

/** 把一条源记录映射成目录卡片。species 决定读哪几个字段。
 *  `locale` 只影响「从哪一个语言槽取显示名与摘要」，不改变准入与计数。 */
export function toCatalogItem(
  species: Species,
  raw: Record<string, unknown>,
  locale = "zh-CN",
): CatalogItem | null {
  if (!raw || typeof raw !== "object") return null;

  const spec = specFor(species);
  const depth = spec?.hasDepth ?? false;

  switch (species) {
    case "pack":
      return packItem(raw);
    case "mcp": {
      const name = firstStr(raw.name);
      if (!name) return null;
      const ann = (raw.annotation ?? {}) as Record<string, unknown>;
      return {
        key: `mcp:${name}`,
        species,
        id: name,
        title: firstStr(ann.name, humanSlot(ann.human, locale)?.name, raw.displayName, name),
        summary: firstStr(ann.summary, humanSlot(ann.human, locale)?.summary, raw.description),
        badges: Array.isArray(raw.requiredGroups) && raw.requiredGroups.length ? ["受限"] : [],
        href: null,
        depth,
        detail: false,
        // 规模与用途都来自同一次列表响应（polish-facet-mcp-surface 2.1）：
        // 只认有限数字，字符串/NaN/缺失一律 null——「未知」不是「零」。
        toolCount: Number.isFinite(raw.toolCount) ? (raw.toolCount as number) : null,
        whenToUse: str(ann.whenToUse) || undefined,
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
        title: firstStr(ann.name, humanSlot(ann.human, locale)?.name, raw.displayName, name),
        summary: firstStr(ann.summary, humanSlot(ann.human, locale)?.summary, raw.description),
        badges: Array.isArray(raw.tags) ? (raw.tags as unknown[]).map(str).filter(Boolean).slice(0, 2) : [],
        href: firstStr(raw.repositoryUrl) || null,
        depth,
        detail: false,
        // 详情面板的出处字段（polish-facet-mcp-surface 4.1）：缺席即 null，
        // 面板写「未标注」——空着会读成「查过了没有」。
        provenance: {
          repositoryUrl: firstStr(raw.repositoryUrl) || null,
          author: firstStr(raw.author) || null,
          version: firstStr(raw.version) || null,
          license: firstStr(raw.license) || null,
        },
      };
    }
    case "facade": {
      const id = firstStr(raw.id, raw.slug, raw.name);
      if (!id) return null;
      const annRaw = (raw.annotation ?? {}) as Record<string, unknown>;
      const d = (raw.deployment ?? {}) as Record<string, unknown>;
      const state = firstStr(d.state);
      const summary = firstStr(humanSlot(annRaw.human, locale)?.summary, annRaw.summary, raw.description);
      return {
        key: `facade:${id}`,
        species,
        id,
        // 五语 annotation 是这份材料的权威文案（实测 56/56 都带五语）；
        // 顶层 name/description 只是 zh 主轨，排在它后面。
        title: firstStr(humanSlot(annRaw.human, locale)?.name, annRaw.name, raw.name, id),
        summary,
        // 上游没给描述（2026-11-25 实测：8 支 undeployed 的 registry AgentCard
        // 里 6 支 description 为空）。这里**不编造它做什么**，只立一个标记，
        // 由渲染层用当前语言说「这条还没写说明」—— 空白卡片会被读成「查过了
        // 是空的」，而真相是「还没人写」。文案不进这个纯函数：它没有 i18n。
        ...(summary ? {} : { undescribed: true }),
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
        title: firstStr(humanSlot(ann.human, locale)?.name, ann.name, raw.name, id),
        summary: firstStr(humanSlot(ann.human, locale)?.summary, ann.summary, raw.summary),
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

export function mapResponse(species: Species, body: unknown, locale = "zh-CN"): MapOutcome {
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
    const item = toCatalogItem(species, raw as Record<string, unknown>, locale);
    if (item) items.push(item);
  }
  return { items, error: null, sourceAbsent };
}

/** 分页物种要取到 total 为止（服务端每页上限 100）。返回还要不要继续取，
 *  以及这次响应自己声明的 total —— 页数由 total/pageSize 决定，不写死。 */
export function needsAnotherPage(species: Species, body: unknown, takenSoFar: number): boolean {
  const spec = specFor(species);
  if (!spec?.paged || !body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  const total = Number(obj.total);
  if (!Number.isFinite(total)) return false;
  return takenSoFar < total;
}

/** 取一个物种的卡片：分页物种循环取到 total，其余一次。返回 `requests` 便于
 *  断言「确实按声明取满」而不是静默少取一页。
 *
 *  pageSize 用服务端上限（100）：目录页一次点开就要看到全部，用默认 50 只会
 *  多一次往返。分页参数只在该物种声明 `paged` 时带上。 */
export type SpeciesFetch = {
  items: CatalogItem[];
  error: string | null;
  sourceAbsent: boolean;
  requests: number;
};

export async function fetchSpecies(
  species: Species,
  { base = "", fetchImpl = fetch, locale = "zh-CN", pageSize = 100 }: {
    base?: string;
    fetchImpl?: typeof fetch;
    locale?: string;
    pageSize?: number;
  } = {},
): Promise<SpeciesFetch> {
  const spec = specFor(species);
  if (!spec) return { items: [], error: `unknown species: ${species}`, sourceAbsent: false, requests: 0 };

  const url = (page: number) => {
    const params = new URLSearchParams();
    if (spec.paged) {
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
    }
    if (spec.localized) params.set("locale", locale);
    const qs = params.toString();
    return `${base}${spec.endpoint}${qs ? `?${qs}` : ""}`;
  };

  let requests = 0;
  const items: CatalogItem[] = [];
  let sourceAbsent = false;
  for (let page = 1; ; page += 1) {
    const r = await fetchImpl(url(page));
    requests += 1;
    if (!r.ok) return { items: [], error: `HTTP ${r.status}`, sourceAbsent: false, requests };
    const body = await r.json();
    const mapped = mapResponse(species, body, locale);
    if (mapped.error) return { items: [], error: mapped.error, sourceAbsent: mapped.sourceAbsent, requests };
    sourceAbsent = mapped.sourceAbsent;
    items.push(...mapped.items);
    if (!needsAnotherPage(species, body, items.length)) break;
    // 服务端说还有但这一页一条没给：停，不空转（无限循环的护栏）。
    if (mapped.items.length === 0) break;
  }
  return { items, error: null, sourceAbsent, requests };
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

// ── 预览行的槽读取（polish-facet-read-surfaces 7.2）──────────────────────────
//
// counts.json 的 preview 有两代形状：旧的是字符串，新的是五语槽
// `{ "zh-CN": …, en: … }`。读取器同时认两代，出片时先后顺序不致命。

export type PreviewSlot = string | Record<string, string>;
export type PreviewRow = { name: PreviewSlot; blurb: PreviewSlot; badge?: PreviewSlot };

/** 取一个槽的字符串：字符串原样，对象按读者语言、缺则 zh 主轨。 */
export function pickSlot(v: PreviewSlot | undefined, locale: string): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  const want = locale.startsWith("zh") ? "zh-CN" : locale.split("-")[0];
  return String(v[locale] ?? v[want] ?? v["zh-CN"] ?? "");
}

/** 把一条预览行按当前语言摊平。 */
export function resolvePreviewRow(
  row: PreviewRow,
  locale: string,
): { name: string; blurb: string; badge?: string } {
  return {
    name: pickSlot(row.name, locale),
    blurb: pickSlot(row.blurb, locale),
    ...(row.badge !== undefined ? { badge: pickSlot(row.badge, locale) } : {}),
  };
}
