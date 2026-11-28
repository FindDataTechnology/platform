// AgentSpecSheet — the shared three-bucket presentation (add-agent-spec-sheet).
//
// ONE component for every surface that presents an agent — market detail,
// conversation picker (compact), studio preview, official gallery. Consumers
// supply DATA and never a bucket layout of their own: the buckets (角色 /
// 技能 / 工具) always render in this fixed order, and an empty bucket renders
// an explicit empty state rather than being omitted.
//
// Derivations are NOT reimplemented here: the type badge and the provenance
// axes arrive pre-derived (server projections of lib/pack-badge.js /
// lib/pack-provenance.js — the single synthesis points). This component is a
// pure renderer of already-derived values.
//
// Guide content comes from the document data only: when the caller passes a
// `guide`, its steps render; when absent, no guide block renders and no
// client-side copy is injected (packGuides.ts is never imported here).
//
// Testids: `${testIdPrefix}-…`. The default prefix is "spec-sheet"; the pack
// detail dialog passes "pack" so its anchors (`pack-skill-*`,
// `pack-mcp-tool-face-*`, `pack-guide-card`, `pack-agent-serving-*`) stay
// byte-identical with the pre-sheet e2e suite.

import { useTranslation } from "react-i18next";
import { Badge } from "@/components/packs/Badge";
import { MemoryAxes } from "@/components/packs/MemoryAxes";
import { ConnectorTable } from "@/components/packs/ConnectorTable";
import { AcceptanceSection, MonitoringSection } from "@/components/packs/ContractSections";
import { cn } from "@/lib/utils";
import type { PackManifest, SpecPillars, SpecTeam } from "@/lib/packs-api";
// 重新导出：PackPillarsEditor 一直从这里取这两个类型（它们原本就定义在本文件里）。
export type { SpecPillars, SpecTeam };

export type SpecBadgeKind = "blueprint" | "facade" | "assistant" | "toolkit";

export interface SpecSkill {
  name: string;
  description?: string;
  content?: string;
  /** Tree-skill auxiliary paths (array) or the raw packaged-files map — the
   *  sheet lists only when it is an array (same guard the dialog always had). */
  files?: string[] | Record<string, string>;
}

export interface SpecMcpRef {
  registryName: string;
  requiredGroup?: string;
  /** Manifest display description (add-mcp-annotation-overlay), locale-projected
   *  by the read face when an overlay covers it; the raw registryName stays
   *  visible beside it either way. */
  description?: string | null;
  allowTools?: string[];
  fullSurface?: boolean;
  fullSurfaceReason?: string;
  /** Per-server total tool count from the catalog snapshot (null = unknown). */
  totalTools?: number | null;
}

/** One declared connector binding (manifest `connector_bindings[]`), as-is —
 *  the machine contract plus whatever prose the author wrote. The sheet shows
 *  this BEFORE install so a customer can see which external systems a pack
 *  needs and why; the grant screen (settings) shows the same words next to
 *  live state afterwards. */
export interface SpecBinding {
  key: string;
  provider: string;
  providerRole?: boolean;
  allowOperations?: Array<string | { provider?: string; operationType: string }>;
  allowActions?: string[];
  optional?: boolean;
  external_system?: string;
  surface?: string;
  direction?: string;
  credential?: string;
  note?: string;
}

export interface SpecGuide {
  steps: { title: string; body: string }[];
}

export interface SpecAgentRole {
  id: string;
  name: string;
  persona?: string;
  serving?: boolean;
  rhythm?: Array<{ daily?: string; every?: string; do?: string }>;
}

