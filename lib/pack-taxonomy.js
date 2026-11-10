// ── 市场分类体系：线（供给域）× 领域（干什么活） (overhaul-market-catalog-presentation P0/P1) ──
//
// P0：线词多语言标签（客户端可见的 chip 文案）。
// P1：本模块成为分类体系的唯一真源 ——
//   · 线：五个固定取值（slug + 五语标签 + 声明顺序），slug→线 归位表（历史 14 类目零迁移）；
//   · 领域：受控词表（slug + 五语标签 + 声明顺序），可多值；词表外取值不猜测归位，
//     落「未归类」档（specs/pack-domain-taxonomy）。
//
// 原则（与 lib/pack-locale.js 同律：零依赖叶，不拉模块图）：
//   · zh 主轨线词不变 —— 它同时是分面筛选的线上身份（isLineWord/slugsForLine 按它展开）；
//   · 未映射的线词按原样呈现（present-as-is，零迁移、不猜测）；
//   · 标签按请求 locale 投影，主子标签回落（en-US → en），未覆盖回落 zh；
//   · 两张表都可部署侧 env 覆盖，覆盖非法时回落内置表而不是让浏览面失效。

// ── 线：五个固定取值（顺序即分面顺序，恒常驻） ──────────────────────────────

// slug · zh 主轨线词 · 五语标签。非语言品牌标记沿用 LineLadder 的既有约定
// （facet-platform spec：品牌字不翻译，非 zh 语言用概念名 Base/Lex/Wire/Facet/
// Constellation）+ 各语言领域词。
const LINES = [
  {
    slug: "base",
    zh: "壹座 · 智能体团队",
    labels: {
      en: "Base · Agent Teams",
      es: "Base · Equipos de agentes",
      fr: "Base · Équipes d'agents",
      ja: "Base · エージェントチーム",
    },
  },
  {
    slug: "lex",
    zh: "识律 · 法律智能",
    labels: {
      en: "Lex · Legal Intelligence",
      es: "Lex · Inteligencia jurídica",
      fr: "Lex · Intelligence juridique",
      ja: "Lex · リーガルインテリジェンス",
    },
  },
  {
    slug: "wire",
    zh: "柏讯 · 数据与情报",
    labels: {
      en: "Wire · Data & Intelligence",
      es: "Wire · Datos e inteligencia",
      fr: "Wire · Données et renseignement",
      ja: "Wire · データとインテリジェンス",
    },
  },
  {
    slug: "facet",
    zh: "谦面 · 业务流",
    labels: {
      en: "Facet · Business Flows",
      es: "Facet · Flujos de negocio",
      fr: "Facet · Flux métier",
      ja: "Facet · ビジネスフロー",
    },
  },
  {
    slug: "constellation",
    zh: "萬星 · 智能体连接",
    labels: {
      en: "Constellation · Agent Connectivity",
      es: "Constellation · Conectividad de agentes",
      fr: "Constellation · Connectivité d'agents",
      ja: "Constellation · エージェント接続",
    },
  },
];

const LINE_BY_SLUG = new Map(LINES.map((l) => [l.slug, l]));
const LINE_BY_ZH_WORD = new Map(LINES.map((l) => [l.zh, l]));

// 存储类目 slug → 线（零迁移：packs.db/manifest 的 category 值一个不动）。
// 取值 null = 刻意不进分面（分身类由 badge=facade 承担）。
const DEFAULT_SLUG_TO_LINE = {
  // 壹座 · 智能体团队 — 平台本体的团队蓝图与共享岗位
  cluster: "壹座 · 智能体团队",
  fleet: "壹座 · 智能体团队",
  "fleet-shared": "壹座 · 智能体团队",
  // 柏讯 · 数据与情报
  wire: "柏讯 · 数据与情报",
  research: "柏讯 · 数据与情报",
  daas: "柏讯 · 数据与情报",
  data: "柏讯 · 数据与情报",
  dash: "柏讯 · 数据与情报",
  analytics: "柏讯 · 数据与情报",
  // 识律 · 法律智能
  legal: "识律 · 法律智能",
  // 谦面 · 业务流 — 文本与数据的业务垂直工作流
  facet: "谦面 · 业务流",
  text: "谦面 · 业务流",
  "doc-studio": "谦面 · 业务流",
  crm: "谦面 · 业务流",
  operations: "谦面 · 业务流",
  business: "谦面 · 业务流",
  authoring: "谦面 · 业务流",
  docs: "谦面 · 业务流",
  writing: "谦面 · 业务流",
  // 萬星 · 智能体连接
  wanxing: "萬星 · 智能体连接",
  // 分身类由 badge=facade 承担，不在主货架按类目展示
  facade: null,
  company: null,
};

