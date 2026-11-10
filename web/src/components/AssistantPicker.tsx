// AssistantPicker — the unified「与谁对话」selector (simplify-chat-and-agents-ia).
//
// ONE surface for choosing who the conversation runs as, replacing the
// two-door split: the welcome state's composition-mode dropdown
// (AgentPresetPicker) and the control strip's ⋯ agent section. The same
// component serves both placements (`variant="welcome"` centered under the
// greeting, `variant="header"` as the session header's compact control).
//
// Sources (design D6): the agent roster is PRIMARY — it carries the pack/
// custom-preset/cluster metadata and the focus badges. The preset roster
// contributes only composition modes; every persona preset materialized from
// the catalog also exists as an agent, so a preset whose id (normalized by
// the same rosterPresetId transform the server writes) matches an agent id
// renders ONCE, as the agent row.
//
// D1: shipped composition modes other than `standard` are hidden unless the
// deployment layout opts in (app config `compositionModesVisible`) — they are
// runtime-composition choices, not conversation partners.
//
// Switch semantics are the existing contracts, unchanged: composition
// (`set_preset`) only before the session's first turn — dsh refuses to
// recompose a session with turns, so in-session rows are disabled with the
// reason; persona (`set_agent`) any time outside a stream, restart-carrying
// for local packs (`pendingConfig` spinner until the broadcast). The
// `agent-preset-picker` testid contract from the retired picker carries over
// unchanged, with agent rows wearing `data-preset-id` of their agent id.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, SlidersHorizontal, TriangleAlert, UserRound, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import type { ClientMessage } from "@platform/core";
import type { PresetInfo } from "@platform/core";
import type { AgentInfo } from "@platform/core";
import { useAppConfig } from "@/hooks/useAppConfig";
import { OverlayPanel } from "@/components/OverlayPanel";
import { AgentSpecSheet } from "@/components/packs/AgentSpecSheet";
import { cn } from "@/lib/utils";

const SHIPPED_PRESET_IDS = new Set(["standard", "code", "minimal", "cordis"]);

// Mirrors dsh-profile.rosterPresetId — the transform the server applies when
// materializing a catalog persona as a preset. Dedupe must key on the same
// transform or a mixed-case agent id would render twice.
const rosterKey = (id: string) => id.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

// The four shipped preset ids. Their preset.yml metadata is zh-only, so the
// web bundle owns localized names/descriptions; any other (user or unknown)
// preset renders the file-published name/description verbatim.
export function presetDisplayName(preset: PresetInfo, t: (k: string) => string): string {
  return SHIPPED_PRESET_IDS.has(preset.id) ? t(`chat.preset.names.${preset.id}`) : preset.name;
}

export function presetDisplayDescription(preset: PresetInfo, t: (k: string) => string): string {
  return SHIPPED_PRESET_IDS.has(preset.id)
    ? t(`chat.preset.descriptions.${preset.id}`)
    : preset.description;
}

interface Props {
  send: (m: ClientMessage) => void;
  variant: "welcome" | "header";
}