export interface AgentSpecSheetProps {
  /** Structure-derived type badge — pre-derived by the caller, never authored. */
  badge?: SpecBadgeKind | null;
  facade?: boolean;
  /** Roster-judged official flag + adopted provenance flag (both pre-derived). */
  official?: boolean;
  adopted?: boolean;
  /** Role blocks (persona bucket). Empty/absent renders the explicit empty state. */
  roles?: SpecAgentRole[];
  /** Standalone persona text when there are no role blocks (custom presets). */
  persona?: string | null;
  skills?: SpecSkill[] | null;
  mcp?: SpecMcpRef[] | null;
  /** Declared connector bindings (manifest `connector_bindings`), pre-install.
   *  Absent/empty ⇒ no block — a pack without bindings renders exactly as
   *  before, byte-identical surfaces stay byte-identical. */
  bindings?: SpecBinding[] | null;
  /** Document-sourced guide; absent → no guide block, no client fallback. */
  guide?: SpecGuide | null;
  variant?: "full" | "compact";
  testIdPrefix?: string;
  className?: string;
  /** Optional download-link builder for skill bodies (pack detail only). */
  skillHref?: (name: string) => string | null;
  /** Fork lineage (add-agent-fork-lineage): present ⇒ the sheet shows a
   *  "forked from" line; absent ⇒ no lineage line, nothing invented. */
  lineage?: { packId: string; version: number } | null;
  // ── Compact-mode count overrides (conversation picker): the picker roster
  // carries bucket COUNTS (resourceSummary), not manifests — when given they
  // replace the array-derived counts. Undefined = unknown = chip omitted
  // (unknown ≠ zero); zero renders the explicit zero chip.
  skillCount?: number;
  mcpCount?: number;
  personaPresent?: boolean;
  /** Team composition (openspec: team-derivation). The DERIVED result from the
   *  server (`deriveTeam`), passed through untouched — this component renders
   *  it, it never re-derives from the manifest. Absent ⇒ the roster section is
   *  not rendered at all (a caller that has no team data says nothing, rather
   *  than rendering an empty table that reads like a defect). A `state` of
   *  `undeclared` DOES render — "this pack is not a team" is an answer worth
   *  showing on a detail page, and it is different from "we didn't load it". */
  team?: SpecTeam | null;
  /** 三支柱派生（openspec: pillar-surfaces）。服务端 `derivePillars()` 的结果原样
   *  传入——本组件只渲染，不二次派生。Absent ⇒ 记忆/看板段不渲染（调用方没有数据
   *  时保持沉默，而不是画一个空表让人以为「查过了是空的」）。 */
  pillars?: SpecPillars | null;
  /** 给各桶打上详情页的章节锚点（pack-detail-as-page 2.2）。传了就按
   *  `roles/skills/mcp/memory/board` 命名；不传则完全不加属性（市场卡片等
   *  复用面保持原样）。 */
  sectionAnchors?: boolean;
  /** 产物卡声明（manifest `board[]`）。与 `console` 是两件事——见 OutputSection。 */
  board?: PackManifest["board"] | null;
  /** 监控声明（manifest `monitoring`）。 */
  monitoring?: PackManifest["monitoring"] | null;
}



/**
 * 记忆段（openspec: pillar-surfaces）。
 *
 * 三态各有不同文案，绝不合并成「空」：`undeclared` 是「本包没声明记忆」，
 * `present` 才有轴值，坏声明列 errors。**不显示「0 条记忆」**——未声明与确有
 * 零条是两件事，前者是产品选择、后者是运行态事实。
 *
 * 声明内容由 `MemoryAxes` 按四轴呈现（overhaul-pack-detail-presentation D2）：
 * 原来的 `<dl>` 把七个点号键平铺成七行，回答的是「manifest 写了什么」；读者问的是
 * 四个问题。每岗的记忆章程（`agents[].memory.guidance`）另成一段——它回答
 * 「谁记、记什么」，与四轴不是同一个问题。
 */
