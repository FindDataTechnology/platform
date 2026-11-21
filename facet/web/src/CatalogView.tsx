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

import { SPECIES_SPECS, mapResponse, type CatalogItem, type Species } from "./catalog-model";
import { ServerDepth } from "./McpCatalog";
import { PackDetailDialog } from "@/components/packs/PackDetailDialog";

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
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [depth, setDepth] = useState<{ species: Species; id: string } | null>(null);
  // 就地只读详情（catalog-owns-browse-market-owns-trade 1.2）：pack 卡片打开它，
  // 不跳到 #/packs —— 跳走会丢掉访客的浏览位置与页签。
  const [detailId, setDetailId] = useState<string | null>(null);

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

  const shown = useMemo(() => filtered.slice(0, page * PAGE_SIZE), [filtered, page]);

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
        <TabButton id="all" current={tab} onPick={setTab} label={t("catalog.tabs.all")} />
        {SPECIES_SPECS.map((s) => (
          <TabButton
            key={s.species}
            id={s.species}
            current={tab}
            onPick={setTab}
            label={t(`catalog.species.${s.species}`, s.species)}
            count={counts?.[s.species]}
          />
        ))}
      </div>

      {tab === "all" ? (
        <AllSpecies counts={counts} onPick={setTab} />
      ) : (
        <>
          <input
            type="search"
            className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder={t("catalog.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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

          {state.kind === "ready" && filtered.length === 0 && (
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
                    onOpenDetail={() => setDetailId(item.id)}
                  />
                ))}
              </div>
              {filtered.length > shown.length && (
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
                  data-testid="catalog-more"
                >
                  {t("catalog.loadMore", { shown: shown.length, total: filtered.length })}
                </button>
              )}
            </>
          )}
        </>
      )}

      {/* 只读详情：installSurface={false} 让弹窗不渲染任何订阅/安装动作。
          交易仍在 #/packs —— 一个动作只在一个地方发生。 */}
      <PackDetailDialog
        packId={detailId}
        installSurface={false}
        readOnly

        onOpenChange={(open) => !open && setDetailId(null)}
        onSubscribed={() => {}}
      />
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