export function AssistantPicker({ send, variant }: Props) {
  const { t } = useTranslation();
  const { compositionModesVisible } = useAppConfig();
  const presets = useChatStore((s) => s.presets);
  const currentPreset = useChatStore((s) => s.currentPreset);
  const agents = useChatStore((s) => s.agents);
  const currentAgent = useChatStore((s) => s.currentAgent);
  const turns = useChatStore((s) => s.turns);
  const pendingConfig = useChatStore((s) => s.pendingConfig);
  const setPendingConfig = useChatStore((s) => s.setPendingConfig);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const [open, setOpen] = useState(false);
  const [clusterLoading, setClusterLoading] = useState<string | null>(null);
  // The 资源微调 dialog role (add-focus-overlay): preset-scoped, applies on
  // the role's next selection. Declared with the other hooks — the
  // nothing-to-choose early return below must not skip it.
  const [overlayRole, setOverlayRole] = useState<{ id: string; name: string; packName?: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Composition presets the picker offers: shipped modes filtered to
  // `standard` unless the layout opts in, minus every preset that a roster
  // agent already represents (the agent row wins — one entity, one row).
  const agentKeys = useMemo(() => new Set(agents.map((a) => rosterKey(a.id))), [agents]);
  const compositionRows = useMemo(
    () =>
      presets.filter((p) => {
        if (agentKeys.has(rosterKey(p.id))) return false;
        if (SHIPPED_PRESET_IDS.has(p.id) && p.id !== "standard" && !compositionModesVisible) return false;
        return true;
      }),
    [presets, agentKeys, compositionModesVisible],
  );

  // Persona sections from the agent roster. Pack roles group by pack, and a
  // pack declaring cluster metadata renders its group header with the
  // load-entire-cluster affordance (defaults first — the lead).
  const packAgents = useMemo(() => agents.filter((a) => a.packId), [agents]);
  const myExperts = useMemo(() => agents.filter((a) => a.customPreset), [agents]);
  const otherAgents = useMemo(
    () => agents.filter((a) => !a.packId && !a.customPreset),
    [agents],
  );
  const packGroups = useMemo(() => {
    const byPack = new Map<string, AgentInfo[]>();
    for (const a of packAgents) byPack.set(a.packId!, [...(byPack.get(a.packId!) ?? []), a]);
    const groups: Array<{ packId: string; name: string; rows: AgentInfo[] }> = [];
    for (const [packId, list] of byPack) {
      const plain = list.filter((a) => !a.clusterId);
      const clusters = new Map<string, AgentInfo[]>();
      for (const a of list) {
        if (a.clusterId) clusters.set(a.clusterId, [...(clusters.get(a.clusterId) ?? []), a]);
      }
      const rows: AgentInfo[] = [...plain];
      for (const group of clusters.values()) {
        group.sort((x, y) => Number(y.isDefaultAgent ?? false) - Number(x.isDefaultAgent ?? false));
        rows.push(...group);
      }
      groups.push({ packId, name: list[0]?.packName || packId, rows });
    }
    return groups;
  }, [packAgents]);

  // Render rule: any composition row (the standard row alone renders the
  // picker — the retired picker's behavior, and the delta's welcome-state
  // scenario), or any persona choice beyond the single default agent. A
  // deployment with neither (no roster, one local agent) renders no control.
  const hasChoice =
    compositionRows.length > 0 || agents.length > 1 || packAgents.length > 0 || myExperts.length > 0;
  if (!hasChoice) return null;

  const pending = pendingConfig === "preset" || pendingConfig === "agent";
  // Composition is fixed once a session has turns (dsh contract) — the rows
  // stay visible with the reason rather than vanishing.
  const canCompose = turns.length === 0;

  const personaName = agents.find((a) => a.id === currentAgent)?.name || currentAgent;
  const compositionName = (() => {
    const p = presets.find((x) => x.id === currentPreset);
    return p ? presetDisplayName(p, t) : currentPreset ?? t("chat.preset.unset");
  })();
  const triggerLabel = currentAgent && currentAgent !== "local" ? personaName : compositionName;

  // Load-entire-cluster (agent-cluster-core): bind a dynamic cluster to the
  // current session and switch to its lead. The runtime hosts ONE persona at
  // a time — loading a cluster means running under its lead.
  const loadCluster = async (clusterId: string, name: string, group: AgentInfo[]) => {
    const sessionId = useChatStore.getState().currentSessionId;
    if (!sessionId) return;
    setClusterLoading(clusterId);
    try {
      const r = await fetch("/api/clusters/dynamic", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          agents: group.map((a) => ({ packId: a.packId, agentId: a.id })),
          bindToSession: true,
          sessionId,
        }),
      });
      if (r.ok) {
        const lead = group.find((a) => a.isDefaultAgent) ?? group[0];
        if (lead && lead.id !== currentAgent) {
          setPendingConfig("agent");
          send({ type: "set_agent", id: lead.id });
        }
        setOpen(false);
      }
    } finally {
      setClusterLoading(null);
    }
  };

  const choosePreset = (p: PresetInfo) => {
    setOpen(false);
    if (p.broken || !canCompose || p.id === currentPreset || pendingConfig) return;
    setPendingConfig("preset");
    send({ type: "set_preset", id: p.id });
  };

  const chooseAgent = (a: AgentInfo) => {
    setOpen(false);
    if (a.id === currentAgent || isStreaming || pendingConfig) return;
    setPendingConfig("agent");
    send({ type: "set_agent", id: a.id });
  };

  const focusBadge = (a: AgentInfo) =>
    a.packId || a.customPreset ? (
      <span
        data-testid="strip-agent-focus-badge"
        title={a.packId ?? a.id}
        className="ml-auto shrink-0 rounded-sm border border-primary/40 bg-primary/10 px-1 py-px text-[9px] font-medium leading-tight text-primary"
      >
        {a.customPreset
          ? t("composer.strip.agentFocusedCustom", {
              skills: a.resourceSummary?.skillCount ?? 0,
              mcp: a.resourceSummary?.mcpCount ?? 0,
            })
          : t("composer.strip.agentFocused", {
              pack: a.packName || a.packId,
              skills: a.resourceSummary?.skillCount ?? 0,
              mcp: a.resourceSummary?.mcpCount ?? 0,
            })}
      </span>
    ) : undefined;

  const agentRow = (a: AgentInfo) => (
    <div key={a.id} className="flex items-center gap-0.5">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={a.id === currentAgent}
        disabled={isStreaming || pendingConfig !== null}
        onClick={() => chooseAgent(a)}
        data-testid="agent-preset-option"
        data-preset-id={a.id}
        className={cn(
          "flex min-w-0 flex-1 flex-col items-start gap-0.5 px-3 py-1.5 text-left text-xs",
          "disabled:cursor-not-allowed disabled:opacity-40",
          a.id === currentAgent ? "bg-muted text-foreground" : "text-foreground hover:bg-muted/60",
        )}
      >
        <span className="flex w-full items-center gap-1.5">
          <span className="min-w-0 truncate font-mono">{a.name || a.id}</span>
          {a.customPreset && (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
              <UserRound className="h-2.5 w-2.5" aria-hidden="true" />
              {t("chat.preset.userBadge")}
            </span>
          )}
          {focusBadge(a)}
        </span>
        {a.name && a.id !== a.name && <span className="w-full truncate text-[10px] text-muted-foreground">{a.id}</span>}
        {/* Compact spec sheet (add-agent-spec-sheet): the SAME component the
            market detail renders, compact density. Data-driven from the
            roster — bucket chips only when the roster carries counts
            (resourceSummary, add-persona-resource-sets); roster roles always
            have a persona. No type badge today: the catalog does not project
            the pack badge onto roster entries yet. */}
        {a.resourceSummary && (
          <AgentSpecSheet
            variant="compact"
            testIdPrefix={`agent-spec-${a.id}`}
            personaPresent={true}
            skillCount={a.resourceSummary.skillCount}
            mcpCount={a.resourceSummary.mcpCount}
            className="pt-0.5"
          />
        )}
      </button>
      {(a.packId || a.customPreset) && (
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setOverlayRole({ id: a.id, name: a.name || a.id, packName: a.packName });
          }}
          aria-label={t("overlay.adjust")}
          title={t("overlay.adjust")}
          data-testid={`strip-agent-adjust-${a.id}`}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );

  const clusterHeader = (cid: string, group: AgentInfo[]) => (
    <div key={`cluster-${cid}`} className="px-3 pb-1 pt-2">
      <div
        data-testid="strip-cluster-header"
        className="micro-label flex items-center gap-1.5 font-medium text-muted-foreground"
      >
        <Users className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{group[0]?.clusterName || cid}</span>
        <span className="shrink-0 rounded-sm border border-border px-1 py-px text-[9px]">{group.length}</span>
        <button
          type="button"
          disabled={clusterLoading === cid}
          onClick={() => void loadCluster(cid, group[0]?.clusterName || cid, group)}
          data-testid="strip-cluster-load"
          title={t("composer.strip.clusterLoadHint")}
          className="ml-auto shrink-0 rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          {clusterLoading === cid ? t("composer.strip.clusterLoading") : t("composer.strip.clusterLoad")}
        </button>
      </div>
    </div>
  );

  const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <div className="micro-label px-3 pb-1 pt-2 font-medium text-muted-foreground">
      {children}
    </div>
  );

  const trigger = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      disabled={pendingConfig !== null}
      aria-label={t("chat.assistant.label")}
      aria-haspopup="menu"
      aria-expanded={open}
      data-testid="agent-preset-picker"
      data-pending={pending ? "true" : undefined}
      className={cn(
        variant === "welcome"
          ? "flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:border-primary/40 hover:bg-muted/50"
          : "flex max-w-[12rem] items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50",
        open && "border-primary/40",
      )}
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : null}
      <span className="truncate">{triggerLabel}</span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
    </button>
  );

  return (
    <div ref={ref} className={variant === "welcome" ? "relative" : "relative flex items-center"}>
      {open && (
        <div
          role="menu"
          data-testid="agent-preset-picker-menu"
          className={cn(
            "absolute z-50 mt-1 w-[24rem] max-w-[90vw] overflow-hidden rounded-lg border border-border bg-popover shadow-lg",
            variant === "welcome"
              ? "left-1/2 top-full -translate-x-1/2"
              : "right-0 top-full",
          )}
        >
          <div className="max-h-[22rem] overflow-y-auto py-1">
            {compositionRows.length > 0 && (
              <div className="border-b border-border py-1">
                <SectionLabel>{t("chat.assistant.standardSection")}</SectionLabel>
                {compositionRows.map((p) => {
                  const active = p.id === currentPreset && (!currentAgent || currentAgent === "local");
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      disabled={!!p.broken || !canCompose || pendingConfig !== null}
                      onClick={() => choosePreset(p)}
                      data-testid="agent-preset-option"
                      data-preset-id={p.id}
                      data-broken={p.broken ? "true" : undefined}
                      title={p.broken || (!canCompose ? t("chat.assistant.composeLocked") : undefined)}
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs",
                        p.broken || !canCompose
                          ? "cursor-not-allowed opacity-50"
                          : active
                            ? "bg-muted text-foreground"
                            : "text-foreground hover:bg-muted/60",
                      )}
                    >
                      <span className="flex w-full items-center gap-1.5">
                        <span className="truncate font-mono">{presetDisplayName(p, t)}</span>
                        {p.trust === "user" && (
                          <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
                            <UserRound className="h-2.5 w-2.5" aria-hidden="true" />
                            {t("chat.preset.userBadge")}
                          </span>
                        )}
                        {p.broken && (
                          <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[10px] text-destructive">
                            <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                            {t("chat.preset.brokenBadge")}
                          </span>
                        )}
                      </span>
                      {presetDisplayDescription(p, t) && (
                        <span className="line-clamp-2 text-[10px] text-muted-foreground">
                          {presetDisplayDescription(p, t)}
                        </span>
                      )}
                      {p.broken && <span className="w-full truncate text-[10px] text-destructive">{p.broken}</span>}
                    </button>
                  );
                })}
              </div>
            )}

            {packGroups.length > 0 && (
              <div className="border-b border-border py-1">
                <SectionLabel>{t("chat.assistant.packSection")}</SectionLabel>
                {packGroups.map((g) => {
                  // Cluster rows are contiguous (plain roles first, then one
                  // run per cluster, lead first) — the header precedes each
                  // run's first member exactly once.
                  const emittedClusters = new Set<string>();
                  return (
                    <div key={g.packId}>
                      <div className="px-3 pb-0.5 pt-1.5 text-[10px] text-muted-foreground">{g.name}</div>
                      {g.rows.map((a) => (
                        <Fragment key={a.id}>
                          {a.clusterId && !emittedClusters.has(a.clusterId)
                            ? (emittedClusters.add(a.clusterId),
                              clusterHeader(
                                a.clusterId,
                                g.rows.filter((r) => r.clusterId === a.clusterId),
                              ))
                            : null}
                          {agentRow(a)}
                        </Fragment>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}

            {myExperts.length > 0 && (
              <div className="border-b border-border py-1">
                <SectionLabel>{t("chat.assistant.mineSection")}</SectionLabel>
                {myExperts.map(agentRow)}
              </div>
            )}

            {otherAgents.length > 0 && (
              <div className="py-1">
                <SectionLabel>{t("chat.assistant.otherSection")}</SectionLabel>
                {otherAgents.map(agentRow)}
              </div>
            )}
          </div>
        </div>
      )}
      {variant === "welcome" ? (
        <section aria-labelledby="welcome-assistant-heading" className="flex flex-col items-center gap-2">
          <h2 id="welcome-assistant-heading" className="text-sm font-medium text-muted-foreground">
            {t("chat.assistant.label")}
          </h2>
          {trigger}
        </section>
      ) : (
        trigger
      )}

      <OverlayPanel
        role={overlayRole}
        open={overlayRole !== null}
        onOpenChange={(o) => {
          if (!o) setOverlayRole(null);
        }}
      />
    </div>
  );
}