// ── 领域：受控词表（顺序即分面顺序；计数为 0 的不呈现） ──────────────────────

const DOMAINS = [
  { slug: "investing", labels: { zh: "投研", en: "Investing", es: "Inversión", fr: "Investissement", ja: "投資調査" } },
  { slug: "sentiment", labels: { zh: "舆情", en: "Sentiment", es: "Opinión pública", fr: "Opinion publique", ja: "センチメント" } },
  { slug: "risk", labels: { zh: "风控", en: "Risk control", es: "Control de riesgo", fr: "Maîtrise des risques", ja: "リスク管理" } },
  { slug: "legal", labels: { zh: "法务", en: "Legal", es: "Legal", fr: "Juridique", ja: "法務" } },
  { slug: "content", labels: { zh: "内容创作", en: "Content", es: "Contenido", fr: "Contenu", ja: "コンテンツ制作" } },
  { slug: "support", labels: { zh: "客服", en: "Customer support", es: "Atención al cliente", fr: "Support client", ja: "カスタマーサポート" } },
  { slug: "ecommerce", labels: { zh: "电商", en: "E-commerce", es: "Comercio electrónico", fr: "E-commerce", ja: "EC" } },
  { slug: "data-eng", labels: { zh: "数据工程", en: "Data engineering", es: "Ingeniería de datos", fr: "Ingénierie des données", ja: "データエンジニアリング" } },
  { slug: "ops", labels: { zh: "运营", en: "Operations", es: "Operaciones", fr: "Opérations", ja: "運営" } },
  { slug: "knowledge", labels: { zh: "知识管理", en: "Knowledge", es: "Conocimiento", fr: "Connaissance", ja: "ナレッジ管理" } },
];

// 归位推导的领域默认值（迁移与读面缺省共用）。刻意保守：只认类目 slug 明确
// 指向某个"活"的映射；供给线 slug（wire/wanxing/cluster…）不猜领域 —— 那由
// 作者声明（manifest.domain[]）或策展补齐，未声明的落「未归类」待办。
const DEFAULT_SLUG_TO_DOMAINS = {
  legal: ["legal"],
  text: ["content"],
  "doc-studio": ["content"],
  authoring: ["content"],
  docs: ["content"],
  writing: ["content"],
  business: ["ops"],
  operations: ["ops"],
  crm: ["support"],
};

let _configuredLines = null; // { raw, value } — keyed by the raw env string
let _configuredDomains = null;

function parseJsonEnv(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null; // malformed override falls back to the built-in rather than breaking the face
  }
}

/** The active slug→line-word table: env PACK_CATEGORY_LINES (JSON object) overrides
 *  the built-in. `null` is a legitimate value (suppress from facet). The parse is
 *  cached per raw override string — callers that pass a different env (tests)
 *  always get a table for THAT env. */
export function categoryLines(env = process.env) {
  const raw = String(env.PACK_CATEGORY_LINES ?? "").trim();
  if (_configuredLines && _configuredLines.raw === raw) return _configuredLines.value;
  const parsed = parseJsonEnv(raw);
  let value;
  if (!parsed || Array.isArray(parsed)) {
    value = DEFAULT_SLUG_TO_LINE;
  } else {
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null || typeof v === "string") out[k] = v;
    }
    value = Object.keys(out).length > 0 ? out : DEFAULT_SLUG_TO_LINE;
  }
  _configuredLines = { raw, value };
  return value;
}

/** Reset the parsed overrides (tests mutate the env between cases). */
export function _resetTaxonomyCache() {
  _configuredLines = null;
  _configuredDomains = null;
}

/** The domain vocabulary: env PACK_DOMAIN_TAXONOMY (JSON array of
 *  `{ slug, labels }` or object `{ slug: labels }`) overrides the built-in.
 *  Entries must carry a kebab slug and at least a zh label; anything else is
 *  dropped rather than guessed. An override that yields no usable entries
 *  falls back to the built-in (never a zero vocabulary). Cached per raw string
 *  (same discipline as categoryLines). */
export function domainVocabulary(env = process.env) {
  const raw = String(env.PACK_DOMAIN_TAXONOMY ?? "").trim();
  if (_configuredDomains && _configuredDomains.raw === raw) return _configuredDomains.value;
  const parsed = parseJsonEnv(raw);
  let value = DOMAINS;
  if (parsed) {
    const entries = Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed).map(([slug, labels]) => ({ slug, labels }));
    const out = [];
    for (const e of entries) {
      if (!e || typeof e !== "object") continue;
      const slug = String(e.slug ?? "").trim();
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(slug)) continue;
      const labels = e.labels && typeof e.labels === "object" ? e.labels : null;
      if (!labels || typeof labels.zh !== "string" || !labels.zh.trim()) continue;
      out.push({ slug, labels });
    }
    if (out.length > 0) value = out;
  }
  _configuredDomains = { raw, value };
  return value;
}

