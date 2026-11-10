// MemoryPage.tsx — 记忆面板（add-unified-memory-and-outputs 3.3, spec:
// memory-portal-ui）。owner 看自己的 u/ 记忆：类型/层/tier/tag/时间筛选，
// reference 名份行可跳资料库/成果原位；降级态解释而不空转。
// add-memory-visible-ux 任务 3 增量：本周节奏条（漏斗旁四计数，可点入落
// 预置筛选）+ 时间线 Tabs（倒序混排 + harness 徽标）。红线不动：漏斗主视图、
// 晋升箱第一区块、分层浏览语义；聚合口径全在前端纯函数（test/memory-dashboard
// .test.mjs 直测），后端零新增面。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  listMemoryEntries, listPromotions, acceptPromotion, ignorePromotion,
  type MemoryEntry, type MemoryQuery, type PromotionProposal,
} from "@/api/memory";
import { Tabs } from "@/components/ui/tabs";

const LAYERS = ["L0", "L1", "L2"] as const;
const TIERS = ["draft", "stable", "canonical"] as const;

const LAYER_LABEL: Record<string, string> = { L0: "观察", L1: "笔记/交接", L2: "事实/经验" };

// ── 纯函数区（add-memory-visible-ux 任务 3）────────────────────────────────
// 聚合口径全部收在这里，test/memory-dashboard.test.mjs 以 typescript transpile
// + react 桩直测这些导出（web 无组件测试设施，纯函数是唯一可执行缝）。

export interface WeeklyCounts {
  capture: number;
  note: number;
  correction: number;
  pendingPromotion: number;
}

// 本周一 00:00（本地时区，ISO 8601 周制以周一为首）。「本周」窗口取法全站仅此一处。
export function startOfWeek(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // getDay: 0=Sun → 平移到周一为首
  return d;
}

// 本周节奏四计数（spec: memory-portal-ui「本周节奏条」）。口径：
//   捕获=窗口内 L0 计数；note=窗口内 L1 计数；更正=窗口内标题以「更正」为前缀
//   （与纠错写入约定一致，design.md D3）；待晋升=promotions 数（与晋升箱同源）。
// fetch 已带 since=本周一，这里再按 ts 过滤一次作双保险——上周条目混入也不算。
// now 参数仅供测试注入，缺省取当前时刻。
export function weeklyCounts(
  items: MemoryEntry[],
  promotions: PromotionProposal[],
  now: Date = new Date(),
): WeeklyCounts {
  const since = startOfWeek(now).getTime();
  let capture = 0;
  let note = 0;
  let correction = 0;
  for (const it of items ?? []) {
    const ts = Date.parse(String(it.ts ?? ""));
    if (Number.isFinite(ts) && ts < since) continue; // 上周不算
    const l = String(it.layer ?? "").toUpperCase();
    if (l === "L0") capture += 1;
    else if (l === "L1") note += 1;
    if (String(it.title ?? "").trimStart().startsWith("更正")) correction += 1; // 前缀判定，句中「更正」不算
  }
  return { capture, note, correction, pendingPromotion: Array.isArray(promotions) ? promotions.length : 0 };
}

// 时间线混排（spec:「时间线叙述视图」）：ts 倒序单列；同 ts 保持原序（稳定排序，
// 显式 index 决胜，不依赖宿主 sort 稳定性）；ts 缺失/不可解析视为最旧沉底。
export function timelineSort<T extends { ts?: string | null }>(items: T[]): T[] {
  return (items ?? [])
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const pa = Date.parse(String(a.it.ts ?? ""));
      const pb = Date.parse(String(b.it.ts ?? ""));
      const ta = Number.isFinite(pa) ? pa : 0;
      const tb = Number.isFinite(pb) ? pb : 0;
      if (ta !== tb) return tb - ta;
      return a.i - b.i;
    })
    .map((x) => x.it);
}

// L0 来源徽标取值：metadata 实测两形态——对象 {harness:"xxx"} 或 JSON 字符串
// （经代理透传的直出 JSON）。非对象/坏 JSON/非字符串 harness 一律空串=不渲染徽标。
export function entryHarness(metadata: unknown): string {
  let m: unknown = metadata;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return "";
    }
  }
  if (!m || typeof m !== "object") return "";
  const h = (m as { harness?: unknown }).harness;
  return typeof h === "string" ? h : "";
}

