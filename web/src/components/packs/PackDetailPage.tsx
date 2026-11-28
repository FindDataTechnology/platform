// ── 智能体详情页（pack-detail-as-page 1.x / 6.0）──────────────────────────────
//
// 把详情从 672×691 的模态弹窗换成有地址的整页。为什么换：弹窗里塞了 3,763px 内容
// （6 个屏），八段平级堆叠、无导航、版本历史折叠在最末——它承担不了「详细介绍 /
// 内容发现 / 历史迭代」。
//
// 形态（D1/D3）：三栏 —— 左章节导航（sticky）、中内容、右订阅卡（sticky）。
// 章节用锚点 + IntersectionObserver 高亮，**不新增 hash 路由**（hash 属于视图层）。
//
// 交易可见性（D2）：由**登录态**决定，不由来源决定。未登录看到「登录后可订阅」
// 说明行而不是置灰按钮——置灰会让人以为是 bug 或权限不足。
//
// 6.0：弹窗侵销前，它独有的六段（部署面板、facade 归属、cluster 成员、边界与覆盖度、
// 出处/结果/引导/示例、动作栏与脚本确认门）全部迁到这里——删弹窗不是删能力。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import * as api from "@/lib/packs-api";
import { sectionsFor } from "./pack-sections";
import type { PackDetail, PackManifest, PackReport } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/packs/Badge";
import { AgentSpecSheet, type SpecPillars, type SpecTeam } from "@/components/packs/AgentSpecSheet";
import { PackVersionSection } from "./PackVersionSection";
import { CapabilitySection } from "./CapabilitySection";
import type { PackCapability } from "@/lib/packs-api";
import { PackDeployPanel } from "./PackDeployPanel";
import { PackInstallReport } from "./PackInstallReport";
import { FacadeMattersPanel } from "./FacadeMattersPanel";
import { FleetTemplateWizard } from "./FleetTemplateWizard";
import { promptsFor, type PackGuide } from "@/lib/packGuides";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { fetchConsoleHandle, type ConsoleHandle } from "@/lib/fleet-owner-api";

export { sectionsFor } from "./pack-sections";
export type { DetailSection } from "./pack-sections";

// Authentication failures get a localized guidance line, never raw English
// (polish-facet-interactions): exact-match the platform's well-known
// "Authentication required" body; anything else passes through untouched.
function authErrorMessage(t: (k: string) => string, err: Error): string {
  if (err.message === "Authentication required") return t("packs.detail.authRequired");
  return err.message;
}

/**
 * 看板入口（reach-pack-console 2.2）。四态各自如实，不合并：
 *
 *   handle === undefined      查询未回/端点不可用 → 不渲染（不知道 ≠ 没有）
 *   handle === null           已声明但本机无此包的舰队 → 「需先建队」
 *   handle.slug === null      已建未发布 → 「看板未发布（可发布）」，无分享链接
 *   handle.slug 有值          已发布 → 「查看对外看板」→ onGotoBoard(slug)
 *
 * `castFleetId` 是向导刚建出的舰队 id：即便 handle 还没刷新到，也能立刻进控制台
 * （建完就该看得到，不该等下一次查询）。渲染归 TeamConsole，本组件只做入口。
 */
function BoardEntry({
  handle,
  castFleetId,
  onGotoConsole,
  onGotoBoard,
}: {
  handle: ConsoleHandle | null | undefined;
  castFleetId: string | null;
  onGotoConsole: (fleetId: string) => void;
  onGotoBoard?: (slug: string) => void;
}) {
  const { t } = useTranslation();
  // Prefer the freshly-cast id over a possibly-stale handle.
  const fleetId = castFleetId ?? handle?.fleetId ?? null;
  const slug = handle?.consoleSlug ?? null;

  if (fleetId) {
    return (
      <div className="space-y-1.5" data-testid="pack-board-entry">
        <Button variant="outline" className="w-full" onClick={() => onGotoConsole(fleetId)} data-testid="pack-board-open-console">
          {t("packs.detail.boardOpenConsole")}
        </Button>
        {slug && onGotoBoard && (
          <Button variant="ghost" className="w-full" onClick={() => onGotoBoard(slug)} data-testid="pack-board-open-share">
            {t("packs.detail.boardOpenShare")}
          </Button>
        )}
      </div>
    );
  }

  // No team yet — but the lookup may simply not have answered. Undefined = unknown.
  if (handle === undefined) return null;

  return (
    <p className="rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground" data-testid="pack-board-undeclared-yet">
      {t("packs.detail.boardNeedsTeam")}
    </p>
  );
}