function PillarMemorySection({
  memory,
  testId,
  anchor,
}: {
  memory: SpecPillars["memory"];
  testId: string;
  anchor?: string;
}) {
  const { t } = useTranslation();
  if (memory.state === "undeclared") {
    return (
      <section data-testid={testId}>
        <h2 className="mb-2 font-medium">{t("packs.specSheet.memoryTitle")}</h2>
        <p className="text-xs italic text-muted-foreground" data-testid={`${testId}-undeclared`}>
          {t("packs.specSheet.memoryUndeclared")}
        </p>
      </section>
    );
  }
  if (memory.state === "invalid") {
    return (
      <section data-testid={testId}>
        <h2 className="mb-2 font-medium">{t("packs.specSheet.memoryTitle")}</h2>
        <ul className="space-y-1 text-xs text-destructive" data-testid={`${testId}-invalid`}>
          {(memory.errors ?? []).map((e) => <li key={e}>{e}</li>)}
        </ul>
      </section>
    );
  }
  const guidance = memory.guidance ?? [];
  return (
    <section data-testid={testId} data-section={anchor}>
      <h2 className="mb-2 font-medium">{t("packs.specSheet.memoryTitle")}</h2>
      <MemoryAxes rows={memory.rows ?? {}} testId={`${testId}-axes`} />
      {guidance.length > 0 && (
        <div className="mt-3" data-testid={`${testId}-charter`}>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            {t("packs.specSheet.memoryCharterTitle")}
          </h3>
          <ul className="space-y-1.5">
            {guidance.map((g) => (
              <li key={g.agentId ?? "pack"} className="text-xs leading-5 text-muted-foreground" data-testid={`${testId}-charter-${g.agentId ?? "all"}`}>
                <span className="font-mono text-foreground">{t("packs.specSheet.memoryCharterAgent", { role: g.agentId ?? "—" })}</span>
                <span> · </span>
                <span>{g.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * 看板段（openspec: pillar-surfaces）。
 *
 * `declared-not-instantiated` 与 `undeclared` 必须分开：前者是「声明了 N 块但还没
 * 实例化」，后者是「本包没有看板」。合成一句会让人以为这个包没有看板设计。
 *
 * 块名复用 `console.block.*`——团队控制台页（ConsoleBody）用同一组键渲染同一批块。
 * 详情页另起一套名字，会让同一个块在两个页面叫两个名字（overhaul-pack-detail-presentation
 * D3 / facet/web/DESIGN.md §9 一名一概念）。`headline` 是 `kpi.hit_rate` 形式的字段
 * 路径：只渲染它所属块的显示名，原始路径降为 title 属性——不猜字段的人话。
 */
function PillarDashboardSection({
  dashboard,
  testId,
  anchor,
}: {
  dashboard: SpecPillars["dashboard"];
  testId: string;
  anchor?: string;
}) {
  const { t } = useTranslation();
  if (dashboard.state === "undeclared") {
    return (
      <section data-testid={testId}>
        <h2 className="mb-2 font-medium">{t("packs.specSheet.dashboardTitle")}</h2>
        <p className="text-xs italic text-muted-foreground" data-testid={`${testId}-undeclared`}>
          {t("packs.specSheet.dashboardUndeclared")}
        </p>
      </section>
    );
  }
  const blocks = dashboard.blocks ?? [];
  // headline 的字段路径首段就是块 id（`kpi.hit_rate` → kpi）。
  const headlineBlock = dashboard.headline?.split(".")[0] ?? null;
  const headlineName = headlineBlock && blocks.some((b) => b.block === headlineBlock)
    ? t(`console.block.${headlineBlock}`, { defaultValue: headlineBlock })
    : headlineBlock;
  return (
    <section data-testid={testId} data-section={anchor}>
      <h2 className="mb-2 font-medium">{t("packs.specSheet.dashboardTitle")}</h2>
      <ul className="flex flex-wrap gap-1.5" data-testid={`${testId}-blocks`}>
        {blocks.map((b) => (
          <li
            key={b.block}
            className="rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-xs"
            data-testid={`${testId}-block-${b.block}`}
          >
            {t(`console.block.${b.block}`, { defaultValue: b.block })}
          </li>
        ))}
      </ul>
      {headlineName && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid={`${testId}-headline`} title={dashboard.headline ?? undefined}>
          {t("packs.specSheet.dashboardHeadline", { field: headlineName })}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{t("packs.specSheet.dashboardNotInstantiated")}</p>
    </section>
  );
}

/**
 * 团队编制段（openspec: team-derivation）。
 *
 * 四态各自渲染不同文案，**不合并**：
 *   present             → 岗位表 + 编排边 + 报数槽位
 *   undeclared          → 「本包不声明团队编制」（这是答案，不是缺失）
 *   not-instantiated    → 「已声明 N 岗 · 尚未建队」
 *   invalid             → 逐条列出 errors（判不了 ≠ 没有）
 *
 * 节奏列必须带「未在本宿主注册」的含义：这一段的读者会以为装完就按那个 cron 跑，
 * 而市场详情页不是执行面。
 */
function RosterSection({ team, testId }: { team: SpecTeam; testId: string }) {
  const { t } = useTranslation();

  if (team.state === "undeclared") {
    return (
      <section data-testid={testId}>
        <h2 className="mb-2 font-medium">{t("packs.specSheet.roster")}</h2>
        <p className="text-xs italic text-muted-foreground" data-testid={`${testId}-undeclared`}>
          {t("packs.specSheet.rosterUndeclared")}
        </p>
      </section>
    );
  }

  if (team.state === "invalid") {
    return (
      <section data-testid={testId}>
        <h2 className="mb-2 font-medium">{t("packs.specSheet.roster")}</h2>
        <ul className="space-y-1 text-xs text-destructive" data-testid={`${testId}-invalid`}>
          {(team.errors ?? []).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </section>
    );
  }

  const roster = team.roster ?? [];
  const edges = team.edges ?? [];
  const notInstantiated = team.state === "not-instantiated";
  // 交接边里只有 from/to 是人读的；`cron(...)` 形式的是触发器，不是交接。
  const handoffs = edges
    .filter((e) => (e.kind ?? "") !== "trigger" && e.from && e.to)
    .map((e) => `${e.from} → ${e.to}`);

  return (
    <section data-testid={testId}>
      <h2 className="mb-2 font-medium">{t("packs.specSheet.roster")}</h2>
      {notInstantiated && (
        <p className="mb-2 text-xs text-muted-foreground" data-testid={`${testId}-not-instantiated`}>
          {t("packs.specSheet.rosterNotInstantiated", { n: roster.length })}
        </p>
      )}
      <ul className="space-y-2" data-testid={`${testId}-list`}>
        {roster.map((r) => {
          // 槽位标签是作者写的中文名；键只是机器标识。同一对象里两者都有时取标签。
          const slots = r.kpiSlots
            .map((s) => (s.label ?? "").trim() || (s.key ?? "").trim())
            .filter(Boolean);
          return (
            <li
              key={r.ref}
              className="rounded-md border border-border/60 bg-background/60 px-3 py-1.5"
              data-testid={`${testId}-post-${r.ref}`}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm">{r.title}</span>
                {r.parentRef && (
                  <span className="text-xs text-muted-foreground">
                    {t("packs.specSheet.rosterReportsTo", { ref: r.parentRef })}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {r.cadence.declared
                    ? t("packs.specSheet.rosterCadence", { cron: r.cadence.cron })
                    : t("packs.specSheet.rosterOnDemand")}
                </span>
              </div>
              {slots.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5" data-testid={`${testId}-post-${r.ref}-slots`}>
                  {slots.map((s) => (
                    <span key={s} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {edges.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid={`${testId}-edges`}>
          {handoffs.length > 0
            ? t("packs.specSheet.rosterEdgesList", { list: handoffs.join(" · ") })
            : t("packs.specSheet.rosterEdgesEmpty")}
        </p>
      )}
    </section>
  );
}

/**
 * 工具面每岗收窄（overhaul-pack-detail-presentation D2/D3 同源）。
 *
 * `pillars.toolkit.roles[]` 说的是「这个岗位看到的工具比包级声明少，少在哪」。
 * 包级工具面由上面的 mcp 桶承担；这一段只补读者在别处看不到的那一层。
 * 三条文案沿用既有的 `roleNarrowed` / `roleFullSurface` / `roleNoTools`——它们
 * 在五语里都存在且此前引用为 0。
 */
function ToolkitNarrowingSection({
  toolkit,
  testId,
  anchor,
}: {
  toolkit: SpecPillars["toolkit"];
  testId: string;
  anchor?: string;
}) {
  const { t } = useTranslation();
  const roles = toolkit.roles ?? [];
  if (toolkit.state !== "present" || roles.length === 0) return null;
  // 全部岗位都没有收窄 = 这一段没有信息量（包级工具面已经说完）。
  if (!roles.some((r) => r.narrowed)) return null;

  return (
    <section data-testid={testId} data-section={anchor}>
      <h2 className="mb-2 font-medium">{t("packs.specSheet.toolkitNarrowing")}</h2>
      <ul className="space-y-1">
        {roles.map((r) => {
          const count = Object.values(r.effective ?? {}).reduce((acc, list) => acc + (Array.isArray(list) ? list.length : 0), 0);
          return (
            <li key={r.agentId ?? "all"} className="flex flex-wrap items-baseline gap-2 text-xs" data-testid={`${testId}-${r.agentId ?? "all"}`}>
              <span className="font-mono text-foreground">{r.agentId ?? "—"}</span>
              <span className="text-muted-foreground">
                {r.narrowed
                  ? t("packs.specSheet.roleNarrowed", { count })
                  : count > 0
                    ? t("packs.specSheet.roleFullSurface")
                    : t("packs.specSheet.roleNoTools")}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * 产物卡段（overhaul-pack-detail-presentation D5）。
 *
 * `board` 与 `console` 是两个概念，展示层必须用两个词：board 说「这支队产出
 * 什么」，console 说「主人怎么看它」（lib/board-spec.js 头注写明混用是真实失败
 * 模式）。段标题用「产出什么」，看板段的标题用「看板」。
 */
function OutputSection({ board, testId, anchor }: {
  board: NonNullable<PackManifest["board"]>;
  testId: string;
  anchor?: string;
}) {
  const { t } = useTranslation();
  return (
    <section data-testid={testId} data-section={anchor}>
      <h2 className="mb-2 font-medium">{t("packs.specSheet.output")}</h2>
      <ul className="space-y-2">
        {board.map((card, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 卡片的身份是 (artifact,title) 组合，同一张可以重复出现。
          <li key={`${i}-${card.title}`} className="rounded-md border border-border/60 bg-background/60 px-3 py-1.5" data-testid={`${testId}-card-${i}`}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm text-foreground">{card.title}</span>
              <span className="text-xs text-muted-foreground">
                {t(`packs.specSheet.outputArtifact.${card.artifact}`, { defaultValue: card.artifact })}
              </span>
            </div>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {t("packs.specSheet.outputDiscipline", { discipline: card.discipline })}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BucketSection({
  title,
  empty,
  children,
  count,
  testId,
  anchor,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
  count: number;
  testId: string;
  /** 详情页的章节锚点（pack-detail-as-page 2.2）：左栏列出哪几段，内容里就得
   *  有对应的锚点，否则那几行是死链。只在详情页传（它才有章节导航）。
   *
   *  空桶**不打锚点**（overhaul-pack-detail-presentation D6）：导航由「包实际声明
   *  了什么」决定，空桶不会出现在导航里；锚点却无条件打在 section 上，于是
   *  「内容有锚点、导航没有该项」——反向断言正是为这个缝写的。空桶仍然渲染
   *  （三桶恒显示的既有契约不变），只是不成章节。 */
  anchor?: string;
}) {
  return (
    <section data-testid={testId} data-section={count === 0 ? undefined : anchor}>
      <h2 className="font-medium mb-2">{title}</h2>
      {count === 0 ? (
        <p className="text-xs text-muted-foreground italic" data-testid={`${testId}-empty`}>
          {empty}
        </p>
      ) : (
        children
      )}
    </section>
  );
}

export function AgentSpecSheet({
  badge,
  facade,
  official,
  adopted,
  roles,
  persona,
  skills,
  mcp,
  bindings,
  guide,
  variant = "full",
  testIdPrefix = "spec-sheet",
  className,
  skillHref,
  lineage,
  skillCount,
  mcpCount,
  personaPresent,
  team,
  pillars,
  sectionAnchors = false,
  board,
  monitoring,
}: AgentSpecSheetProps) {
  const { t } = useTranslation();

  const roleRows: SpecAgentRole[] = roles ?? (persona ? [{ id: "persona", name: "", persona }] : []);
  const skillRows = skills ?? [];
  const mcpRows = mcp ?? [];

  // Compact mode (conversation picker): one line — badge (when supplied) +
  // bucket chips. Undefined counts stay hidden (unknown ≠ zero); zero renders
  // the explicit zero chip.
  if (variant === "compact") {
    const nSkills = skillCount ?? skillRows.length;
    const nMcp = mcpCount ?? mcpRows.length;
    const hasPersona = personaPresent ?? roleRows.length > 0;
    const showSkills = skillCount !== undefined || skillRows.length > 0;
    const showTools = mcpCount !== undefined || mcpRows.length > 0;
    return (
      <span
        className={cn("inline-flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground", className)}
        data-testid={`${testIdPrefix}-compact`}
      >
        {badge ? <Badge data-testid={`${testIdPrefix}-type-badge`}>{t(`packs.badge.${badge}`)}</Badge> : null}
        {facade ? <Badge data-testid={`${testIdPrefix}-facade-badge`}>{t("packs.market.facade")}</Badge> : null}
        {personaPresent !== undefined && (
          <span data-testid={`${testIdPrefix}-compact-persona`}>
            {hasPersona ? t("packs.detail.agents") : t("packs.specSheet.compactPersonaMissing")}
          </span>
        )}
        {showSkills && (
          <span data-testid={`${testIdPrefix}-compact-skills`}>
            {nSkills > 0 ? t("packs.specSheet.compactSkills", { n: nSkills }) : t("packs.specSheet.compactSkillsZero")}
          </span>
        )}
        {showTools && (
          <span data-testid={`${testIdPrefix}-compact-tools`}>
            {nMcp > 0 ? t("packs.specSheet.compactTools", { n: nMcp }) : t("packs.specSheet.compactToolsZero")}
          </span>
        )}
        {official === true && (
          <Badge data-testid={`${testIdPrefix}-official-badge`}>
            {t(adopted === true ? "packs.market.officialAdoptedBadge" : "packs.market.officialBadge")}
          </Badge>
        )}
      </span>
    );
  }

  // Tool-face text — the SAME i18n face strings the pack detail dialog has
  // always shown (packs.detail.toolFace*), so the sheet reads identically.
  const toolFace = (r: SpecMcpRef) => {
    const total = r.totalTools ?? null;
    const declared = Array.isArray(r.allowTools) && r.allowTools.length > 0 ? r.allowTools.length : null;
    if (declared !== null) {
      return t(total === null ? "packs.detail.toolFaceDeclaredNoTotal" : "packs.detail.toolFaceDeclared", {
        declared,
        total,
      });
    }
    if (r.fullSurface === true) {
      return t(total === null ? "packs.detail.toolFaceFullNoTotal" : "packs.detail.toolFaceFull", { total });
    }
    return t(total === null ? "packs.detail.toolFaceUndeclaredNoTotal" : "packs.detail.toolFaceUndeclared", { total });
  };

  return (
    <div className={cn("space-y-4", className)} data-testid={testIdPrefix}>
      {/* Badge row: type badge (structure-derived) + facade + provenance axes
          (official from the roster; adopted only WITH official — the same
          three-state discipline the market cards render). */}
      {lineage && (
        <p className="text-xs text-muted-foreground" data-testid={`${testIdPrefix}-lineage`}>
          {t("packs.specSheet.forkedFrom", { packId: lineage.packId, version: lineage.version })}
        </p>
      )}
      {(badge || facade || official) && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid={`${testIdPrefix}-badges`}>
          {badge ? <Badge data-testid={`${testIdPrefix}-type-badge`}>{t(`packs.badge.${badge}`)}</Badge> : null}
          {facade ? <Badge data-testid={`${testIdPrefix}-facade-badge`}>{t("packs.market.facade")}</Badge> : null}
          {official === true && adopted === true && (
            <Badge data-testid={`${testIdPrefix}-adopted-badge`}>{t("packs.market.officialAdoptedBadge")}</Badge>
          )}
          {official === true && adopted !== true && (
            <Badge data-testid={`${testIdPrefix}-official-badge`}>{t("packs.market.officialBadge")}</Badge>
          )}
        </div>
      )}

      {/* ── Bucket 1 · 角色 ── */}
      <BucketSection
        title={t("packs.detail.agents")}
        empty={t("packs.specSheet.emptyPersona")}
        count={roleRows.length}
        testId={`${testIdPrefix}-persona`}
        anchor={sectionAnchors ? "roles" : undefined}
      >
        <div className="space-y-2">
          {roleRows.map((a) => (
            <div key={a.id} className="border border-border rounded-md p-3" data-testid={`${testIdPrefix}-role-${a.id}`}>
              <div className="flex items-center gap-2">
                {a.name && <div className="text-foreground">{a.name}</div>}
                {a.serving && (
                  <span
                    data-testid={`${testIdPrefix}-agent-serving-${a.id}`}
                    className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-primary"
                  >
                    A2A
                  </span>
                )}
              </div>
              {/* Role id (mono) — pack role blocks only; the standalone
                  persona row (custom presets) has no meaningful id to show. */}
              {a.name && <div className="font-mono text-xs text-muted-foreground">{a.id}</div>}
              {!!a.rhythm?.length && (
                <div className="flex flex-wrap gap-1 mt-1" data-testid={`${testIdPrefix}-agent-rhythm-default-${a.id}`}>
                  {a.rhythm.map((r, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a rhythm can repeat (same cadence twice a day), so the index is part of the identity, not a stand-in for one.
                    <span key={`${r.daily ?? r.every}-${r.do ?? ""}-${j}`} className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {r.daily ?? r.every}
                      {r.do ? ` · ${r.do.slice(0, 18)}${r.do.length > 18 ? "…" : ""}` : ""}
                    </span>
                  ))}
                </div>
              )}
                            {/* 岗位正文折叠（overhaul-pack-detail-presentation D1 / agent-spec-sheet
                  「persona SHALL support a summary with expandable full text」）。
                  persona 是写给模型的工作指令（含内部工具名与判据），不是给读者的
                  介绍；一个团队包的岗位正文合计可占整页三分之一高度，读者在滚到
                  「这东西能干什么」之前就先撞上它。折叠态不生成任何新句子——
                  不派生摘要，避免同一份 manifest 有两个描述。 */}
              {a.persona && (
                <details className="mt-1 group" data-testid={`${testIdPrefix}-persona-body-${a.id}`}>
                  <summary className="cursor-pointer text-xs text-primary hover:underline">
                    <span className="group-open:hidden">{t("packs.specSheet.expandPersona")}</span>
                    <span className="hidden group-open:inline">{t("packs.specSheet.collapsePersona")}</span>
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{a.persona}</p>
                </details>
              )}
            </div>
          ))}
        </div>
      </BucketSection>

      {/* ── Bucket 2 · 技能 ── */}
      <BucketSection
        title={t("packs.detail.skills")}
        empty={t("packs.specSheet.emptySkills")}
        count={skillRows.length}
        testId={`${testIdPrefix}-skills`}
        anchor={sectionAnchors ? "skills" : undefined}
      >
        <div className="space-y-2">
          {skillRows.map((s) => {
            const href = skillHref ? skillHref(s.name) : null;
            return (
              <div key={s.name} className="border border-border rounded-md p-3" data-testid={`${testIdPrefix}-skill-${s.name}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-mono text-xs text-foreground">{s.name}</div>
                  {href && (
                    <a
                      href={href}
                      download
                      className="shrink-0 text-xs text-primary hover:underline"
                      data-testid={`${testIdPrefix}-skill-download-${s.name}`}
                    >
                      {t("packs.detail.downloadSkill")}
                    </a>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mb-1">{s.description}</div>
                {s.content && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      {t("packs.specSheet.skillBody")}
                    </summary>
                    <pre className="mt-1 whitespace-pre-wrap bg-muted/50 rounded p-2 max-h-48 overflow-auto">
                      {s.content}
                    </pre>
                  </details>
                )}
                {Array.isArray(s.files) && s.files.length > 0 && (
                  <div className="mt-1" data-testid={`${testIdPrefix}-skill-files-${s.name}`}>
                    <p className="text-xs font-medium text-muted-foreground">
                      {t("packs.detail.skillFiles", { count: s.files.length })}
                    </p>
                    <ul className="mt-0.5 max-h-24 space-y-0.5 overflow-y-auto">
                      {s.files.map((f) => (
                        <li key={f} className="font-mono text-[10px] text-muted-foreground">· {f}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </BucketSection>

      {/* ── Bucket 3 · 工具 ── */}
      <BucketSection
        title={t("packs.detail.mcp")}
        empty={t("packs.specSheet.emptyMcp")}
        count={mcpRows.length}
        testId={`${testIdPrefix}-mcp`}
        anchor={sectionAnchors ? "mcp" : undefined}
      >
        <ul className="space-y-1">
          {mcpRows.map((r) => (
            <li key={r.registryName} className="py-0.5">
              <div className="flex items-center gap-2">
                {/* add-mcp-annotation-overlay: the human description leads
                    when the manifest carries one — the raw registryName stays
                    visible (mono) and is never replaced. */}
                <span className="font-mono text-xs">{r.registryName}</span>
                {r.description && (
                  <span className="min-w-0 truncate text-xs text-foreground" data-testid={`${testIdPrefix}-mcp-description-${r.registryName}`}>
                    {r.description}
                  </span>
                )}
                {r.requiredGroup && <Badge>{t("packs.detail.requiresGroup", { group: r.requiredGroup })}</Badge>}
                <span className="text-xs text-muted-foreground" data-testid={`${testIdPrefix}-mcp-tool-face-${r.registryName}`}>
                  {toolFace(r)}
                </span>
              </div>
              {r.fullSurface === true && r.fullSurfaceReason && (
                <p
                  className="mt-0.5 text-xs text-muted-foreground"
                  data-testid={`${testIdPrefix}-mcp-full-surface-reason-${r.registryName}`}
                >
                  {t("packs.detail.toolFaceReason", { reason: r.fullSurfaceReason })}
                </p>
              )}
            </li>
          ))}
        </ul>
      </BucketSection>

      {/* 三支柱（openspec: pillar-surfaces）：记忆 / 工具收窄 / 看板。段序与
          `PILLAR_ORDER`（memory / toolkit / dashboard）一致。 */}
      {/* 锚点只在导航会列出这一项时才给（D6 的反向一半）：`sectionsFor` 按
          `state === "present"` 决定是否列章节，未声明/坏声明虽然仍渲染一句说明，
          但不成章节——否则「内容有锚点、导航没有该项」，反向断言会红。 */}
      {pillars && (
        <PillarMemorySection
          memory={pillars.memory}
          testId={`${testIdPrefix}-memory`}
          anchor={sectionAnchors && pillars.memory.state === "present" ? "memory" : undefined}
        />
      )}
      {pillars && <ToolkitNarrowingSection toolkit={pillars.toolkit} testId={`${testIdPrefix}-toolkit-narrowing`} anchor={sectionAnchors ? "toolkit" : undefined} />}
      {pillars && (
        <PillarDashboardSection
          dashboard={pillars.dashboard}
          testId={`${testIdPrefix}-dashboard`}
          anchor={sectionAnchors && pillars.dashboard.state === "present" ? "board" : undefined}
        />
      )}

      {/* 团队编制（openspec: team-derivation）。渲染服务端 `deriveTeam()` 的结果，
          不在这一层重新派生——「编制只在一处派生」是本模块存在的理由。 */}
      {team && <RosterSection team={team} testId={`${testIdPrefix}-roster`} />}

      {/* 验收断言（overhaul-pack-detail-presentation D5）。整段只在声明时出现：
          一个不声明验收的纯技能包不该长出一段「暂无验收」。 */}
      {team?.acceptance && team.acceptance.length > 0 && (
        <AcceptanceSection acceptance={team.acceptance} testId={`${testIdPrefix}-acceptance`} anchor={sectionAnchors ? "acceptance" : undefined} />
      )}

      {/* 监控（同一组新增段）。 */}
      {monitoring && (
        <MonitoringSection monitoring={monitoring} testId={`${testIdPrefix}-monitoring`} anchor={sectionAnchors ? "monitoring" : undefined} />
      )}

      {/* 产物卡（manifest `board[]`）——与下面的 console 段是两个概念，两个词。 */}
      {board && board.length > 0 && (
        <OutputSection board={board} testId={`${testIdPrefix}-output`} anchor={sectionAnchors ? "output" : undefined} />
      )}

      {/* Connector bindings (manifest `connector_bindings`), pre-install: the
          one place a customer sees WHICH external systems a pack needs and why,
          before deciding to install. Rendered only when the pack declares
          bindings — a pack without them renders exactly as before.
          表格而非散文（overhaul-pack-detail-presentation D4）：五个系统四段散文
          连成一句，读者无法跨系统比较「哪个要写权限」。 */}
      {bindings && bindings.length > 0 && (
        <section
          className="rounded-md border border-primary/30 bg-primary/5 p-3"
          data-testid={`${testIdPrefix}-bindings`}
        >
          <h2 className="mb-1 font-medium">{t("packs.specSheet.bindingsTitle")}</h2>
          <p className="mb-2 text-xs text-muted-foreground" data-testid={`${testIdPrefix}-bindings-hint`}>
            {t("packs.specSheet.bindingsHint")}
          </p>
          <ConnectorTable bindings={bindings} testId={`${testIdPrefix}-binding`} />
        </section>
      )}

      {/* Guide: document-sourced only. No guide data → no block, no copy. */}
      {guide && guide.steps.length > 0 && (
        <section className="rounded-md border border-primary/30 bg-primary/5 p-3" data-testid={`${testIdPrefix}-guide-card`}>
          <h2 className="mb-2 font-medium">{t("packs.guide.title")}</h2>
          <ol className="space-y-2" data-testid={`${testIdPrefix}-guide-steps`}>
            {guide.steps.map((s, i) => (
              <li key={s.title} className="text-xs">
                <span className="font-medium text-foreground">
                  {t("packs.guide.step", { n: i + 1 })} · {s.title}
                </span>
                <p className="mt-0.5 leading-5 text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
