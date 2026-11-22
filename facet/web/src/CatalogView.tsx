// ── 素材目录（unify-material-catalog-page 1.x）────────────────────────────────
//
// 六个物种、一页呈现。设计上的三条硬约束，每条都有它挡住的具体毛病：
//
//   1. **按页签懒加载**：选中某物种只请求它自己的端点。「全部」只汇总计数，
//      不拉全量 —— 1000+ 条一次渲染正是入口页被撑到 32,600px 的病根。
//   2. **深度视图跟着卡片走**：mcp / 技能卡片可点进各自的深度视图（工具面、
//      许可证、档位）。这是原 `#/mcp` 唯一不可让的能力，也是它值得合并的理由。
//   3. **不编造字段**：源里没有的就如实显示（`catalog-model.ts` 负责归一，
//      本文件只负责呈现）。空源是「0 项」，取数失败是「读不到」——两者必须可区分。
//
// 取数走 facet 自己的五个端点（`/api/*-catalog`、`/api/marketplace/marketplace.json`），
// 全部在进程内，按请求身份过滤可见性。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SPECIES_SPECS, mapResponse, splitAnchors, defaultView, type CatalogItem, type Species } from "./catalog-model";
import { ServerDepth } from "./McpCatalog";

type Tab = "all" | Species;

/** 每页条数：数据锚有 483 条，不分页就会一条页签撑到上万像素。 */
const PAGE_SIZE = 60;

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; items: CatalogItem[]; sourceAbsent: boolean }
  | { kind: "error"; message: string };