/** Canonical line slugs in declared order (facet order). */
export function lineSlugs() {
  return LINES.map((l) => l.slug);
}

/** The zh main-track word for a line slug (the facet selection identity). */
export function lineWordOf(slug) {
  return LINE_BY_SLUG.get(String(slug ?? ""))?.zh ?? null;
}

/** The display line word a stored category slug maps to; the slug itself when
 *  unmapped (`present as-is`), or `null` for a slug deliberately suppressed. */
export function lineOf(slug, env = process.env) {
  const s = String(slug ?? "");
  if (!s) return "";
  const table = categoryLines(env);
  if (Object.hasOwn(table, s)) return table[s];
  return s;
}

/** The stored slugs that all归位 to a display line word. */
export function slugsForLine(lineWord, env = process.env) {
  const out = new Set();
  for (const [slug, line] of Object.entries(categoryLines(env))) {
    if (line === lineWord) out.add(slug);
  }
  return [...out];
}

/** True when a facet selection is a line word (so it must be expanded to slugs).
 *  A raw slug is indistinguishable when it is its own line word, so only a word
 *  that is NOT itself a stored slug key is treated as a line selection. */
export function isLineWord(word, env = process.env) {
  const w = String(word ?? "");
  if (!w) return false;
  const table = categoryLines(env);
  const values = new Set(Object.values(table).filter((v) => v !== null));
  return values.has(w) && !(w in table);
}

/** Aggregate the distinct line words for a category-slug set, sorted, dropping
 *  the suppressed (null) bucket. Unmapped slugs pass through as themselves. */
export function facetLinesOf(slugs, env = process.env) {
  const set = new Set();
  for (const s of slugs) {
    const line = lineOf(s, env);
    if (line) set.add(line);
  }
  return [...set].sort();
}

/** zh 主轨线词在 `locale` 下的展示标签。zh（或未知 locale）回落线词本身；
 *  未映射的线词（env 自定义线、透传 slug）原样返回——present-as-is 不变。
 *  locale 容错与 lib/pack-locale.js 的 localeBlockAt 同律：带后缀的标签
 *  （en-US）先找全标签，再退主子标签（en）；两者皆未覆盖回落 zh 主轨。 */
export function lineLabelOf(lineWord, locale) {
  const word = String(lineWord ?? "");
  if (!word) return "";
  const tag = String(locale ?? "").toLowerCase();
  if (!tag || tag === "zh" || tag.startsWith("zh")) return word;
  const line = LINE_BY_ZH_WORD.get(word);
  if (!line) return word;
  return labelAt(line.labels, tag, word);
}

/** 规范线 slug（base/lex/wire/facet/constellation）或 null。 */
export function lineSlugOf(lineWord) {
  return LINE_BY_ZH_WORD.get(String(lineWord ?? ""))?.slug ?? null;
}

function labelAt(labels, tag, fallback) {
  if (!labels) return fallback;
  const hit = labels[tag] || labels[tag.split("-")[0]];
  return typeof hit === "string" && hit.trim() ? hit : fallback;
}

/** 领域 slug 在 `locale` 下的标签；未覆盖回落 zh，未知 slug 原样返回。 */
export function domainLabelOf(slug, locale, env = process.env) {
  const s = String(slug ?? "");
  if (!s) return "";
  const entry = domainVocabulary(env).find((d) => d.slug === s);
  if (!entry) return s;
  const tag = String(locale ?? "").toLowerCase();
  if (!tag || tag === "zh" || tag.startsWith("zh")) return entry.labels.zh;
  return labelAt(entry.labels, tag, entry.labels.zh);
}

/** True when the slug is in the (active) domain vocabulary. */
export function isDomainSlug(slug, env = process.env) {
  const s = String(slug ?? "");
  return Boolean(s) && domainVocabulary(env).some((d) => d.slug === s);
}

/** 缺省领域推导：存储类目 slug → 领域 slug 列表（未映射 = 空 = 未归类档）。
 *  只认明确指向某个"活"的类目；供给线 slug 不猜。 */
export function domainsForCategory(slug, env = process.env) {
  const s = String(slug ?? "");
  if (!s) return [];
  return (DEFAULT_SLUG_TO_DOMAINS[s] ?? []).filter((d) => isDomainSlug(d, env));
}