export function PackDetailPage({
  packId,
  canTrade,
  installSurface = true,
  studioOrigin,
  onBack,
  onRequireLogin,
  onUsePrompt,
  onGotoMine,
  onFork,
  onOpenChat,
  onGotoConsole,
  onGotoBoard,
}: {
  packId: string | null;
  /** 观众是否有身份，**或**这个部署本就不认证（AUTH_MODE=none 的 demo/e2e/自托管：
   *  谁都能装）。两者都算「可以交易」——只按 authenticated 判会把不认证部署的交易面
   *  整块藏掉，那是把「匿名但允许」读成了「必须登录」。 */
  canTrade: boolean;
  /** Whether this host can install/deploy into a cell (壹座 true, facet false).
   *  False skips the deployment/billing probes — requests that can never carry
   *  data on that host. */
  installSurface?: boolean;
  studioOrigin?: string;
  onBack: () => void;
  onRequireLogin: () => void;
  onUsePrompt?: (prompt: string) => void;
  onGotoMine?: () => void;
  /** Fork crosses domains on facet; 壹座 navigates in place. Default = window. */
  onFork?: (packId: string) => void;
  /** 装满后的下一步（pack-detail-as-page 6.0 迁移）：装好的角色深链到聊天
   *  （多角色再带 cluster）。`null` = 本宿主没有会话面（facet 壳），不显示向导；
   *  省略 = 默认按 `target` 走 react-router 不可用时的 window 跳转。 */
  onOpenChat?: ((target: string) => void) | null;
  /** Reach a cast team's console (reach-pack-console). 壹座 wires this to
   *  `/fleets/:id/console`; facet omits it (no local fleet state) and the board
   *  entry says the board lives in 壹座. */
  onGotoConsole?: (fleetId: string) => void;
  /** Reach a published board's public share copy by slug. */
  onGotoBoard?: (slug: string) => void;
}) {
  const { t, i18n } = useTranslation();
  // 语言变化触发**静默重取**（overhaul-market-catalog-presentation P0 1.3）：
  // getPack 自己带 locale，切换语言后详情必须换成新语言的正文；重取期间保留
  // 旧内容，不退回骨架屏（读者刚切个语言不该看见整页闪一下）。
  const language = i18n.language;
  // 工具面披露（pack-tool-declaration-gate D4）：包里声明的是「用了哪些工具」，
  // 全量数来自 catalog 的 tool_list 快照（同一份数据源，不做实时探测）。迁移时
  // 漏了这一项会让「声明 2 / 全量 5 工具」退化成只报声明数。
  const { marketCatalog, refreshMarketCatalog } = useExtensionsStore();
  useEffect(() => {
    void refreshMarketCatalog();
  }, [refreshMarketCatalog]);
  // facet 壳没有 /api/extensions/market（那是壹座的端点），但它有
  // /api/mcp-catalog 且带每台服务器的 toolCount。两条路都接：壹座优先用
  // marketCatalog（toolList 数组长度），拿不到时回落到 facet 的 toolCount。
  // 都不通就是 null——未知不能编成 0。
  const [facetToolCounts, setFacetToolCounts] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/mcp-catalog")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { servers?: { name: string; toolCount?: number | null }[] } | null) => {
        if (!live || !d?.servers) return;
        const m: Record<string, number> = {};
        for (const sv of d.servers) {
          if (typeof sv.toolCount === "number") m[sv.name] = sv.toolCount;
        }
        setFacetToolCounts(m);
      })
      // 目录读不到（旧服务/离线）就保持 null：工具面退回只报声明数。
      .catch(() => live && setFacetToolCounts(null));
    return () => {
      live = false;
    };
  }, []);
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState("overview");
  const contentRef = useRef<HTMLDivElement | null>(null);
  // 点击章节后短暂抑制 IntersectionObserver：平滑滚动途中目标段的**上方**各段
  // 仍在视口内，观察器会把高亮写回上一段——表现是「点了版本历史，左栏停在边界」。
  // 抑制到滚动结束，让读者点的那个一直是高亮。
  const suppressUntil = useRef(0);
  // Report lives here now (D-report): subscribe happens on this page, so the
  // result must land on this page.
  const [report, setReport] = useState<PackReport | null>(null);

  const packIdRef = useRef(packId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `language` is the TRIGGER, not an input — getPack appends the locale itself
  useEffect(() => {
    if (!packId) {
      setState("missing");
      return;
    }
    const switched = packIdRef.current === packId;
    packIdRef.current = packId;
    let alive = true;
    // 同一包的换语言重取：保持当前内容，不闪骨架；换包才回到 loading。
    if (!switched) setState("loading");
    api
      .getPack(packId)
      .then((p) => {
        if (!alive) return;
        setPack(p);
        setState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        if (switched) return; // 静默重取失败：旧语言的正文留着，不砸成错误页
        // 404 与取数失败是两件事：前者是「这个包不在」，后者是「这次没取到」。
        const msg = String((e as Error)?.message ?? e);
        if (/404|not found/i.test(msg)) setState("missing");
        else {
          setErr(msg);
          setState("error");
        }
      });
    return () => {
      alive = false;
    };
  }, [packId, language]);

  const sections = useMemo(() => sectionsFor(pack, { installSurface }), [pack, installSurface]);

  // 当前章节高亮：IntersectionObserver 而不是自己算 scrollTop —— sticky 左栏、
  // 长短不一的段落让手工计算很容易漂。
  useEffect(() => {
    if (state !== "ready") return;
    const root = contentRef.current;
    if (!root) return;
    const els = sections
      .map((s) => root.querySelector(`[data-section="${s.id}"]`))
      .filter((e): e is Element => !!e);
    if (els.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (Date.now() < suppressUntil.current) return;
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.getAttribute("data-section") ?? "overview");
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: 0 },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [state, sections]);

  const jump = useCallback((id: string) => {
    const el = contentRef.current?.querySelector(`[data-section="${id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
    suppressUntil.current = Date.now() + 900;
  }, []);

  if (state === "missing") {
    return (
      <div className="p-8" data-testid="pack-page-missing">
        <p className="text-sm text-muted-foreground">{t("packPage.missing")}</p>
        <Button variant="outline" className="mt-4" onClick={onBack} data-testid="pack-page-back">
          ← {t("packPage.back")}
        </Button>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="p-8" data-testid="pack-page-error">
        <p className="text-sm text-destructive">{t("packPage.error", { message: err ?? "" })}</p>
        <Button variant="outline" className="mt-4" onClick={onBack}>
          ← {t("packPage.back")}
        </Button>
      </div>
    );
  }

  if (state === "loading" || !pack) {
    return (
      <div className="p-8" data-testid="pack-page-loading">
        <p className="text-sm text-muted-foreground">{t("packPage.loading")}</p>
      </div>
    );
  }

  const m = pack.manifest ?? {};
  const fork = onFork ?? ((id: string) => window.open(`${studioOrigin ?? ""}/studio?fork=${encodeURIComponent(id)}`, "_self"));

  return (
    <div className="flex gap-6 p-6" data-testid="pack-page">
      {/* 左：章节导航（sticky） */}
      <nav className="hidden w-44 shrink-0 lg:block" aria-label={t("packPage.outline")}>
        <div className="sticky top-4 space-y-1" data-testid="pack-page-outline">
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jump(s.id)}
              data-testid={`pack-section-link-${s.id}`}
              aria-current={active === s.id ? "true" : undefined}
              className={`block w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                active === s.id
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(s.labelKey)}
            </button>
          ))}
        </div>
      </nav>

      {/* 中：内容 */}
      {/* 正文列限宽（polish-facet-read-surfaces 6.1）：实测 1440 下正文 768px、
          约 110 字符每行 —— 眼睛换行时会串行。按字符数限宽而不是按容器百分比，
          因为「舒适行宽」是阅读属性、与屏幕宽度无关。代码块自己横向滚动。 */}
      <div className="min-w-0 flex-1 max-w-[64ch]" ref={contentRef} data-testid="pack-page-content">
        <button type="button" onClick={onBack} className="mb-4 text-sm text-primary hover:underline" data-testid="pack-page-back">
          ← {t("packPage.back")}
        </button>

        <header data-section="overview" className="space-y-2">
          {/* 结构徽章与来源徽章由下面的 AgentSpecSheet 统一渲染
              （overhaul-pack-detail-presentation D7）：规格书是共享契约，徽章属于
              它；宿主页头只保留**规格书不表达**的市场动作——私有可见性、定价、
              厂商署名。此前两处各渲一遍，`pack-official-badge` 在一页命中两个元素，
              针对该锚点的契约测试因此对后半页失明。 */}
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{pack.name}</h1>
            {pack.visibility === "private" && (
              <span data-testid="pack-private-badge" className="rounded-sm border border-status-waiting/50 bg-status-waiting/10 px-1.5 py-0.5 text-xs text-status-waiting">
                {t("packs.detail.private")}
              </span>
            )}
            {pack.adopted === true && (
              <span data-testid="pack-adopted-badge" className="rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                {t("packs.market.officialAdoptedBadge")}
              </span>
            )}
            {pack.vendor && <span className="text-primary" data-testid="pack-vendor-badge">{pack.vendor.name}</span>}
            {pack.pricing && (
              <span className="font-medium" data-testid="pack-pricing-badge">
                ${pack.pricing.priceUsd.toFixed(2)}
                {pack.pricing.periodDays ? t("packs.detail.perPeriod", { days: pack.pricing.periodDays }) : t("packs.detail.oneOff")}
                {pack.purchased === true && <span className="ml-1 text-primary">· {t("packs.detail.purchased")}</span>}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {pack.authorEmail} · v{pack.version}
            {pack.publishedAt ? ` · ${new Date(pack.publishedAt).toLocaleDateString()}` : ""}
          </p>
          <div className="flex items-start justify-between gap-2">
            <p className="max-w-3xl text-sm leading-relaxed">{pack.description}</p>
            <a
              href={`/api/packs/${pack.id}/versions/${pack.version}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-xs text-primary hover:underline"
              data-testid="pack-manifest-link"
            >
              {t("packs.detail.manifestJson")}
            </a>
          </div>
          {!!pack.tags?.length && (
            <div className="flex gap-1.5 flex-wrap">
              {pack.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          )}
          {pack.provenance?.source === "official-adopted" && pack.provenance.adopted && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-1" data-testid="pack-adopted-provenance">
              <p className="text-xs font-medium text-foreground">{t("packs.detail.adoptedHint")}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <a href={pack.provenance.adopted.upstreamUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline" data-testid="pack-adopted-upstream">
                  {t("packs.detail.adoptedUpstream", { name: pack.provenance.adopted.upstreamName })}
                </a>
                <span data-testid="pack-adopted-license">{t("packs.detail.adoptedLicense", { license: pack.provenance.adopted.license })}</span>
                <span data-testid="pack-adopted-revision" title={pack.provenance.adopted.revision}>
                  {t("packs.detail.adoptedRevision", { sha: String(pack.provenance.adopted.revision).slice(0, 8) })}
                </span>
              </div>
            </div>
          )}
        </header>

        <OutcomesGuideExamples pack={pack} onUsePrompt={onUsePrompt} />

        {/* 章节锚点分在 sheet 自己的各桶上（sectionAnchors）：左栏列的每一段
            必须能在内容里一步跳到，套一个大容器会让 Skills/Tools/Memory/Board
            全落到「角色」上。 */}
        <div className="mt-8">
          <AgentSpecSheet
            variant="full"
            sectionAnchors
            testIdPrefix="pack"
            badge={pack.badge ?? null}
            facade={pack.facade === true}
            official={pack.official === true}
            adopted={pack.adopted === true}
            roles={(m.agents ?? []).map((a) => ({
              id: a.id,
              name: a.name,
              persona: a.persona,
              serving: a.serving != null,
              rhythm: a.serving?.rhythm,
            }))}
            skills={m.skills ?? []}
            mcp={(m.mcpServers ?? []).map((r) => ({
              ...r,
              totalTools:
                marketCatalog?.mcpServers?.find((s) => s.name === r.registryName)?.toolList?.length ??
                facetToolCounts?.[r.registryName] ??
                null,
            }))}
            bindings={m.connector_bindings ?? []}
            board={m.board ?? null}
            monitoring={m.monitoring ?? null}
            pillars={(pack as { pillars?: SpecPillars | null }).pillars ?? null}
            team={(pack as { team?: SpecTeam | null }).team ?? null}
            skillHref={(name) => `/api/packs/${pack.id}/versions/${pack.version}/skills/${encodeURIComponent(name)}.md`}
            lineage={(pack.manifest?.provenance as { forkOf?: { packId: string; version: number } } | undefined)?.forkOf ?? null}
          />
        </div>

        {/* 能力视图（capability-layer）：把后端已推导的三轴条目表呈现出来。
            放在 AgentSpecSheet 之后——那一份是「逐项细看」，这一份是「一眼看全」。 */}
        <CapabilitySection
          capabilities={(pack as { capabilities?: PackCapability[] | null }).capabilities ?? null}
          anchor="capabilities"
        />

        {m.facade && (
          <section data-section="facade" className="mt-8" data-testid="pack-facade-info">
            <h2 className="mb-2 text-lg font-semibold text-primary">
              {t("packs.detail.facade.title")} <Badge>{t("packs.detail.facade.stanceHosted")}</Badge>
            </h2>
            <div className="space-y-1 text-sm" data-testid="pack-facade-attribution">
              <p className="text-muted-foreground">{t("packs.detail.facade.attribution", { owner: pack.authorEmail })}</p>
              <p className="text-muted-foreground" data-testid="pack-facade-asof">
                {t("packs.detail.facade.asOf", { date: new Date(pack.publishedAt).toLocaleDateString() })}
              </p>
            </div>
            <FacadeMattersPanel packId={pack.id} />
          </section>
        )}

        {m.cluster && (
          <section data-section="cluster" className="mt-8" data-testid="pack-cluster-info">
            <h2 className="mb-1 text-lg font-semibold text-primary">{t("packs.detail.cluster.title")}</h2>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-base font-semibold text-foreground">{m.cluster.name}</h3>
              <Badge data-testid="pack-cluster-agent-count">
                {t("packs.detail.cluster.agentCount", { count: m.agents?.length ?? 0 })}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mb-3">{m.cluster.description}</p>
            <ClusterMembers pack={pack} />
          </section>
        )}
        {installSurface && (
          <section data-section="deploy" className="mt-8">
            <PackDeployPanel pack={pack} />
          </section>
        )}

        {((m.notes ?? "").trim() !== "" || pack.coverage) && (
          <section data-section="boundary" className="mt-8 rounded-md border border-border bg-muted/30 p-3" data-testid="pack-detail-boundary">
            <h2 className="mb-1 font-medium">{t("packs.detail.boundary")}</h2>
            {(m.notes ?? "").trim() !== "" && (
              <p className="text-xs leading-5 text-muted-foreground" data-testid="pack-detail-boundary-notes">{m.notes}</p>
            )}
            {pack.coverage && (
              <div className={(m.notes ?? "").trim() !== "" ? "mt-2 border-t border-border/40 pt-2" : ""}>
                {pack.coverage.missing.length === 0 ? (
                  <p className="text-xs text-muted-foreground" data-testid="pack-detail-coverage">
                    {t("packs.detail.coverageFull", { locale: pack.coverage.locale })}
                  </p>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground" data-testid="pack-detail-coverage">
                      {t("packs.detail.coverage", {
                        locale: pack.coverage.locale,
                        covered: pack.coverage.covered,
                        total: pack.coverage.total,
                      })}
                    </p>
                    <p className="mt-1 text-xs font-medium text-muted-foreground">{t("packs.detail.coverageMissing")}</p>
                    <ul className="mt-0.5 space-y-0.5 font-mono text-[10px] leading-4 text-muted-foreground" data-testid="pack-detail-coverage-missing">
                      {pack.coverage.missing.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        <section data-section="versions" className="mt-8" data-testid="pack-page-versions">
          <h2 className="mb-3 text-lg font-semibold">{t("packPage.sections.versions")}</h2>
          <PackVersionSection
            packId={pack.id}
            currentVersion={pack.version}
            currentManifest={(pack.manifest ?? null) as PackManifest | null}
          />
        </section>
      </div>

      {/* 右：订阅卡（sticky） */}
      <aside className="hidden w-64 shrink-0 xl:block">
        <div className="sticky top-4 rounded-lg border border-border p-4" data-testid="pack-page-subscribe">
          {canTrade ? (
            <SubscribeCard
              pack={pack}
              onReport={setReport}
              onFork={() => fork(pack.id)}
              onGotoMine={onGotoMine}
              onGotoConsole={onGotoConsole}
              onGotoBoard={onGotoBoard}
            />
          ) : (
            <div data-testid="pack-page-login-required">
              <p className="text-sm text-muted-foreground">{t("packPage.loginToSubscribe")}</p>
              <Button className="mt-3 w-full" onClick={onRequireLogin} data-testid="pack-login-go">
                {t("packPage.signIn")}
              </Button>
            </div>
          )}
        </div>
      </aside>

      {report && (
        <PackInstallReport
          report={report}
          packName={pack.name}
          connector={report.connector ?? null}
          onClose={() => setReport(null)}
          footer={
            <NextStepsFooter
              report={report}
              packId={pack.id}
              onOpenChat={onOpenChat}
              onDismiss={() => setReport(null)}
            />
          }
        />
      )}
    </div>
  );
}

/** ② 你会得到 / 引导卡 / 示例问题 —— 三段只在有内容时出现，各自独立。 */
function OutcomesGuideExamples({ pack, onUsePrompt }: { pack: PackDetail; onUsePrompt?: (p: string) => void }) {
  const { t } = useTranslation();
  const m = pack.manifest;
  const [copied, setCopied] = useState<number | null>(null);
  const manifestGuide = (m as { guide?: { steps: { title: string; body: string }[]; examples?: { title: string; text: string }[] } } | undefined)?.guide;
  const guide: PackGuide | null = manifestGuide ? { name: pack.name, steps: manifestGuide.steps as PackGuide["steps"] } : null;
  // ② 你会得到 (specs/pack-display-format 缺省降级链): the v2 outcomes win;
  // otherwise three step TITLES from the guide compose the promise list.
  const outcomes: { title: string; detail?: string }[] =
    Array.isArray((m as { outcomes?: { title: string; detail?: string }[] }).outcomes) && (m as { outcomes?: { title: string; detail?: string }[] }).outcomes!.length > 0
      ? (m as { outcomes?: { title: string; detail?: string }[] }).outcomes ?? []
      : (manifestGuide?.steps ?? []).slice(0, 3).map((st) => ({ title: st.title }));
  const v2Examples = Array.isArray((m as { examples?: { title: string; prompt: string }[] }).examples)
    ? ((m as { examples?: { title: string; prompt: string }[] }).examples ?? []).map((e) => ({ title: e.title, text: e.prompt }))
    : [];
  const examples =
    v2Examples.length > 0 ? v2Examples : manifestGuide?.examples && manifestGuide.examples.length > 0 ? manifestGuide.examples : promptsFor(pack.id) ?? [];
  return (
    <>
      {outcomes.length > 0 && (
        <section className="mt-6 rounded-md border border-border p-3" data-testid="pack-detail-outcomes">
          <h2 className="mb-2 font-medium">{t("packs.detail.outcomes")}</h2>
          <ul className="space-y-1">
            {outcomes.slice(0, 5).map((o) => (
              <li key={o.title} className="text-xs leading-5">
                <span className="font-medium text-foreground">{o.title}</span>
                {o.detail ? <span className="text-muted-foreground"> — {o.detail}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      {guide && (
        <section className="mt-4 rounded-md border border-primary/30 bg-primary/5 p-3" data-testid="pack-guide-card">
          <h2 className="mb-2 font-medium">{t("packs.guide.title")}</h2>
          <ol className="space-y-2" data-testid="pack-guide-steps">
            {guide.steps.map((s, i) => (
              <li key={s.title} className="text-xs">
                <span className="font-medium text-foreground">
                  {t("packs.guide.step", { n: i + 1 })} · {s.title}
                </span>
                <p className="mt-0.5 leading-5 text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">{t("packs.guide.hint")}</p>
        </section>
      )}
      {examples.length > 0 && (
        <div className="mt-4 rounded-md border border-border p-3" data-testid="pack-guide-examples">
          <p className="text-xs font-medium text-muted-foreground">{t("packs.guide.examples")}</p>
          <ul className="mt-1 space-y-0.5">
            {examples.slice(0, 4).map((ex, i) => (
              <li key={ex.title}>
                <button
                  type="button"
                  data-testid={`pack-guide-example-${i}`}
                  className="text-left text-xs leading-5 text-primary hover:underline"
                  title={ex.text}
                  onClick={() => {
                    if (onUsePrompt) {
                      onUsePrompt(ex.text);
                      return;
                    }
                    // 宿主没有会话时复制到剪贴板——确认只在真的写成功时出现。
                    navigator.clipboard?.writeText(ex.text).then(() => setCopied(i)).catch(() => {});
                  }}
                >
                  · {ex.title}
                </button>
                {copied === i && (
                  <span className="ml-1.5 text-[10px] text-warning" data-testid="pack-guide-example-copied">
                    {t("packs.guide.copied")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** cluster 成员（agent-cluster-platform）：默认成员常显，可选项折叠。 */
function ClusterMembers({ pack }: { pack: PackDetail }) {
  const { t } = useTranslation();
  const m = pack.manifest;
  const [showOptional, setShowOptional] = useState(false);
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-2">{t("packs.detail.cluster.agents")}</p>
      <div className="space-y-1">
        {(m.cluster?.defaultAgents ?? []).map((agentId) => {
          const agent = m.agents?.find((a) => a.id === agentId);
          if (!agent) return null;
          return (
            <div key={agentId} className="flex items-center gap-2 text-xs" data-testid={`pack-cluster-default-agent-${agentId}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              <span className="font-medium text-foreground">{agent.name}</span>
              <span className="text-muted-foreground">({agentId})</span>
            </div>
          );
        })}
        {(m.cluster?.optionalAgents ?? []).length > 0 && (
          <>
            <Button variant="ghost" size="sm" className="h-6 text-xs pl-2" data-testid="pack-cluster-toggle-optional" onClick={() => setShowOptional((v) => !v)}>
              {showOptional ? t("packs.detail.cluster.hideOptional") : t("packs.detail.cluster.showOptional")}
            </Button>
            {showOptional && (
              <div className="ml-3 space-y-1 pt-1 border-l border-border pl-2">
                {(m.cluster?.optionalAgents ?? []).map((agentId) => {
                  const agent = m.agents?.find((a) => a.id === agentId);
                  if (!agent) return null;
                  return (
                    <div key={agentId} className="flex items-center gap-2 text-xs" data-testid={`pack-cluster-optional-agent-${agentId}`}>
                      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
                      <span className="text-foreground">{agent.name}</span>
                      <span className="text-muted-foreground">({agentId})</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 订阅卡：登录后才有。付费闸、脚本确认门、装作向导原样迁自弹窗。 */
function SubscribeCard({
  pack,
  onReport,
  onFork,
  onGotoMine,
  onGotoConsole,
  onGotoBoard,
}: {
  pack: PackDetail;
  onReport: (r: PackReport) => void;
  onFork: () => void;
  onGotoMine?: () => void;
  onGotoConsole?: (fleetId: string) => void;
  onGotoBoard?: (slug: string) => void;
}) {
  const { t } = useTranslation();
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  // Cast team id, set the moment the wizard finishes (reach-pack-console 1.1).
  // Holding it here — not discarding it — is what lets the card offer the
  // console entry instead of silently closing the wizard.
  const [castFleetId, setCastFleetId] = useState<string | null>(null);
  // The viewer's existing team for this pack (reach-pack-console 2.1):
  //   undefined = not looked up yet, null = no team, object = team (+slug).
  const [handle, setHandle] = useState<ConsoleHandle | null | undefined>(undefined);
  const declaresConsole = Boolean((pack.manifest as { console?: unknown } | null | undefined)?.console);
  // Script confirm gate (add-packaged-skills 5.1): set when the install
  // answered 400 code=script-confirm-required — the names + script files it
  // carries render the one-time acknowledgment; confirming retries.
  const [scriptGate, setScriptGate] = useState<{ name: string; scriptFiles: string[] }[] | null>(null);

  const subscribe = useCallback(
    async (confirmScripts = false) => {
      setSubscribing(true);
      setError(null);
      try {
        // 装前闸镜像（add-market-revenue-share）：付费条目先成交再订阅。
        if (pack.pricing && pack.purchased !== true) {
          await api.purchasePack(pack.id, true);
        }
        const sub = await api.subscribePack(pack.id);
        const { report } = await api.installPack(sub.packId, sub.version, confirmScripts);
        onReport(report);
      } catch (err) {
        const e = err as Error & { body?: { code?: string; details?: { name: string; scriptFiles: string[] }[] } };
        // 购买/装闸的失败如实分类（add-market-revenue-share）。
        if (e.body?.code === "insufficient-balance") return setError(t("packs.detail.purchase.insufficient"));
        if (e.body?.code === "billing-account-required") return setError(t("packs.detail.purchase.noBilling"));
        if (e.body?.code === "settlement-failed") return setError(t("packs.detail.purchase.settlementFailed"));
        if (e.body?.code === "market-purchase-required") return setError(t("packs.detail.purchase.required"));
        if (e.body?.code === "script-confirm-required") {
          setScriptGate(Array.isArray(e.body.details) ? e.body.details : []);
          return;
        }
        setError(authErrorMessage(t, e));
      } finally {
        setSubscribing(false);
      }
    },
    [onReport, pack.id, pack.pricing, pack.purchased, t],
  );

  // Look up the viewer's existing team for this pack, once, when the card can
  // actually offer a console entry (declared console + an install host wired to
  // it). No request otherwise — a pack with no console declaration pays nothing.
  // A failed lookup leaves `handle` undefined (unknown), and the block renders
  // nothing for unknown — never a false "no team".
  useEffect(() => {
    if (!declaresConsole || !onGotoConsole) return;
    let live = true;
    fetchConsoleHandle(pack.id)
      .then((h) => live && setHandle(h))
      .catch(() => live && setHandle(undefined));
    return () => {
      live = false;
    };
  }, [declaresConsole, onGotoConsole, pack.id]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {pack.pricing && pack.purchased !== true ? t("packPage.price", { price: pack.pricing.priceUsd.toFixed(2) }) : t("packPage.free")}
      </p>
      {error && <p className="text-xs text-destructive" data-testid="pack-subscribe-error">{error}</p>}
      <Button className="w-full" onClick={() => void subscribe()} disabled={subscribing} data-testid="pack-subscribe">
        {subscribing
          ? t("common.loading")
          : pack.pricing && pack.purchased !== true
            ? t("packs.detail.buyPack", { price: pack.pricing.priceUsd.toFixed(2) })
            : t("packs.detail.subscribe")}
      </Button>
      <Button variant="outline" className="w-full" onClick={onFork} data-testid="pack-fork" title={t("packs.detail.forkHint")}>
        {t("packs.detail.fork")}
      </Button>
      {pack.manifest?.fleet && !showWizard && (
        <Button variant="outline" className="w-full" onClick={() => setShowWizard(true)} data-testid="pack-fleet-wizard-open">
          {t("packs.detail.fleetWizardBtn")}
        </Button>
      )}
      {showWizard && (
        <FleetTemplateWizard
          pack={pack}
          onCancel={() => setShowWizard(false)}
          onDone={(fleetId) => {
            setShowWizard(false);
            // Keep the id — it is the console entry's only key. A null id
            // (cancel/failed cast) leaves the entry off; no dead link.
            if (fleetId) {
              setCastFleetId(fleetId);
              // Refresh the handle so a just-cast, just-published team reflects.
              fetchConsoleHandle(pack.id).then(setHandle).catch(() => {});
            }
          }}
        />
      )}
      {declaresConsole && onGotoConsole && (
        <BoardEntry
          handle={handle}
          castFleetId={castFleetId}
          onGotoConsole={onGotoConsole}
          onGotoBoard={onGotoBoard}
        />
      )}
      {onGotoMine && (
        <Button variant="ghost" className="w-full" onClick={onGotoMine} data-testid="pack-goto-mine">
          {t("packs.detail.gotoMine")}
        </Button>
      )}
      {scriptGate && (
        <div className="rounded-md border border-status-waiting/50 bg-status-waiting/10 p-2" data-testid="pack-script-confirm">
          <p className="text-xs font-medium">{t("packs.detail.scriptGateTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("packs.detail.scriptGateBody")}</p>
          <ul className="mt-1 max-h-32 overflow-y-auto text-xs">
            {scriptGate.map((b) => (
              <li key={b.name}>
                <span className="font-mono text-foreground">{b.name}</span>
                <ul className="ml-4 list-disc">
                  {b.scriptFiles.map((f) => (
                    <li key={f} className="text-status-waiting">{f}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setScriptGate(null)}>{t("common.cancel")}</Button>
            <Button size="sm" onClick={() => void subscribe(true)} disabled={subscribing} data-testid="pack-script-confirm-ok">
              {subscribing ? t("common.loading") : t("packs.detail.scriptGateConfirm")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 报告末尾的下一步向导（add-pack-tutorials-and-wizard）：装完直接进对话，
 *  CTA 带着刚装好的角色（多角色再带 cluster），不用再手动挑一次。
 *  `onOpenChat === null` 的宿主（facet 匿名壳，没有会话面）整块不渲染。 */
function NextStepsFooter({
  report,
  packId,
  onOpenChat,
  onDismiss,
}: {
  report: PackReport;
  packId: string;
  onOpenChat?: ((target: string) => void) | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  if (onOpenChat === null) return null;
  const installed = (report.agents ?? []).filter(
    (a) => a.status === "installed" || a.status === "reused" || a.status === "replaced",
  );
  const clusterMode = installed.length >= 2;
  const target =
    installed.length === 0
      ? "/chat"
      : clusterMode
        ? `/chat?preset=${encodeURIComponent(installed[0]!.id)}&cluster=${encodeURIComponent(packId)}`
        : `/chat?preset=${encodeURIComponent(installed[0]!.id)}`;
  return (
    <div
      className="mt-3 flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
      data-testid="pack-install-next"
    >
      <span className="text-xs text-muted-foreground">
        {t(clusterMode ? "packs.report.nextHintCluster" : "packs.report.nextHint")}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        onClick={() => {
          onDismiss();
          if (onOpenChat) onOpenChat(target);
          else window.location.assign(target);
        }}
        data-testid="pack-install-open-chat"
      >
        {t(clusterMode ? "packs.report.openChatCluster" : "packs.report.openChat")}
      </button>
    </div>
  );
}

export default PackDetailPage;