export function CatalogView({
  initialSpecies = "all",
  base = "",
  fetchImpl = fetch,
}: {
  initialSpecies?: string;
  base?: string;
  fetchImpl?: typeof fetch;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(normalizeTab(initialSpecies));
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [query, setQuery] = useState(() => new URLSearchParams((window.location.hash.split("?")[1] ?? "")).get("q") ?? "");
  const [page, setPage] = useState(1);
  // 页签与搜索词进 URL（pack-detail-as-page D5）：从详情页返回时按地址还原，
  // 不是回到空白首访。tab 由 initialSpecies（hash 的 ?species=）播种，
  // 改动时写回 hash —— 这一层不引入 router（facet 壳没有 Router 祖先）。
  const writeCatalogState = (nextTab: Tab, nextQuery: string) => {
    const url = new URL(window.location.href);
    const params = new URLSearchParams();
    if (nextTab !== "all") params.set("species", nextTab);
    if (nextQuery) params.set("q", nextQuery);
    const qs = params.toString();
    window.history.replaceState(null, "", `${url.pathname}${url.search}${qs ? `#/catalog?${qs}` : "#/catalog"}`);
  };
  const pickTab = (next: Tab) => {
    setTab(next);
    setPage(1);
    writeCatalogState(next, query);
  };
  const [depth, setDepth] = useState<{ species: Species; id: string } | null>(null);
  // 详情已是独立页（pack-detail-as-page 5.2）：pack 卡片链到同一个详情地址，
  // 目录的页签与搜索词由 hash 的 ?species= 保留，往返回到原处。

  // 计数汇总（「全部」页签与页签上的数字）：一次轻量请求拿各类计数。
  // 它读的是导出产物 counts.json —— 只用于显示数字，不做列表数据源。
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let alive = true;
    fetchImpl(`${base}/generated/counts.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        const m: Record<string, number> = {};
        for (const row of d.byCategory ?? []) {
          // counts.json 用 `official-data`，物种枚举用 `data-anchor` —— 同一件事
          // 两个名字是历史遗留。这里只做读侧映射，不去改导出器的产物（那会
          // 波及对账闸与机器面）。
          const key = row.category === "official-data" ? "data-anchor" : row.category;
          m[key] = row.count;
        }
        setCounts(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [base, fetchImpl]);

  // 懒加载：只有选中具体物种时才请求它的端点。「全部」不请求任何列表。
  useEffect(() => {
    if (tab === "all") {
      setState({ kind: "idle" });
      return;
    }
    const spec = SPECIES_SPECS.find((s) => s.species === tab);
    if (!spec) return;
    let alive = true;
    setState({ kind: "loading" });
    fetchImpl(`${base}${spec.endpoint}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => {
        if (!alive) return;
        const { items, error, sourceAbsent } = mapResponse(tab, body);
        setState(error ? { kind: "error", message: error } : { kind: "ready", items, sourceAbsent });
      })
      .catch((e) => {
        if (alive) setState({ kind: "error", message: String((e as Error)?.message ?? e) });
      });
    return () => {
      alive = false;
    };
  }, [tab, base, fetchImpl]);

  // 换页签/换搜索时回到第一页。
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab/query are the reset triggers; the effect reads neither.
  useEffect(() => {
    setPage(1);
  }, [tab, query]);

  const filtered = useMemo(() => {
    if (state.kind !== "ready") return [];
    const q = query.trim().toLowerCase();
    if (!q) return state.items;
    return state.items.filter((i) =>
      `${i.title} ${i.summary} ${i.badges.join(" ")}`.toLowerCase().includes(q),
    );
  }, [state, query]);

  // 数据锚按浏览价值分层（facet-catalog-species-curation D1）：461 个 SPY_ma5
  // 这类单项指标对逛广场的人零价值，22 个数据源才是「寻数有什么数据」的答案。
  // 默认只列 source，指标折在「另有 N 个」后面——**不删数据**，端点与机器面
  // 全量不变，这纯粹是呈现取舍。
  const [anchorExpanded, setAnchorExpanded] = useState(false);
  // 分层逻辑在 catalog-model 里（纯函数可测），这里只取结果。
  const anchorSplit = useMemo(() => splitAnchors(tab, filtered), [tab, filtered]);
  const visible = useMemo(() => defaultView(tab, filtered, anchorExpanded), [tab, filtered, anchorExpanded]);

  const shown = useMemo(() => visible.slice(0, page * PAGE_SIZE), [visible, page]);

  const back = useCallback(() => setDepth(null), []);

  // 深度视图：只在有深度的物种上打开，且返回时页签不变。
  if (depth) {
    return (
      <div data-testid="catalog-depth">
        {depth.species === "mcp" ? (
          <ServerDepth name={depth.id} onBack={back} />
        ) : (
          // 技能的深度视图目前由 McpCatalog 的 SkillsSection 承载；
          // 这里先退回列表并让用户在该页签查看，避免复制第二套实现。
          <div className="space-y-3">
            <button type="button" onClick={back} className="text-sm text-primary hover:underline">
              ← {t("catalog.back")}
            </button>
            <p className="text-sm text-muted-foreground">{t("catalog.depth.skillHint")}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="catalog-view">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("catalog.title")}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {t("catalog.lead")}
        </p>
      </header>

      <div className="flex flex-wrap gap-2" role="tablist" data-testid="catalog-tabs">
        <TabButton id="all" current={tab} onPick={pickTab} label={t("catalog.tabs.all")} />
        {SPECIES_SPECS.map((s) => (
          <TabButton
            key={s.species}
            id={s.species}
            current={tab}
            onPick={pickTab}
            label={t(`catalog.species.${s.species}`, s.species)}
            count={counts?.[s.species]}
          />
        ))}
      </div>

      {tab === "all" ? (
        <AllSpecies counts={counts} onPick={pickTab} />
      ) : (
        <>
          {/* 每个物种一句可读说明（facet-catalog-species-curation 1.x）：
              一个访客不认识的物种名（「官方数据锚」）如果只有标签没有解释，
              等于让他自己猜。这一句也承担「讲清 pack 与 facade 的关系」——
              facade 的说明里写明它是「已经在跑的」、pack 是「可装的」。 */}
          <p
            className="max-w-3xl text-sm leading-relaxed text-muted-foreground"
            data-testid={`catalog-species-desc-${tab}`}
          >
            {t(`catalog.speciesDesc.${tab}`, "")}
          </p>
          <input
            type="search"
            className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder={t("catalog.searchPlaceholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
              writeCatalogState(tab, e.target.value);
            }}
            data-testid="catalog-search"
          />

          {state.kind === "loading" && (
            <p className="text-sm text-muted-foreground" data-testid="catalog-loading">
              {t("catalog.loading")}
            </p>
          )}

          {state.kind === "error" && (
            <p className="text-sm text-destructive" data-testid="catalog-error">
              {/* 具名错误：说清是「读不到该物种」，不是「该物种没有东西」。 */}
              {t("catalog.error", { species: t(`catalog.species.${tab}`, tab), message: state.message })}
            </p>
          )}

          {state.kind === "ready" && visible.length === 0 && !(anchorSplit && anchorSplit.indicators.length > 0) && (
            <p className="text-sm text-muted-foreground" data-testid={state.sourceAbsent ? "catalog-source-absent" : "catalog-empty"}>
              {/* 「源没接入」是部署缺配置，「0 条」是内容为空 —— 两句话不能混。 */}
              {state.sourceAbsent
                ? t("catalog.sourceAbsent", { species: t(`catalog.species.${tab}`, tab) })
                : t("catalog.empty")}
            </p>
          )}

          {shown.length > 0 && (
            <>
              <div
                className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
                data-testid="catalog-grid"
              >
                {shown.map((item) => (
                  <Card
                    key={item.key}
                    item={item}
                    onOpenDepth={() => setDepth({ species: item.species, id: item.id })}
                    onOpenDetail={() => { window.location.hash = `#/packs/${encodeURIComponent(item.id)}`; }}
                  />
                ))}
              </div>
              {visible.length > shown.length && (
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
                  data-testid="catalog-more"
                >
                  {t("catalog.loadMore", { shown: shown.length, total: visible.length })}
                </button>
              )}
              {/* 数据锚的指标折叠（facet-catalog-species-curation 2.1）：
                  默认视图只列数据源；指标折在这里，展开后全都在。总数写出来，
                  否则「目录看起来变少了」会被读成「数据丢了」。 */}
              {anchorSplit && anchorSplit.indicators.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAnchorExpanded((v) => !v)}
                  className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
                  data-testid="catalog-anchor-fold"
                  data-expanded={anchorExpanded ? "true" : "false"}
                >
                  {anchorExpanded
                    ? t("catalog.anchorFoldHide")
                    : t("catalog.anchorFold", { count: anchorSplit.indicators.length })}
                </button>
              )}
            </>
          )}
        </>
      )}

    </div>
  );
}