// entries 代理透传的条目可能带 metadata（api/memory.ts 的 MemoryEntry 未声明，
// 此处局部补型，不动公共 API 面）。
type MemoryEntryRow = MemoryEntry & { metadata?: { harness?: string } | string | null };

export function MemoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [items, setItems] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [layer, setLayer] = useState<string | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [scope, setScope] = useState<string>("");
  // 待确认晋升（add-tier-promotion-candidates 5.1）：AI 提议、人批。读失败
  // 静默——这个区块是列表上的增益，坏了不能拖累记忆本面。
  const [promotions, setPromotions] = useState<PromotionProposal[]>([]);
  const [busyPromotion, setBusyPromotion] = useState<string | null>(null);
  // add-memory-visible-ux 任务 3：视图 Tabs 与本周节奏。since 是既有筛选 state
  // 的第四员（week 预置筛选落点），view 只切列表渲染、与筛选 state 共享。
  const [view, setView] = useState<"browse" | "timeline">("browse");
  const [since, setSince] = useState<string | null>(null);
  const [weeklyItems, setWeeklyItems] = useState<MemoryEntry[]>([]);
  const [weeklyFailed, setWeeklyFailed] = useState(false);
  // 本周窗口：挂载时定一次（跨零点刷新面板即得新周，不追着时钟跑）。
  const weekStart = useMemo(() => startOfWeek(new Date()), []);
  const weekStartISO = weekStart.toISOString();

  const loadPromotions = useCallback(async () => {
    try {
      const out = await listPromotions(scope.trim() || undefined);
      setPromotions(out.proposals);
    } catch {
      setPromotions([]);
    }
  }, [scope]);

  useEffect(() => {
    void loadPromotions();
  }, [loadPromotions]);

  // 本周节奏条数据（add-memory-visible-ux 任务 3）：独立于主列表的一次 entries
  // 拉（since=本周一×全 layer×大 limit），不掺 layer/tier/scope 筛选——节奏是
  // 面板级口径，不随下方浏览筛选变。失效=置 weeklyFailed，节奏条走解释性降级
  // （显示说明文案，绝不画零），不拖累主列表。
  useEffect(() => {
    let alive = true;
    listMemoryEntries({ since: weekStartISO, limit: 200 })
      .then((out) => {
        if (!alive) return;
        setWeeklyItems(out.items);
        setWeeklyFailed(false);
      })
      .catch(() => {
        if (alive) setWeeklyFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [weekStartISO]);

  const load = useCallback(async () => {
    setLoading(true);
    setDegraded(null);
    const q: MemoryQuery = { limit: 100 };
    if (layer) q.layer = layer;
    if (tier) q.tier = tier;
    if (scope.trim()) q.scope = scope.trim();
    if (since) q.since = since; // 本周预置筛选（节奏条点入落点）
    try {
      const out = await listMemoryEntries(q);
      setItems(out.items);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setDegraded(code === "memory_unavailable" ? t("memory.degraded.unavailable") : String((e as Error).message));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [layer, tier, scope, since, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const runPromotionGesture = async (kind: "accept" | "ignore", path: string) => {
    setBusyPromotion(path);
    try {
      await (kind === "accept" ? acceptPromotion(path) : ignorePromotion(path));
    } catch {
      /* 降级静默：手势失败不打断面板，提议留在面上可重试 */
    } finally {
      setBusyPromotion(null);
      setPromotions((prev) => prev.filter((p) => p.path !== path));
      void load(); // 接受会翻 tier——列表/徽章取最新（5.2 复用既有 tier 渲染，不另造解析）
    }
  };

  const projects = useMemo(() => [...new Set(items.map((i) => i.project))].slice(0, 8), [items]);

  // Distillation funnel (add-knowledge-memory-surface 4.2): L0→L1→L2 counts and
  // shares over the CURRENT filter result, so the funnel and the list below
  // always speak the same numbers. Clicking a segment applies that layer filter
  // (the same one the chip row sets). Degraded state never draws a fake funnel.
  const funnel = useMemo(() => {
    const counts: Record<"L0" | "L1" | "L2", number> = { L0: 0, L1: 0, L2: 0 };
    for (const it of items) {
      const l = String(it.layer ?? "").toUpperCase();
      if (l === "L0" || l === "L1" || l === "L2") counts[l] += 1;
    }
    const total = counts.L0 + counts.L1 + counts.L2;
    return { counts, total };
  }, [items]);

  // 本周节奏四计数（口径见 weeklyCounts 注释）。promotions 用实时 state——
  // 接受/忽略晋升后计数随晋升箱同步，不需要重拉 entries。
  const weekly = useMemo(() => weeklyCounts(weeklyItems, promotions), [weeklyItems, promotions]);

  // 节奏条点入落点（spec: 计数可点入沿用既有筛选语义，落点=时间窗预置筛选）。
  // 节奏计数不掺 tier/scope（weekly 拉取未带），落位时一并清掉，保证「计数与
  // 列表一致」；更正条目无 layer 界定 → 只落时间窗。
  const landOnWeek = useCallback(
    (l: "L0" | "L1" | null) => {
      setSince(weekStartISO);
      setLayer(l);
      setTier(null);
      setScope("");
    },
    [weekStartISO],
  );

  return (
    <div className="flex h-full flex-col bg-background" data-testid="memory-page">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">{t("memory.title")}</h1>
          <span className="text-xs text-muted-foreground">{t("memory.subtitle")}</span>
          <div className="ml-auto flex items-center gap-2">
            <input
              className="w-40 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              placeholder={t("memory.scopePlaceholder")}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              data-testid="memory-scope"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="memory-filters">
          <span className="text-xs text-muted-foreground">{t("memory.layerLabel")}</span>
          {([null, ...LAYERS] as const).map((l) => (
            <button
              key={`layer-${l ?? "all"}`}
              className={`rounded-md px-2.5 py-1 text-xs ${layer === l ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => setLayer(l)}
              data-testid={`memory-layer-${l ?? "all"}`}
            >
              {l === null ? t("memory.all") : `${l}·${LAYER_LABEL[l]}`}
            </button>
          ))}
          <span className="ml-2 text-xs text-muted-foreground">{t("memory.tierLabel")}</span>
          {([null, ...TIERS] as const).map((tr) => (
            <button
              key={`tier-${tr ?? "all"}`}
              className={`rounded-md px-2.5 py-1 text-xs ${tier === tr ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => setTier(tr)}
              data-testid={`memory-tier-${tr ?? "all"}`}
            >
              {tr === null ? t("memory.all") : t(`resources.memory.tier.${tr}`)}
            </button>
          ))}
          {/* 本周窗激活提示（节奏条点入的落点可视回执），点击解除时间窗。 */}
          {since ? (
            <button
              type="button"
              className="ml-2 rounded-full bg-primary/15 px-2.5 py-1 text-xs text-primary hover:opacity-80"
              onClick={() => setSince(null)}
              data-testid="memory-filter-week"
            >
              {t("memoryWeekly.week")} ×
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {/* Distillation funnel (add-knowledge-memory-surface 4.2) — the primary
            view: L0→L1→L2 counts + shares over the current filter result.
            Clicking a segment applies that layer filter. Degraded state shows
            the explanation (below), never a zero-drawn funnel. */}
        {!degraded && !loading && funnel.total > 0 ? (
          <div className="mb-4 rounded-md border border-border bg-card p-3" data-testid="memory-funnel">
            <div className="text-xs font-medium text-muted-foreground">{t("memory.funnel.title")}</div>
            <div className="mt-2 flex items-end gap-2" data-testid="memory-funnel-bars">
              {(["L0", "L1", "L2"] as const).map((l, i) => {
                const n = funnel.counts[l];
                const pct = funnel.total ? Math.round((n / funnel.total) * 100) : 0;
                // Widening bars read as a funnel; colour tracks depth.
                const tone = i === 0 ? "bg-muted-foreground/30" : i === 1 ? "bg-primary/40" : "bg-primary";
                return (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLayer(l)}
                    data-testid={`memory-funnel-seg-${l}`}
                    className={`flex-1 rounded-md px-2 py-2 text-left hover:opacity-80 ${layer === l ? "ring-2 ring-primary" : ""}`}
                    title={t("memory.funnel.segTitle", { layer: l, count: n, pct })}
                  >
                    <div className={`h-1.5 rounded-full ${tone}`} style={{ width: `${Math.max(pct, 4)}%` }} />
                    <div className="mt-1.5 flex items-baseline gap-1.5">
                      <span className="text-sm font-semibold tabular-nums">{n}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {l}·{LAYER_LABEL[l]} · {pct}%
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {/* 本周节奏条（add-memory-visible-ux 任务 3, spec: memory-portal-ui
            「本周节奏条」）：紧贴漏斗区块（漏斗旁四计数）。四格口径见 weeklyCounts；
            前三格可点入落「since=本周一+对应 layer」预置筛选，待晋升不是时间窗
            筛选（晋升箱已在第一区块）→ 静态格。weekly 拉取失效走解释性降级
            （说明文案，绝不画零）。 */}
        {weeklyFailed ? (
          <div
            className="mb-4 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
            data-testid="memory-weekly-degraded"
          >
            {t("memoryWeekly.degraded")}
          </div>
        ) : !degraded && !loading ? (
          <div className="mb-4 rounded-md border border-border bg-card p-3" data-testid="memory-weekly">
            <div className="text-xs font-medium text-muted-foreground">{t("memoryWeekly.title")}</div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="memory-weekly-cells">
              {([
                { key: "capture", n: weekly.capture, land: "L0" as const },
                { key: "note", n: weekly.note, land: "L1" as const },
                { key: "correction", n: weekly.correction, land: null },
              ]).map(({ key, n, land }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => landOnWeek(land)}
                  title={t("memoryWeekly.segTitle", { n })}
                  data-testid={`memory-weekly-${key}`}
                  className={`rounded-md border border-border bg-background px-3 py-2 text-left hover:bg-muted ${
                    since && layer === land && land !== null ? "ring-2 ring-primary" : ""
                  }`}
                >
                  <div className="text-sm font-semibold tabular-nums">{n}</div>
                  <div className="text-[11px] text-muted-foreground">{t(`memoryWeekly.${key}`)}</div>
                </button>
              ))}
              <div
                className="rounded-md border border-border bg-background px-3 py-2"
                title={t("memoryWeekly.pendingHint")}
                data-testid="memory-weekly-promotions"
              >
                <div className="text-sm font-semibold tabular-nums">{weekly.pendingPromotion}</div>
                <div className="text-[11px] text-muted-foreground">{t("memoryWeekly.pending")}</div>
              </div>
            </div>
          </div>
        ) : null}
        {/* Promotion box sits above the list (spec: 晋升箱第一区块). */}
        {!degraded && promotions.length > 0 ? (
          <div className="mb-4 rounded-md border border-primary/30 bg-primary/5 p-3" data-testid="memory-promotions">
            <div className="text-sm font-medium text-primary" data-testid="memory-promotions-count">
              {t("memory.promotions.title")} <span className="text-xs font-normal text-muted-foreground">({promotions.length})</span>
            </div>
            <div className="mt-2 space-y-2">
              {promotions.map((p) => (
                <div key={p.path} className="rounded-md border border-border bg-background px-3 py-2" data-testid="memory-promotion">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm" data-testid="memory-promotion-title">{p.title}</span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {t(`resources.memory.tier.${p.current_tier}`)} → {t(`resources.memory.tier.${p.proposed_tier}`)}
                    </span>
                  </div>
                  {p.reason ? <div className="mt-1 text-xs text-muted-foreground">{p.reason}</div> : null}
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
                      onClick={() => void runPromotionGesture("accept", p.path)}
                      disabled={busyPromotion === p.path}
                      data-testid="memory-promotion-accept"
                    >
                      {t("memory.promotions.accept")}
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                      onClick={() => void runPromotionGesture("ignore", p.path)}
                      disabled={busyPromotion === p.path}
                      data-testid="memory-promotion-ignore"
                    >
                      {t("memory.promotions.ignore")}
                    </button>
                    <span className="text-xs text-muted-foreground">{String(p.proposed_at ?? "").slice(0, 10)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {/* 视图 Tabs（add-memory-visible-ux 任务 3, spec:「时间线叙述视图」）：
            只切列表渲染（分层浏览/时间线），共享同一 items 与筛选 state——
            分页/筛选/降级语义原样沿用，不另造读取面。 */}
        {!degraded && !loading ? (
          <div className="mb-3 flex items-center gap-2" data-testid="memory-view-tabs">
            {/* 视图切换走 foundation Tabs（unify-tab-idiom 1.4）：只切渲染，
                共享同一 items 与筛选 state。`memory-tab-<v>` 保留。 */}
            <Tabs
              ariaLabel={t("memoryTimeline.tabBrowse")}
              items={[
                { id: "browse", label: t("memoryTimeline.tabBrowse") },
                { id: "timeline", label: t("memoryTimeline.tabTimeline") },
              ]}
              value={view}
              onChange={(id) => setView(id as "browse" | "timeline")}
              itemProps={(id) => ({ "data-testid": `memory-tab-${id}` })}
            />
          </div>
        ) : null}
        {degraded ? (
          <div className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground" data-testid="memory-degraded">
            {degraded}
          </div>
        ) : loading ? (
          <div className="text-sm text-muted-foreground">{t("memory.loading")}</div>
        ) : items.length === 0 ? (
          <div className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground" data-testid="memory-empty">
            {t("memory.empty")}
          </div>
        ) : view === "timeline" ? (
          /* 时间线（add-memory-visible-ux 任务 3）：同一 entries 按 ts 倒序混排
             单列（timelineSort：同 ts 稳定）。L0 带「来自 {harness}」来源徽标
             （metadata 两形态见 entryHarness），note/L2 带标题+tier 徽章。 */
          <div className="space-y-2" data-testid="memory-timeline">
            {timelineSort(items).map((it) => {
              const isL0 = String(it.layer ?? "").toUpperCase() === "L0";
              const harness = isL0 ? entryHarness((it as MemoryEntryRow).metadata) : "";
              return (
                <div key={it.path} className="rounded-md border border-border px-3 py-2" data-testid="memory-timeline-item">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {it.layer}·{it.type ?? "page"}
                    </span>
                    {harness ? (
                      <span
                        className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary"
                        data-testid="memory-entry-harness"
                      >
                        {t("memoryTimeline.fromHarness", { harness })}
                      </span>
                    ) : null}
                    {!isL0 && it.tier && it.tier !== "draft" ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs border ${it.tier === "canonical" ? "border-status-waiting/50 bg-status-waiting/10 text-status-waiting" : "border-primary/40 bg-primary/10 text-primary"}`}
                      >
                        {t(`resources.memory.tier.${it.tier}`)}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-sm" data-testid="memory-timeline-title">{it.title}</span>
                    <span className="text-xs text-muted-foreground">{String(it.ts ?? "").slice(0, 10)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((it) => (
              <div key={it.path} className="rounded-md border border-border px-3 py-2" data-testid="memory-entry">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {it.layer}·{it.type ?? "page"}
                  </span>
                  {it.tier && it.tier !== "draft" ? (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs border ${it.tier === "canonical" ? "border-status-waiting/50 bg-status-waiting/10 text-status-waiting" : "border-primary/40 bg-primary/10 text-primary"}`}
                    >
                      {t(`resources.memory.tier.${it.tier}`)}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm" data-testid="memory-entry-title">{it.title}</span>
                  <span className="text-xs text-muted-foreground">{String(it.ts ?? "").slice(0, 10)}</span>
                </div>
                {(it.tags?.length ?? 0) > 0 || it.source_ref ? (
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    {it.tags?.map((tag) => (
                      <span key={tag} className="rounded-full bg-muted/60 px-2 py-0.5">{tag}</span>
                    ))}
                    {it.source_ref?.startsWith("resource:") ? (
                      <button
                        type="button"
                        className="rounded-md border border-border px-2 py-0.5 hover:bg-muted"
                        onClick={() => navigate("/resources")}
                        data-testid="memory-jump-source"
                      >
                        {t("memory.openInLibrary")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {projects.length > 1 ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t("memory.projects")}</span>
            {projects.map((p) => (
              <button key={p} className="rounded-md border border-border px-2 py-0.5 hover:bg-muted" onClick={() => setScope(p)}>
                {p}
              </button>
            ))}
          </div>
        ) : null}
        {/* Standalone portal hint (adopt-yongyi-client-sdk task 4): self-hosted /
            other-harness Yongyi has its own human-facing portal. Low-key footer
            line; the /memory panel itself stays the native React view. */}
        <p className="mt-4 text-xs text-muted-foreground" data-testid="memory-standalone-portal-hint">
          {t("memory.standalonePortalHint")}
        </p>
      </div>
    </div>
  );
}

export default MemoryPage;
