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
import { cn } from "@/lib/utils";

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
}

function BucketSection({
  title,
  empty,
  children,
  count,
  testId,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
  count: number;
  testId: string;
}) {
  return (
    <section data-testid={testId}>
      <h4 className="font-medium mb-2">{title}</h4>
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
  guide,
  variant = "full",
  testIdPrefix = "spec-sheet",
  className,
  skillHref,
  lineage,
  skillCount,
  mcpCount,
  personaPresent,
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
                    /* biome-ignore lint/suspicious/noArrayIndexKey: read-only chips from an immutable manifest snapshot — never reordered */
                    <span key={j} className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {r.daily ?? r.every}
                      {r.do ? ` · ${r.do.slice(0, 18)}${r.do.length > 18 ? "…" : ""}` : ""}
                    </span>
                  ))}
                </div>
              )}
              {a.persona && <p className="text-xs whitespace-pre-wrap mt-1">{a.persona}</p>}
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

      {/* Guide: document-sourced only. No guide data → no block, no copy. */}
      {guide && guide.steps.length > 0 && (
        <section className="rounded-md border border-primary/30 bg-primary/5 p-3" data-testid={`${testIdPrefix}-guide-card`}>
          <h4 className="mb-2 font-medium">{t("packs.guide.title")}</h4>
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