function TabButton({
  id,
  current,
  onPick,
  label,
  count,
}: {
  id: Tab;
  current: Tab;
  onPick: (t: Tab) => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={current === id}
      onClick={() => onPick(id)}
      data-testid={`catalog-tab-${id}`}
      className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
        current === id
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
      {typeof count === "number" && <span className="ml-1.5 text-xs opacity-70">{count}</span>}
    </button>
  );
}

function Card({
  item,
  onOpenDepth,
  onOpenDetail,
}: {
  item: CatalogItem;
  onOpenDepth: () => void;
  onOpenDetail: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-4" data-testid={`catalog-card-${item.key}`}>
      <h3 className="text-sm font-medium leading-snug">{item.title}</h3>
      {/* 未上线的分身显式标出来（facet-catalog-species-curation 3.2）：
          它仍被列出（既有 spec 要求 undeployed 必须出现），但和「正在服务」
          长得一样会让访客点开才发现聊不了。中性措辞，不是「故障」。 */}
      {item.notRunning && (
        <span
          className="w-fit rounded border border-status-waiting/50 bg-status-waiting/10 px-1.5 py-0.5 text-[10px] text-status-waiting"
          data-testid={`catalog-not-running-${item.id}`}
        >
          {t("catalog.facadeUndeployed")}
        </span>
      )}
      {item.badges.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.badges.map((b) => (
            <span key={b} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {b}
            </span>
          ))}
        </div>
      )}
      {item.summary && (
        <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{item.summary}</p>
      )}
      <div className="mt-auto">
        {item.detail ? (
          <button
            type="button"
            onClick={onOpenDetail}
            className="text-xs text-primary underline-offset-2 hover:underline"
            data-testid={`catalog-detail-open-${item.id}`}
          >
            {t("catalog.openDetail")} →
          </button>
        ) : item.depth ? (
          <button
            type="button"
            onClick={onOpenDepth}
            className="text-xs text-primary underline-offset-2 hover:underline"
            data-testid={`catalog-depth-open-${item.id}`}
          >
            {t("catalog.openDepth")} →
          </button>
        ) : item.href ? (
          <a href={item.href} className="text-xs text-primary underline-offset-2 hover:underline">
            {t("catalog.open")} →
          </a>
        ) : null}
      </div>
    </article>
  );
}

/** 「全部」页签：只报计数与前几条预览，不拉全量。 */
function AllSpecies({
  counts,
  onPick,
}: {
  counts: Record<string, number> | null;
  onPick: (t: Tab) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="catalog-all">
      {SPECIES_SPECS.map((s) => (
        <button
          key={s.species}
          type="button"
          onClick={() => onPick(s.species)}
          className="rounded-lg border border-border bg-muted/30 p-4 text-left transition-colors hover:border-primary/50"
          data-testid={`catalog-all-${s.species}`}
        >
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium">{t(`catalog.species.${s.species}`, s.species)}</span>
            <span className="text-lg font-semibold tabular-nums">{counts?.[s.species] ?? "—"}</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("catalog.allHint")}</p>
        </button>
      ))}
    </div>
  );
}

/** `?species=...` 与旧 `#/mcp` 的预选都收敛到这里。 */
export function normalizeTab(raw: string | null | undefined): Tab {
  const v = String(raw ?? "").toLowerCase();
  if (v === "skill" || v === "skills") return "skill";
  if (v === "mcp") return "mcp";
  if (v === "pack" || v === "agent" || v === "agents") return "pack";
  if (v === "facade") return "facade";
  if (v === "data-anchor" || v === "anchor" || v === "official-data") return "data-anchor";
  return "all";
}

export default CatalogView;
