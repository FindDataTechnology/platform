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

import {
  SPECIES_SPECS,
  fetchSpecies,
  splitAnchors,
  defaultView,
  resolvePreviewRow,
  type CatalogItem,
  type PreviewRow as ModelPreviewRow,
  type Species,
} from "./catalog-model";
import { ServerDepth } from "./ServerDepth";
import { useLanguage } from "@/i18n/useLanguage";

type Tab = "all" | Species;

/** 预览行（surface-material-previews D2，两代形状见 catalog-model 的
 *  PreviewSlot）：材料自己的名 + 一句它的原话（pack 用 promise，其余用
 *  各自的 summary）。badge 是可数事实，缺就不带。 */
type PreviewRow = ModelPreviewRow;

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
  // 目录文案按读者语言取（polish-facet-read-surfaces 2.3）：语言是取数参数，
  // 不是渲染时挑字段 —— 服务端与静态导出物都按同一个 locale 解析。
  // locale 来自 useLanguage()（它把不认识的语言归一到默认值，比裸 i18n.language 严）。
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
  const [depth, setDepth] = useState<{ species: Species; id: string; query?: string } | null>(null);
  // 技能详情面板（polish-facet-mcp-surface 4.1）：按条目 id 就地展开，数据全部
  // 取自已加载的列表载荷——不新增请求，也不走那个未配置的 skill 内容端点。
  const [skillOpen, setSkillOpen] = useState<string | null>(null);
  // 跨服务工具检索（polish-facet-mcp-surface 2.x）：读者知道工具名或主题、
  // 不知道它在哪台服务器。列表载荷按 spec 不含工具面，所以搜索走独立端点。
  // 只在 MCP 页签、且条目过滤无命中时出现——有命中就让位给条目本身。
  const [toolHits, setToolHits] = useState<{ server: string; tool: string; name: string | null; summary: string | null }[] | null>(null);
  const [toolSearchOn, setToolSearchOn] = useState(false);
  const { locale } = useLanguage();
  // 详情已是独立页（pack-detail-as-page 5.2）：pack 卡片链到同一个详情地址，
  // 目录的页签与搜索词由 hash 的 ?species= 保留，往返回到原处。

  // 计数汇总（「全部」页签与页签上的数字）：一次轻量请求拿各类计数。
  // 它读的是导出产物 counts.json —— 只用于显示数字，不做列表数据源。
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  /** 每物种 ≤3 条预览（surface-material-previews D1）。与 counts 同一次取数：
   *  产物里已有，另拉一次只是多一次请求。 */
  const [preview, setPreview] = useState<Record<string, PreviewRow[]> | null>(null);
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
        // 预览用同一套名字映射（导出器按 CATEGORY_ENUM 分组，同样叫 official-data）。
        if (d.preview) {
          const p: Record<string, PreviewRow[]> = {};
          for (const [k, v] of Object.entries(d.preview as Record<string, PreviewRow[]>)) {
            p[k === "official-data" ? "data-anchor" : k] = Array.isArray(v) ? v : [];
          }
          setPreview(p);
        }
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
    let alive = true;
    setState({ kind: "loading" });
    // 取数交给 fetchSpecies：分页物种（pack）取满 total，其余一次；locale 由
    // 物种自己声明要不要带（polish-facet-read-surfaces 1.3 / 2.3）。
    fetchSpecies(tab, { base, fetchImpl, locale })
      .then(({ items, error, sourceAbsent }) => {
        if (!alive) return;
        setState(error ? { kind: "error", message: error } : { kind: "ready", items, sourceAbsent });
      })
      .catch((e) => {
        if (alive) setState({ kind: "error", message: String((e as Error)?.message ?? e) });
      });
    return () => {
      alive = false;
    };
  }, [tab, base, fetchImpl, locale]);

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

  // Cross-server tool search (polish-facet-mcp-surface): only when the MCP tab
  // is open, a query is present, and NO server card matched it — a server match
  // means the reader already has a lead, and two result sets on one screen
  // would make them pick without knowing why. Debounced so typing does not
  // fire a request per keystroke.
  useEffect(() => {
    const q = query.trim();
    const off = tab !== "mcp" || !q || filtered.length > 0;
    if (off) {
      setToolHits(null);
      setToolSearchOn(false);
      return;
    }
    const timer = setTimeout(() => {
      fetch(`${base}/api/mcp-catalog/tools?q=${encodeURIComponent(q)}&locale=${locale}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          setToolHits(Array.isArray(d?.results) ? d.results : null);
          setToolSearchOn(true);
        })
        // A failed search is not an empty search: leave the hits null so the
        // view says "could not read", never "nothing found".
        .catch(() => {
          setToolHits(null);
          setToolSearchOn(true);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [tab, query, filtered.length, base, locale]);

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

  // 技能的深度不再是一个空指针（polish-facet-mcp-surface 4.1）：卡片就地展开
  // 自己的详情面板，内容全部来自已加载的列表载荷。面板盖在卡片上方而不是替换
  // 整页——读者看完这个技能，下一个还在原地。
  if (skillOpen) {
    const skill = state.kind === "ready" ? state.items.find((i) => i.id === skillOpen) : null;
    // A vanished entry (refetch, locale switch, tab change) falls through to the
    // list rather than rendering an empty panel — no setState during render.
    if (skill) return <SkillDetail item={skill} onBack={() => setSkillOpen(null)} />;
  }

  // 深度视图：只在有深度的物种上打开，且返回时页签不变。
  if (depth) {
    return (
      <div data-testid="catalog-depth">
        {depth.species === "mcp" ? (
          <ServerDepth name={depth.id} onBack={back} initialQuery={depth.query ?? ""} />
        ) : (
          // 兜底：技能与非 mcp 物种的深度入口现在都在卡片上就地展开（skill →
          // SkillDetail）；这条分支只在 depth 被塞进不受支持的物种时出现，
          // 不再是一句「请到别处看」的指路牌。
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
          {/* 物种数按实际铺出的页签插值（overhaul-pack-detail-presentation D9）：
              文案写死「六个」而页签只铺五条（`plugin` 在枚举里但没有端点），
              是同一页上两个互相打脸的数字。 */}
          {t("catalog.lead", { n: SPECIES_SPECS.length })}
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
        <AllSpecies counts={counts} preview={preview} onPick={pickTab} locale={locale} />
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

          {/* 「空物种」这句在工具级检索接管时不渲染：同屏一句「没有条目」加
              一组工具结果，读者会以为下面那些也是空的。 */}
          {state.kind === "ready" && !toolSearchOn && visible.length === 0 && !(anchorSplit && anchorSplit.indicators.length > 0) && (
            <p className="text-sm text-muted-foreground" data-testid={state.sourceAbsent ? "catalog-source-absent" : "catalog-empty"}>
              {/* 「源没接入」是部署缺配置，「0 条」是内容为空 —— 两句话不能混。 */}
              {state.sourceAbsent
                ? t("catalog.sourceAbsent", { species: t(`catalog.species.${tab}`, tab) })
                : t("catalog.empty")}
            </p>
          )}

          {/* 工具级检索结果（polish-facet-mcp-surface）：条目层面没命中时，往下
              一层按工具找。命中项点开该服务器的深度视图并把过滤框填成这个工具名
              ——「知道工具名但不知道它在哪台服务器」正是要解的那件事。 */}
          {toolSearchOn && (
            <section className="space-y-2" data-testid="catalog-tool-hits">
              <h2 className="text-sm font-medium">{t("catalog.toolSearch.title", { q: query.trim() })}</h2>
              {toolHits === null ? (
                <p className="text-sm text-muted-foreground" data-testid="catalog-tool-hits-error">
                  {t("catalog.toolSearch.unavailable")}
                </p>
              ) : toolHits.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="catalog-tool-hits-empty">
                  {t("catalog.toolSearch.empty", { q: query.trim() })}
                </p>
              ) : (
                <ul className="space-y-1.5" data-testid="catalog-tool-hits-list">
                  {toolHits.map((hit) => (
                    <li key={`${hit.server}:${hit.tool}`}>
                      <button
                        type="button"
                        onClick={() => setDepth({ species: "mcp", id: hit.server, query: hit.tool })}
                        data-testid={`catalog-tool-hit-${hit.server}-${hit.tool}`}
                        className="w-full rounded-md border border-border p-2.5 text-left hover:bg-muted/40"
                      >
                        <div className="flex items-baseline gap-2 flex-wrap">
                          {hit.name && <span className="text-sm font-medium">{hit.name}</span>}
                          <code className="text-xs text-muted-foreground break-all">{hit.tool}</code>
                          <span className="text-[11px] text-muted-foreground">{t("catalog.toolSearch.inServer", { server: hit.server })}</span>
                        </div>
                        {hit.summary && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{hit.summary}</p>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {shown.length > 0 && (
            <>
              <div
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
                data-testid="catalog-grid"
              >
                {shown.map((item) => (
                  <Card
                    key={item.key}
                    item={item}
                    onOpenDepth={() => {
                      // A skill's depth is its own panel (4.1); MCP keeps the
                      // shared ServerDepth.
                      if (item.species === "skill") setSkillOpen(item.id);
                      else setDepth({ species: item.species, id: item.id });
                    }}
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
      {item.summary ? (
        <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{item.summary}</p>
      ) : item.undescribed ? (
        // 源里确实没有说明（2026-11-25：8 支 undeployed 的 registry AgentCard
        // 里 6 支 description 为空）。留白会被读成「查过了是空的」，所以明说
        // 「还没人写」—— 这是当前语言的句子，不是英文兜底。
        <p
          className="text-xs italic leading-relaxed text-muted-foreground"
          data-testid={`catalog-undescribed-${item.id}`}
        >
          {t("catalog.undescribed")}
        </p>
      ) : null}
      {/* 规模与用途（polish-facet-mcp-surface 2.2）：两者都只在源真的给了时出现，
          缺席就整项不渲染——一个 161 工具的服务器与一个 1 工具的服务器，读者
          不必点开才知道差别；「不知道自己该不该用它」用 whenToUse 一句话回答。 */}
      {(item.toolCount != null || item.whenToUse) && (
        <div className="space-y-1" data-testid={`catalog-card-facts-${item.id}`}>
          {item.toolCount != null && (
            <p className="text-[11px] tabular-nums text-muted-foreground" data-testid={`catalog-card-toolcount-${item.id}`}>
              {t("catalog.card.toolCount", { count: item.toolCount })}
            </p>
          )}
          {item.whenToUse && (
            <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid={`catalog-card-when-${item.id}`}>
              {t("catalog.card.whenToUse", { text: item.whenToUse })}
            </p>
          )}
        </div>
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
            {/* 技能的深度就是它自己的详情面板（polish-facet-mcp-surface 4.1）：
                此前这里给「请到生态技能页签看」—— 一句把人送走、什么也没告诉
                他的话。同一个按钮，现在就地打开内容。 */}
            {t(item.species === "skill" ? "catalog.openSkill" : "catalog.openDepth")} →
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

/** 技能详情面板（polish-facet-mcp-surface 4.1）：目录内就地展开该技能声明的
 *  全部元数据。每个缺席字段都写「未标注」——留空会读成「查过了，没有」。 */
function SkillDetail({ item, onBack }: { item: CatalogItem; onBack: () => void }) {
  const { t } = useTranslation();
  const p = item.provenance ?? { repositoryUrl: null, author: null, version: null, license: null };
  const rows: [string, string | null][] = [
    [t("catalog.skillDetail.description"), item.summary || null],
    [t("catalog.skillDetail.repository"), p.repositoryUrl],
    [t("catalog.skillDetail.author"), p.author],
    [t("catalog.skillDetail.version"), p.version],
    [t("catalog.skillDetail.license"), p.license],
    [t("catalog.skillDetail.tags"), item.badges.length > 0 ? item.badges.join("、") : null],
  ];
  return (
    <div className="space-y-4" data-testid={`catalog-skill-detail-${item.id}`}>
      <button type="button" onClick={onBack} className="text-sm text-primary hover:underline" data-testid="catalog-skill-back">
        ← {t("catalog.back")}
      </button>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{item.title}</h1>
        <code className="mt-1 block text-xs text-muted-foreground break-all">{item.id}</code>
      </header>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words">
              {value ? (
                label === t("catalog.skillDetail.repository") ? (
                  <a href={value} target="_blank" rel="noreferrer" className="text-primary hover:underline break-all">
                    {value}
                  </a>
                ) : (
                  value
                )
              ) : (
                <span className="text-muted-foreground">{t("mcp.depth.notDeclared")}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 「全部」页签：只报计数与前几条预览，不拉全量。 */
function AllSpecies({
  counts,
  preview,
  onPick,
  locale,
}: {
  counts: Record<string, number> | null;
  preview: Record<string, PreviewRow[]> | null;
  onPick: (t: Tab) => void;
  locale: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="catalog-all">
      {SPECIES_SPECS.map((s) => {
        const rows = (preview?.[s.species] ?? []).map((r) => resolvePreviewRow(r, locale));
        return (
          // 卡片容器是 div，可点区域是里面那个按钮，预览列表是它的兄弟
          // （polish-facet-read-surfaces D3）：列表以前嵌在 <button> 里，
          // 一是非法内容模型（<ul> 不是 phrasing content），二是把 272 字符的
          // 可访问名塞给一个按钮。现在按钮只承载「名字 + 计数 + 一句话」。
          <div
            key={s.species}
            className="min-w-0 rounded-lg border border-border bg-muted/30 p-4 transition-colors hover:border-primary/50"
            data-testid={`catalog-all-${s.species}`}
          >
            <button
              type="button"
              onClick={() => onPick(s.species)}
              className="block w-full text-left"
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{t(`catalog.species.${s.species}`, s.species)}</span>
                <span className="text-lg font-semibold tabular-nums">{counts?.[s.species] ?? "—"}</span>
              </span>
              {/* 卡片承载该物种的一句话说明（overhaul-pack-detail-presentation D9）：
                  原来这里是一句「Open this species」——一个按钮说「点我」，
                  对「背后是什么」零信息，而这一句本来就有（speciesDesc）。 */}
              <span className="mt-2 block line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {t(`catalog.speciesDesc.${s.species}`, "")}
              </span>
            </button>
            {/* 预览条目（surface-material-previews D2/D4）：读者在「全部」页签就能
                看见这个物种里长什么样，不必先点进去。无数据时整块不渲染——
                空白块会读作「查过了是空的」。条目是纯文本，不在按钮内。 */}
            {rows.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-border/40 pt-2" data-testid={`catalog-all-preview-${s.species}`}>
                {rows.map((r) => (
                  <li key={r.name} className="flex items-baseline gap-1.5 text-xs">
                    <span className="shrink-0 font-medium text-foreground">{r.name}</span>
                    <span className="min-w-0 truncate text-muted-foreground">{r.blurb}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
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
