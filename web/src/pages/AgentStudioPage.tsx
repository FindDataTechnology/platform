// AgentStudioPage — the unified authoring workspace (add-agent-builder-workspace).
//
// Three panes: document library (left) · canvas (center) · context inspector
// (right). Every document is a PERSISTED blueprint record (design D1: the
// ephemeral working document is retired — autosave rides the existing
// optimistic-lock PUT; the draft pool is the workspace's own storage and
// lands no market/cast/cluster artifact before approval, the
// fleet-blueprint-studio doctrine verbatim). The inspector ALWAYS describes
// the document open on the canvas (design D4 — the production-screenshot
// mismatch, center editing the blueprint while the right pane validated an
// empty ephemeral doc, is structurally impossible here). The lifecycle is one
// ribbon projecting the server's real state machine (design D3), and the
// retired team-mode tab / second editor host are gone: one editor, one truth.
//
// Batch 1 scope: team-shaped documents (kind arrives with batch 2); the
// skills bucket is not editable here yet (assembleManifest carries none — a
// bucket that silently drops at cast would be a false green).

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Blocks, PanelLeft, PanelRight, Pencil, Plus, Sparkles, X } from "lucide-react";
import { useChatStore } from "@platform/core";
import { useAuthStore } from "@/hooks/useAuth";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import * as bp from "@/lib/blueprint-api";
import type { Blueprint, BlueprintContent, BlueprintSummary, TrialReport, ValidationVerdict } from "@/lib/blueprint-api";
import * as presetsApi from "@/lib/presets-api";
import * as packsApi from "@/lib/packs-api";
import type { PackManifest, PackManifestAgent, PackManifestMcp, PackManifestSkill } from "@/lib/packs-api";
import { AgentSpecSheet } from "@/components/packs/AgentSpecSheet";
import { AgentBucketsEditor } from "@/components/studio/AgentBucketsEditor";
import { DocumentLibrary, DOC_STATUS_TONE } from "@/components/studio/DocumentLibrary";
import { LifecycleRibbon } from "@/components/studio/LifecycleRibbon";
import { ValidationPanel } from "@/components/studio/ValidationPanel";
import { AiDraftOverlay, type DraftField } from "@/components/studio/AiDraftOverlay";
import { FleetGraph } from "@/components/FleetGraph";
import { teamRibbon } from "@/lib/workspace-lifecycle";
import { projectFleetDocCanvas, applyDraftEdgesToFleet, edgeKeyOf, type DraftEdgeOp } from "@/lib/workspace-canvas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StatusPill } from "@/components/ui/status-pill";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { showToast } from "@/components/ui/toast";
import { useDocSoftLock } from "@/lib/workspace-soft-lock";
import { recordStudioMetric } from "@/lib/studio-metrics";
import { cn } from "@/lib/utils";

// 6.1: the writable team graph rides the SHARED FleetCanvas — lazy-loaded so
// the @xyflow chunk never enters the workspace's first paint (same seam the
// fleets page uses; the risk note in design D6 keeps this a hard gate).
const FleetCanvas = lazy(() => import("@/components/fleet/FleetCanvas").then((m) => ({ default: m.FleetCanvas })));

function SectionCard({ title, children, testid, anchor }: { title: string; children: React.ReactNode; testid: string; anchor?: string }) {
  return (
    <div className="rounded-md border border-border p-3" data-testid={testid} {...(anchor ? { "data-anchor": anchor } : {})}>
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const trialOf = (b: Blueprint | null): TrialReport | null => {
  const r = b?.trialReport as { ranAt?: number; signoff?: { by?: string; reportRanAt?: number } } | null | undefined;
  return r && typeof r.ranAt === "number" ? (r as unknown as TrialReport) : null;
};

// runOrigin (add-supply-studio-migration 2.2): when hosted on the facet
// domain, the run domain (壹座) origin to hand the deploy deep link to — the
// honest boundary of D4. Undefined on the 壹座 host, where the deploy action
// keeps its direct same-domain API path (byte-for-byte unchanged).
//
// onExit / onNavigate (overhaul-facet-shell-ia-and-space D4): a host embedding
// this page in its own shell may not carry 壹座's routes. The page used to
// render `<Link to="/agents?tab=build">` and navigate to cross-domain
// destinations unconditionally, so on the facet shell — whose local route
// table holds only the creation face — those controls were no-ops a viewer
// could click forever (supply-studio: 不存在静默无操作). A host now supplies the
// landing for "back" and gets first refusal on every destination: return true
// to claim it (the host moves its own view or opens a real link), false to let
// this page's router handle it. Both props are optional, so 壹座 keeps its
// exact behaviour.
export function AgentStudioPage({
  runOrigin,
  onExit,
  onNavigate,
}: {
  runOrigin?: string;
  onExit?: () => void;
  onNavigate?: (to: string) => boolean;
} = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Every destination goes through here: the host claims what it can serve,
  // everything else stays local navigation.
  const go = useCallback(
    (to: string, opts?: { replace?: boolean }) => {
      if (onNavigate?.(to)) return;
      navigate(to, opts);
    },
    [navigate, onNavigate],
  );
  const [searchParams] = useSearchParams();
  const { marketCatalog, load, skills: localSkillsAll } = useExtensionsStore();
  const modelRoster = useChatStore((s) => s.models);
  const userEmail = useAuthStore((s) => s.email);

  // ── library + open document ───────────────────────────────────────────────
  const [docs, setDocs] = useState<BlueprintSummary[]>([]);
  const [doc, setDoc] = useState<Blueprint | null>(null);
  const [content, setContent] = useState<BlueprintContent | null>(null);
  const [track, setTrack] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // ── save / validation / action state ──────────────────────────────────────
  const [saveState, setSaveState] = useState<"clean" | "dirty" | "saving" | "conflict">("clean");
  const [conflict, setConflict] = useState<{ serverVersion: number } | null>(null);
  const [overwriteOpen, setOverwriteOpen] = useState(false);
  // 8.3 多标签软锁：同文档他窗打开只提示不接管（数据面仍由 409 横幅兜底）。
  const softLock = useDocSoftLock(doc?.id ?? null);
  const [verdict, setVerdict] = useState<ValidationVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [trialRunning, setTrialRunning] = useState(false);

  // ── writable team graph (6.2, design D6) ──────────────────────────────────
  // Explicit design toggle; the draft lives in component state only — exit
  // discards, confirm merges into content and rides the ordinary autosave +
  // publish-gate validation (a fleet-section rejection rolls the merge back).
  const [graphDesign, setGraphDesign] = useState(false);
  const [draftAdded, setDraftAdded] = useState<DraftEdgeOp[]>([]);
  const [draftRemovedKeys, setDraftRemovedKeys] = useState<string[]>([]);
  const [designError, setDesignError] = useState<string | null>(null);
  const [graphApplying, setGraphApplying] = useState(false);

  // ── AI drafting (overlay) ─────────────────────────────────────────────────
  const [aiOpen, setAiOpen] = useState(false);
  const [ai, setAi] = useState<{ prompt: string; busy: boolean; draft: Record<string, unknown> | null; error: string | null }>({
    prompt: "", busy: false, draft: null, error: null,
  });

  // ── canvas support data (collections for dataSources, judge default) ─────
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const [judgeDefault, setJudgeDefault] = useState<bp.JudgeDefaultProbe | null>(null);

  // ── pane visibility (narrow-screen collapse, spec 窄屏降级) ──────────────
  const [showLibrary, setShowLibrary] = useState(true);
  const [showInspector, setShowInspector] = useState(true);

  const docRef = useRef<Blueprint | null>(null);
  const contentRef = useRef<BlueprintContent | null>(null);
  const savingRef = useRef(false);
  const queuedRef = useRef(false);
  const dirtyRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusNameRef = useRef(false);
  docRef.current = doc;
  contentRef.current = content;

  const refreshDocs = useCallback(async () => {
    try {
      const { blueprints } = await bp.listBlueprints();
      setDocs(blueprints ?? []);
    } catch {
      /* the library keeps its last good list; a failed refresh is not fatal */
    }
  }, []);

  useEffect(() => {
    void load();
    void refreshDocs();
    bp.getJudgeDefault().then(setJudgeDefault).catch(() => {});
    fetch("/api/collections")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`collections ${r.status}`))))
      .then((body) => setCollections(Array.isArray(body?.collections) ? body.collections : []))
      .catch(() => setCollections([]));
  }, [load, refreshDocs]);

  const runValidate = useCallback(async (id: string): Promise<bp.ValidationVerdict | null> => {
    setVerifying(true);
    try {
      const v = await bp.validateBlueprint(id);
      setVerdict(v);
      // 8.4: the error-resolution funnel — every verdict that lands with errors
      // marks the START of a resolution attempt (jumps are counted separately).
      if (v && v.errors?.length > 0) recordStudioMetric({ type: "validation_error_seen", at: Date.now(), docId: id, count: v.errors.length });
      return v;
    } catch {
      setVerdict(null);
      return null;
    } finally {
      setVerifying(false);
    }
  }, []);

  const applyBlueprint = useCallback((b: Blueprint) => {
    setDoc(b);
    setContent(b.content);
    setJsonText(JSON.stringify(b.content, null, 2));
    setTrack("form");
    setJsonError(null);
  }, []);

  const openDoc = useCallback(
    async (id: string) => {
      setBusy("open");
      try {
        const { blueprint } = await bp.getBlueprint(id);
        applyBlueprint(blueprint);
        dirtyRef.current = false;
        setSaveState("clean");
        setConflict(null);
        setSelectedAgentId((blueprint.content.agents as { id?: string }[] | undefined)?.[0]?.id ?? null);
        void runValidate(blueprint.id);
      } catch (err) {
        showToast({ severity: "error", title: t("studio.workspace.openFailed"), description: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [applyBlueprint, runValidate, t],
  );

  // ── autosave: debounce → optimistic PUT → validate the SAVED content ─────
  // (the dual-track discipline rides this: JSON edits land through the same
  // PUT, and validation always speaks of what the server holds — never of an
  // unsaved local guess.)
  const saveNow = useCallback(async (): Promise<bp.ValidationVerdict | null> => {
    const d = docRef.current;
    const c = contentRef.current;
    if (!d || !c) return null;
    if (savingRef.current) {
      queuedRef.current = true;
      return null;
    }
    savingRef.current = true;
    setSaveState("saving");
    try {
      const { blueprint } = await bp.updateBlueprint(d.id, d.version, c);
      applyBlueprint(blueprint);
      dirtyRef.current = false;
      setSaveState("clean");
      setConflict(null);
      const v = await runValidate(blueprint.id);
      void refreshDocs();
      return v;
    } catch (err) {
      if (err instanceof bp.BlueprintApiError && err.status === 409) {
        // Server holds a newer version — the user decides, nothing silent.
        setSaveState("conflict");
        setConflict({ serverVersion: Number(err.body?.currentVersion ?? 0) });
        dirtyRef.current = true;
      } else {
        setSaveState("dirty");
        dirtyRef.current = true;
        showToast({ severity: "error", title: t("studio.workspace.saveFailed"), description: (err as Error).message });
      }
      return null;
    } finally {
      savingRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void saveNow();
      }
    }
  }, [applyBlueprint, runValidate, refreshDocs, t]);

  useEffect(() => {
    if (!doc || !content || !dirtyRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void saveNow(), 1500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [content, doc, saveNow]);

  const patchContent = useCallback((p: Partial<BlueprintContent>) => {
    dirtyRef.current = true;
    setSaveState("dirty");
    setContent((c0) => (c0 ? { ...c0, ...p } : c0));
  }, []);

  const createDoc = useCallback(async (kind: "agent" | "team" = "team"): Promise<string | null> => {
    setBusy("create");
    try {
      const seed = kind === "agent"
        ? bp.agentSkeletonContent(t("studio.blueprint.untitledAgent"))
        : bp.skeletonContent(t("studio.blueprint.untitled"));
      const { blueprint } = await bp.createBlueprint(seed);
      await refreshDocs();
      recordStudioMetric({ type: "doc_created", at: Date.now(), docId: blueprint.id, kind });
      focusNameRef.current = true;
      await openDoc(blueprint.id);
      return blueprint.id;
    } catch (err) {
      showToast({ severity: "error", title: t("studio.workspace.createFailed"), description: (err as Error).message });
      return null;
    } finally {
      setBusy(null);
    }
  }, [openDoc, refreshDocs, t]);

  // 8.2: starter-seeded document — the manifest projection rides the SAME
  // createBlueprint lane (validation, autosave, lifecycle all identical); the
  // only difference is the seed's provenance.
  const createFromSeed = useCallback(async (seed: BlueprintContent): Promise<string | null> => {
    setBusy("create");
    try {
      const { blueprint } = await bp.createBlueprint(seed);
      await refreshDocs();
      await openDoc(blueprint.id);
      // Same URL contract as the fork seed: the address carries the doc id.
      go(`/studio?doc=${encodeURIComponent(blueprint.id)}`, { replace: true });
      showToast({ severity: "success", title: t("studio.workspace.library.starterCreated", { name: seed.boundary?.name ?? "" }) });
      return blueprint.id;
    } catch (err) {
      showToast({ severity: "error", title: t("studio.workspace.createFailed"), description: (err as Error).message });
      return null;
    } finally {
      setBusy(null);
    }
  }, [openDoc, refreshDocs, go, t]);

  // Focus the scene name right after a fresh document opens (one click to edit).
  useEffect(() => {
    if (doc && focusNameRef.current) {
      focusNameRef.current = false;
      document.querySelector<HTMLInputElement>('[data-anchor="boundary.name"]')?.focus();
    }
  }, [doc]);

  // ── deep links: ?doc= / ?fork= / ?new= / legacy ?from=blueprint ──────────
  const docParam = searchParams.get("doc");
  const forkParam = searchParams.get("fork");
  const newParam = searchParams.get("new");
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed once per param value
  useEffect(() => {
    void (async () => {
      if (docParam) {
        await openDoc(docParam);
        return;
      }
      if (forkParam) {
        try {
          const r = await fetch(`/api/packs/${encodeURIComponent(forkParam)}`);
          if (!r.ok) throw new Error(t("studio.fork.unavailable", { status: r.status }));
          const detail = await r.json();
          const m = detail.manifest ?? {};
          const parentLicense = (m.provenance as { license?: string } | undefined)?.license;
          const seeded: BlueprintContent = {
            boundary: { name: m.name ?? "", oneLine: m.description ?? "", outOfScope: "" },
            tags: m.tags ?? [],
            dataSources: [],
            fleet: m.fleet ?? { name: m.name ?? "", members: [] },
            agents: m.agents ?? [],
            mcpServers: m.mcpServers ?? [],
            monitoring: {},
            acceptance: [],
            board: {},
            provenance: { forkOf: { packId: detail.id, version: detail.version }, ...(parentLicense ? { license: parentLicense } : {}) },
          };
          const { blueprint } = await bp.createBlueprint(seeded);
          await refreshDocs();
          await openDoc(blueprint.id);
          // Replace the seeding URL: a reload must not mint a second draft.
          go(`/studio?doc=${encodeURIComponent(blueprint.id)}`, { replace: true });
          showToast({ severity: "success", title: t("studio.fork.seeded", { name: detail.name ?? detail.id }) });
        } catch (err) {
          // Unreadable seed: honest toast, land on the library — never a blank editor.
          showToast({ severity: "error", title: t("studio.workspace.forkMiss"), description: (err as Error).message });
        }
        return;
      }
      if (newParam) {
        // 4.4: ?new=agent 直铸岗位文档；?new=1 / ?new=team 铸场景文档。
        const id = await createDoc(newParam === "agent" ? "agent" : "team");
        if (id) go(`/studio?doc=${encodeURIComponent(id)}`, { replace: true });
      }
    })();
  }, [docParam, forkParam, newParam]);

  // ── lifecycle actions (ribbon) ────────────────────────────────────────────
  const act = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      try {
        await fn();
      } catch (err) {
        showToast({ severity: "error", title: t("studio.workspace.actionFailed", { action: label }), description: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  const onRibbonAction = useCallback(
    (a: "approve" | "cast" | "trial" | "sign" | "unsign" | "reseal") => {
      if (!doc) return;
      if (a === "approve") {
        void act("approve", async () => {
          const { blueprint } = await bp.approveBlueprint(doc.id, doc.version);
          applyBlueprint(blueprint);
          await runValidate(blueprint.id);
          void refreshDocs();
          showToast({ severity: "success", title: t("studio.workspace.approved") });
        });
      } else if (a === "cast" || a === "reseal") {
        void act(a, async () => {
          const { blueprint, cast } = await bp.castBlueprint(doc.id);
          applyBlueprint(blueprint);
          void refreshDocs();
          recordStudioMetric({ type: "cast", at: Date.now(), docId: doc.id, packId: cast.packId ?? blueprint.castPackId ?? null });
          showToast({ severity: "success", title: t("studio.workspace.castOk", { packId: cast.packId ?? blueprint.castPackId ?? "?", version: cast.version ?? blueprint.castPackVersion ?? "?" }) });
        });
      } else if (a === "trial") {
        setTrialRunning(true);
        void act("trial", async () => {
          try {
            const { report, blueprint } = await bp.runTrial(doc.id);
            applyBlueprint(blueprint);
            void refreshDocs();
            showToast({
              severity: report.green ? "success" : "error",
              title: report.green ? t("studio.workspace.trialGreen") : t("studio.workspace.trialRed"),
            });
          } finally {
            setTrialRunning(false);
          }
        }).catch(() => setTrialRunning(false));
      } else if (a === "sign") {
        void act("sign", async () => {
          const { blueprint } = await bp.signTrialReport(doc.id);
          applyBlueprint(blueprint);
          void refreshDocs();
          showToast({ severity: "success", title: t("studio.workspace.signed") });
        });
      } else if (a === "unsign") {
        void act("unsign", async () => {
          const { blueprint } = await bp.unsignTrialReport(doc.id);
          applyBlueprint(blueprint);
        });
      }
    },
    [doc, act, applyBlueprint, runValidate, refreshDocs, t],
  );

  // 4.1/4.4: kind 从持久正文读（缺省 team——存量文档零感知）。
  const docKind: "agent" | "team" = content?.kind === "agent" ? "agent" : "team";
  // 6.1: the document's fleet template projected into the SHARED canvas
  // vocabulary (unborn posts, declared edges). null = nothing to draw.
  const canvasProj = useMemo(() => (docKind === "team" ? projectFleetDocCanvas(content) : null), [content, docKind]);
  const canvasEdges = useMemo(() => {
    if (!canvasProj) return [];
    // Design mode draws declared-minus-removals + dashed additions; read mode
    // draws the declaration verbatim.
    if (!graphDesign) return canvasProj.edges;
    const removed = (e: { kind?: string; from?: string; to?: string; targets?: string[] }) => draftRemovedKeys.includes(edgeKeyOf(e));
    return canvasProj.edges.filter((e) => !removed(e));
  }, [canvasProj, graphDesign, draftRemovedKeys]);

  // ── writable graph confirm/discard (6.2) ──────────────────────────────────
  // Confirm merges the draft into content and rides the ORDINARY autosave +
  // publish-gate chain (D6: dry-run 即 validate 端点). A fleet-section rejection
  // rolls the merge back from the pre-merge snapshot and anchors the error on
  // the graph card — the document is never left holding an illegal merge.
  const hasGraphDraft = draftAdded.length > 0 || draftRemovedKeys.length > 0;
  const confirmGraphDesign = useCallback(async () => {
    if (!content || !canvasProj) return;
    if (!hasGraphDraft) {
      setGraphDesign(false);
      return;
    }
    setGraphApplying(true);
    setDesignError(null);
    try {
      const snapshot = contentRef.current;
      const mergedFleet = applyDraftEdgesToFleet(content.fleet as Record<string, unknown>, draftAdded, draftRemovedKeys);
      // contentRef is what saveNow reads and React state commits async — sync
      // the ref HERE or the confirm PUT races the debounce and carries the
      // pre-merge content.
      const mergedContent = { ...content, fleet: mergedFleet };
      contentRef.current = mergedContent;
      patchContent({ fleet: mergedFleet });
      const verdictAfter = await saveNow();
      const fleetErrs = (verdictAfter?.errors ?? []).filter((e) => e.entry === "fleet" || e.error.startsWith("fleet."));
      if (fleetErrs.length > 0) {
        if (snapshot) {
          contentRef.current = snapshot; // rollback syncs the ref too — the queued save must not resurrect the rejected merge
          patchContent({ fleet: snapshot.fleet });
        }
        await saveNow();
        setDesignError(fleetErrs.map((e) => e.error).join("; "));
        showToast({ severity: "error", title: t("studio.workspace.graph.rejected"), description: fleetErrs[0]?.error ?? "" });
        return;
      }
      setDraftAdded([]);
      setDraftRemovedKeys([]);
      setGraphDesign(false);
      showToast({ severity: "success", title: t("studio.workspace.graph.applied") });
    } finally {
      setGraphApplying(false);
    }
  }, [content, canvasProj, hasGraphDraft, draftAdded, draftRemovedKeys, patchContent, saveNow, t]);

  const discardGraphDesign = useCallback(() => {
    setDraftAdded([]);
    setDraftRemovedKeys([]);
    setDesignError(null);
    setGraphDesign(false);
  }, []);

  // ── deploy the cast team (7.1, design D7) ─────────────────────────────────
  // The ribbon's cast stage leaves the document cast; THIS is the walk-out-the-
  // door action: POST /api/fleets/from-template (existing provisioning, born
  // paused) then navigate to the live fleet. No new endpoint, no new field.
  const deployTeam = useCallback(async () => {
    if (!doc?.castPackId) return;
    // Cross-domain branch (D4 honest boundary): on the facet host the run
    // domain is a different process and login — hand off via deep link with
    // the cast pack attached; the 壹座 face (single release, task 4.2) opens
    // its install+from-template flow on ?deployCastPack=. No silent degrade:
    // this is a navigation, not a fake success.
    if (runOrigin) {
      window.open(
        `${runOrigin}/packs?deployCastPack=${encodeURIComponent(doc.castPackId)}${doc.castPackVersion ? `&v=${doc.castPackVersion}` : ""}`,
        "_blank",
        "noopener",
      );
      return;
    }
    setBusy("deploy-team");
    try {
      // from-template provisions from the INSTALLED pack — a fresh cast only
      // published it. Ensure-installed first (reused short-circuits); the
      // purchase gate cannot fire for the pack this same owner just cast.
      const ins = await fetch("/api/mypacks/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packId: doc.castPackId, version: doc.castPackVersion ?? undefined }),
      });
      if (!ins.ok && ins.status !== 409) {
        const body = await ins.json().catch(() => ({}));
        throw new Error(body.error || `install failed (${ins.status})`);
      }
      const r = await fetch("/api/fleets/from-template", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packId: doc.castPackId }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `deploy failed (${r.status})`);
      const fleetId: string | undefined = body?.fleet?.id ?? body?.id;
      recordStudioMetric({ type: "deploy", at: Date.now(), docId: doc.id, fleetId: fleetId ?? null });
      showToast({ severity: "success", title: t("studio.workspace.deployOk") });
      if (fleetId) go(`/fleets/${encodeURIComponent(fleetId)}`);
    } catch (err) {
      showToast({ severity: "error", title: t("studio.workspace.deployFailed"), description: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, [doc, go, t, runOrigin]);

  // ── emit ports (never mutate the document; re-validate at emit) ──────────
  const selectedAgent = useMemo(
    () => ((content?.agents ?? []) as PackManifestAgent[]).find((a) => a.id === selectedAgentId) ?? null,
    [content?.agents, selectedAgentId],
  );
  const docValid = verdict?.ok === true;

  const emitPreset = async () => {
    if (!doc || !selectedAgent || !docValid) return;
    setBusy("emit-preset");
    try {
      const mcp = (content?.mcpServers ?? []) as PackManifestMcp[];
      // 4.3: 技能桶从持久文档读（不再恒空丢桶）；岗位只挂文档声明的技能名。
      const skillNames = ((content?.skills ?? []) as PackManifestSkill[]).map((s) => s.name).filter(Boolean);
      await presetsApi.createCustomPreset({
        name: selectedAgent.name || selectedAgent.id,
        persona: selectedAgent.persona,
        skills: skillNames,
        mcpServers: mcp.map((m) => m.registryName),
        mcpTools: Object.fromEntries(mcp.filter((m) => m.allowTools?.length).map((m) => [m.registryName, m.allowTools!])),
      });
      if (doc) recordStudioMetric({ type: "emit", at: Date.now(), docId: doc.id, emit: "preset" });
      showToast({ severity: "success", title: t("studio.emit.presetOk", { name: selectedAgent.name || selectedAgent.id }) });
    } catch (err) {
      showToast({ severity: "error", title: t("studio.emit.failed", { message: (err as Error).message }) });
    } finally {
      setBusy(null);
    }
  };

  const emitDraft = async () => {
    if (!doc || !docValid) return;
    setBusy("emit-draft");
    try {
      const c = content;
      // The open content shape carries the fork lineage we seeded at ?fork=
      // time; the packs API validates the provenance record itself.
      const prov = (c?.provenance as { forkOf?: { packId: string; version: number }; license?: string } | undefined)?.forkOf
        ? (c?.provenance as PackManifest["provenance"])
        : undefined;
      // 4.3: 名字/一句话两 kind 各自的落点（agent 在顶层，team 在 boundary）。
      const isAgent = (c?.kind ?? "team") === "agent";
      await packsApi.createPackDraft({
        name: (isAgent ? c?.name : c?.boundary?.name) ?? doc.name,
        description: (isAgent ? c?.description : c?.boundary?.oneLine) ?? doc.oneLine,
        tags: (c?.tags as string[] | undefined) ?? [],
        entries: {
          skills: ((c?.skills ?? []) as PackManifestSkill[]),
          mcpServers: (c?.mcpServers ?? []) as PackManifestMcp[],
          agents: (c?.agents ?? []) as PackManifestAgent[],
          ...(prov ? { provenance: prov } : {}),
        },
      });
      if (doc) recordStudioMetric({ type: "emit", at: Date.now(), docId: doc.id, emit: "draft" });
      showToast({ severity: "success", title: t("studio.emit.draftOk") });
      go("/agents?tab=market");
    } catch (err) {
      showToast({ severity: "error", title: t("studio.emit.failed", { message: (err as Error).message }) });
    } finally {
      setBusy(null);
    }
  };

  // ── AI drafting ───────────────────────────────────────────────────────────
  const runAiDraft = async () => {
    setAi((s) => ({ ...s, busy: true, error: null, draft: null }));
    try {
      const r = await fetch("/api/studio/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 7.3: team documents ride the EXISTING blueprint drafting lane (same
        // bridge, same whitelist — the kind param was left open for this).
        body: JSON.stringify({ kind: docKind === "agent" ? "agent-doc" : "blueprint", prompt: ai.prompt }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `draft failed (${r.status})`);
      setAi((s) => ({ ...s, busy: false, draft: d.draft }));
    } catch (err) {
      setAi((s) => ({ ...s, busy: false, error: (err as Error).message }));
    }
  };

  const adoptAi = (picked: Set<DraftField["key"]>, draft: Record<string, unknown>) => {
    if (!content) return;
    const next: BlueprintContent = { ...content };
    const b0 = { ...(content.boundary ?? {}) };
    if (picked.has("name") && typeof draft.name === "string" && draft.name.trim()) b0.name = draft.name;
    if (picked.has("description") && typeof draft.description === "string" && draft.description) b0.oneLine = draft.description;
    next.boundary = b0;
    const agents = [...((content.agents ?? []) as PackManifestAgent[])];
    if (picked.has("persona") && typeof draft.persona === "string") {
      const idx = Math.max(0, agents.findIndex((a) => a.id === selectedAgentId));
      if (agents[idx]) agents[idx] = { ...agents[idx], persona: draft.persona };
      else agents.push({ id: "agent-1", name: "", persona: draft.persona });
      next.agents = agents;
    }
    if (picked.has("fleet") && draft.fleet && typeof draft.fleet === "object") {
      next.fleet = draft.fleet as Record<string, unknown>;
    }
    if (picked.has("mcpServers") && Array.isArray(draft.mcpServers) && draft.mcpServers.length) {
      const incoming = (draft.mcpServers as PackManifestMcp[]).filter((m) => m && typeof m.registryName === "string");
      const merged = [...((content.mcpServers ?? []) as PackManifestMcp[])];
      for (const m of incoming) if (!merged.some((x) => x.registryName === m.registryName)) merged.push({ registryName: m.registryName, ...(m.allowTools?.length ? { allowTools: m.allowTools } : {}) });
      next.mcpServers = merged;
    }
    patchContent(next);
    setAiOpen(false);
    setAi({ prompt: "", busy: false, draft: null, error: null });
  };

  // ── ribbon projection ─────────────────────────────────────────────────────
  const ribbonView = useMemo(() => {
    if (!doc) return null;
    const report = trialOf(doc);
    return teamRibbon(
      {
        status: doc.status,
        approvedBy: doc.approvedBy,
        castPackId: doc.castPackId,
        castPackVersion: doc.castPackVersion,
        trialRanAt: report?.ranAt ?? null,
        signedBy: report?.signoff?.by ?? null,
        signedMatches: report?.signoff?.reportRanAt != null && report?.signoff?.reportRanAt === report?.ranAt,
      },
      { verdictOk: docValid, userEmail, saving: saveState === "saving" || busy !== null },
    );
  }, [doc, docValid, userEmail, saveState, busy]);

  const totalTools = (registryName: string) => marketCatalog?.mcpServers?.find((s) => s.name === registryName)?.toolList?.length ?? null;

  const saveStateLabel =
    saveState === "clean" ? t("studio.workspace.saved", { version: doc?.version ?? 0 })
    : saveState === "dirty" ? t("studio.workspace.dirty")
    : saveState === "saving" ? t("studio.workspace.saving")
    : t("studio.workspace.conflictShort");

  return (
    <div className="relative flex h-full flex-col bg-background" data-testid="agent-studio">
      {/* ── Header: document identity + save state ── */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {/* Back control (D4): a host without 壹座's routes supplies its own
            landing; 壹座 keeps the original link to the builder tab. Same
            anchor either way, so no test and no muscle memory moves. */}
        {onExit ? (
          <button
            type="button"
            onClick={onExit}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            data-testid="ws-back"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {t("studio.workspace.back")}
          </button>
        ) : (
          <Link to="/agents?tab=build" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="ws-back">
            <ArrowLeft className="h-3.5 w-3.5" /> {t("studio.workspace.back")}
          </Link>
        )}
        <h2 className="text-sm font-medium">{t("studio.workspace.title")}</h2>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted lg:hidden" aria-label={t("studio.workspace.toggleLibrary")} data-testid="ws-toggle-library" onClick={() => setShowLibrary((v) => !v)}>
          <PanelLeft className="h-4 w-4" />
        </button>
        {doc && (
          <>
            <div className="mx-2 flex min-w-0 flex-1 items-center gap-2">
              <Input
                value={docKind === "agent" ? (content?.name ?? "") : (content?.boundary?.name ?? "")}
                onChange={(e) =>
                  docKind === "agent"
                    ? patchContent({ name: e.target.value })
                    : patchContent({ boundary: { ...content?.boundary, name: e.target.value } })
                }
                className="h-7 max-w-64 border-transparent bg-transparent px-1 text-sm font-medium hover:border-border focus-visible:border-border"
                placeholder={docKind === "agent" ? t("studio.blueprint.untitledAgent") : t("studio.blueprint.untitled")}
                data-testid="ws-doc-name"
                data-anchor="boundary.name"
              />
              <StatusPill status={DOC_STATUS_TONE[doc.status]} label={t(`studio.blueprint.status.${doc.status}`)} data-testid="ws-doc-status" />
              <span className="shrink-0 rounded-full border border-border px-1.5 py-0 text-[10px] text-muted-foreground" data-testid="ws-doc-kind">
                {t(`studio.workspace.kind.${docKind}`)}
              </span>
              {doc.castPackId && (
                <span className="truncate text-[11px] text-muted-foreground" data-testid="ws-cast-ref">
                  {t("studio.blueprint.castRef", { packId: doc.castPackId, version: doc.castPackVersion ?? "?" })}
                </span>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground" data-testid="ws-save-state">{saveStateLabel}</span>
          </>
        )}
        {!doc && <div className="flex-1" />}
        <Button size="sm" variant="outline" onClick={() => void createDoc("agent")} disabled={busy !== null} data-testid="ws-new-agent-entry">
          <Plus className="h-3.5 w-3.5" /> {t("studio.workspace.library.newAgent")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAiOpen((v) => !v)} data-testid="ws-ai-toggle">
          <Sparkles className="h-3.5 w-3.5" /> {t("studio.aiDraft.title")}
        </Button>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted xl:hidden" aria-label={t("studio.workspace.toggleInspector")} data-testid="ws-toggle-inspector" onClick={() => setShowInspector((v) => !v)}>
          <PanelRight className="h-4 w-4" />
        </button>
      </div>

      {/* ── Multi-tab notice (8.3): another window has this doc open. Notice
             only — no read-only takeover; the 409 banner still guards writes. ── */}
      {softLock.otherOpen && doc && (
        <div className="flex items-center justify-between gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs" data-testid="ws-soft-lock-banner">
          <span className="min-w-0 flex-1">{t("studio.workspace.softLock")}</span>
          <button type="button" className="rounded px-2 py-0.5 text-muted-foreground hover:bg-muted" onClick={softLock.dismiss} data-testid="ws-soft-lock-dismiss">
            {t("studio.workspace.softLockDismiss")}
          </button>
        </div>
      )}
      {/* ── Conflict banner (409): the user decides, nothing silent ── */}
      {conflict && doc && (
        <div className="flex items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/5 px-3 py-2 text-xs" data-testid="ws-conflict-banner">
          <span className="min-w-0 flex-1 text-destructive">{t("studio.workspace.conflict", { server: conflict.serverVersion, local: doc.version })}</span>
          <Button size="sm" variant="outline" onClick={() => void openDoc(doc.id)} data-testid="ws-conflict-reload">
            {t("studio.workspace.conflictReload")}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => setOverwriteOpen(true)} data-testid="ws-conflict-overwrite">
            {t("studio.workspace.conflictOverwrite")}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={overwriteOpen}
        onOpenChange={setOverwriteOpen}
        variant="danger"
        title={t("studio.workspace.conflictOverwrite")}
        description={t("studio.workspace.conflictOverwriteConfirm")}
        confirmLabel={t("studio.workspace.conflictOverwrite")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          void (async () => {
            if (!doc || !content) return;
            try {
              const { blueprint } = await bp.getBlueprint(doc.id);
              await bp.updateBlueprint(doc.id, blueprint.version, content);
              await openDoc(doc.id);
              showToast({ severity: "success", title: t("studio.workspace.overwriteDone") });
            } catch (err) {
              showToast({ severity: "error", title: t("studio.workspace.saveFailed"), description: (err as Error).message });
            }
          })();
        }}
      />

      <div className="flex min-h-0 flex-1">
        {showLibrary && <DocumentLibrary docs={docs} activeId={doc?.id ?? null} onOpen={(id) => void openDoc(id)} onNew={(kind) => void createDoc(kind)} busy={busy !== null} onNewFromStarter={(seed) => { if (seed) void createFromSeed(seed); }} />}

        {/* ── Canvas ── */}
        <main className="min-w-0 flex-1 overflow-y-auto p-4" data-testid="ws-canvas">
          {!doc || !content ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center" data-testid="ws-canvas-empty">
              <Blocks className="h-8 w-8 text-muted-foreground" />
              <p className="max-w-md text-sm text-muted-foreground">{t("studio.workspace.canvas.empty")}</p>
              <Button size="sm" onClick={() => void createDoc("agent")} disabled={busy !== null} data-testid="ws-canvas-new">
                <Plus className="h-3.5 w-3.5" /> {t("studio.blueprint.new")}
              </Button>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-3">
              {/* form | json dual track — both land through the same PUT+chain */}
              <div className="flex gap-2 text-xs">
                {(["form", "json"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      if (k === "json") setJsonText(JSON.stringify(content, null, 2));
                      setTrack(k);
                    }}
                    className={cn("rounded-t-md px-3 py-1", track === k ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")}
                    data-testid={`ws-track-${k}`}
                  >
                    {t(`studio.blueprint.track.${k}`)}
                  </button>
                ))}
              </div>

              {track === "form" ? (
                <>
                  <SectionCard title={t("studio.workspace.section.envelope")} testid="ws-envelope">
                    <div className="space-y-2">
                      <div data-anchor="boundary.oneLine">
                        <Field label={docKind === "agent" ? t("studio.workspace.agent.description") : t("studio.blueprint.boundary.oneLine")}>
                          <Input
                            value={docKind === "agent" ? (content.description ?? "") : (content.boundary?.oneLine ?? "")}
                            onChange={(e) =>
                              docKind === "agent"
                                ? patchContent({ description: e.target.value })
                                : patchContent({ boundary: { ...content.boundary, oneLine: e.target.value } })
                            }
                            data-testid="ws-field-oneline"
                          />
                        </Field>
                      </div>
                      {docKind === "team" && (
                        <div data-anchor="boundary.outOfScope">
                          <Field label={t("studio.blueprint.boundary.outOfScope")}>
                            <Textarea rows={2} value={content.boundary?.outOfScope ?? ""} onChange={(e) => patchContent({ boundary: { ...content.boundary, outOfScope: e.target.value } })} data-testid="ws-field-oos" />
                          </Field>
                        </div>
                      )}
                      <div data-anchor="tags">
                        <Field label={t("studio.doc.tags")}>
                          <Input
                            value={((content.tags as string[] | undefined) ?? []).join(", ")}
                            onChange={(e) => patchContent({ tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                            data-testid="ws-field-tags"
                          />
                        </Field>
                      </div>
                    </div>
                  </SectionCard>

                  <AgentBucketsEditor
                    value={{
                      agents: (content.agents ?? []) as PackManifestAgent[],
                      skills: (content.skills ?? []) as PackManifestSkill[],
                      mcpServers: (content.mcpServers ?? []) as PackManifestMcp[],
                    }}
                    showSkills
                    localSkills={localSkillsAll.filter((s) => s.source === "database" && s.enabled)}
                    catalogServers={marketCatalog?.mcpServers ?? []}
                    onChange={({ agents, skills, mcpServers }) => patchContent({ agents, skills, mcpServers })}
                    testIdPrefix="ws-bucket"
                    selectedAgentId={selectedAgentId}
                    onSelectAgent={setSelectedAgentId}
                  />

                  {docKind === "team" && (
                    <>
                      <SectionCard title={t("studio.team.tab")} testid="ws-graph" anchor="fleet">
                        {canvasProj ? (
                          <div className="space-y-2">
                            {/* 6.1/6.2: the writable team graph = the SHARED
                                FleetCanvas in its document projection. Positions
                                persist under the doc:<id> key (6.3, same
                                storage contract as fleet:<id>); design mode is
                                an explicit toggle with a draft-merge confirm. */}
                            <div className="flex items-center justify-between gap-2">
                              {graphDesign ? (
                                <>
                                  <span className="text-[11px] text-muted-foreground">{t("studio.workspace.graph.designHint")}</span>
                                  <div className="flex shrink-0 gap-1">
                                    <Button size="sm" onClick={() => void confirmGraphDesign()} disabled={graphApplying} data-testid="ws-graph-confirm">
                                      {graphApplying ? t("studio.workspace.graph.applying") : t("studio.workspace.graph.confirm")}
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={discardGraphDesign} data-testid="ws-graph-discard">
                                      <X className="h-3.5 w-3.5" /> {t("studio.workspace.graph.discard")}
                                    </Button>
                                  </div>
                                </>
                              ) : (
                                <>
                                  <span className="text-[11px] text-muted-foreground">{t("studio.workspace.graph.readHint")}</span>
                                  <Button size="sm" variant="outline" onClick={() => setGraphDesign(true)} data-testid="ws-graph-design">
                                    <Pencil className="h-3.5 w-3.5" /> {t("studio.workspace.graph.edit")}
                                  </Button>
                                </>
                              )}
                            </div>
                            {designError && (
                              <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs text-destructive" data-testid="ws-graph-design-error">
                                {designError}
                              </p>
                            )}
                            <div className="h-72 overflow-hidden rounded-md border border-border" data-testid="ws-graph-canvas">
                              <Suspense fallback={<p className="py-8 text-center text-xs text-muted-foreground" data-testid="ws-graph-loading">{t("studio.workspace.graph.loading")}</p>}>
                                <FleetCanvas
                                  fleetId={`doc:${doc.id}`}
                                  members={canvasProj.members}
                                  edges={canvasEdges}
                                  traffic={[]}
                                  liveTurns={[]}
                                  designMode={graphDesign}
                                  draftEdges={draftAdded.map((d) => ({ kind: d.kind, from: d.from, to: d.to }))}
                                  removedEdgeKeys={draftRemovedKeys}
                                  onConnectEdge={(from, to) => {
                                    setDesignError(null);
                                    setDraftAdded((prev) =>
                                      prev.some((e) => e.from === from && e.to === to && e.kind === "handoff")
                                        ? prev
                                        : [...prev, { kind: "handoff", from, to }],
                                    );
                                  }}
                                  onDraftEdgeRemove={(from, to, kind) => setDraftAdded((prev) => prev.filter((e) => !(e.from === from && e.to === to && e.kind === kind)))}
                                  onEdgeSelect={(e) => {
                                    if (graphDesign && e.kind !== "fanout" && typeof e.from === "string" && typeof e.to === "string") {
                                      // Design mode: clicking a DECLARED edge drafts its removal.
                                      setDraftRemovedKeys((prev) => (prev.includes(edgeKeyOf(e)) ? prev : [...prev, edgeKeyOf(e)]));
                                    }
                                  }}
                                />
                              </Suspense>
                            </div>
                          </div>
                        ) : (
                          <>
                            <FleetGraph members={[]} edges={[]} kindLabels={{}} emptyLabel={t("studio.team.empty")} />
                            <p className="mt-2 text-[11px] text-muted-foreground">{t("studio.workspace.graph.emptyHint")}</p>
                          </>
                        )}
                      </SectionCard>

                      <SectionCard title={t("studio.blueprint.judge")} testid="ws-judge" anchor="judgeModel">
                        <select
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                          value={content.judgeModel ?? ""}
                          onChange={(e) => patchContent({ judgeModel: e.target.value || undefined })}
                          data-testid="ws-field-judge"
                        >
                          <option value="">
                            {judgeDefault?.resolved
                              ? t("studio.blueprint.judgeFollows", { model: judgeDefault.resolved.model })
                              : t("studio.blueprint.judgeFollowDefault")}
                          </option>
                          {(modelRoster ?? []).map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name || m.id}
                            </option>
                          ))}
                        </select>
                      </SectionCard>
                    </>
                  )}

                  {docKind === "team" && (
                    <SectionCard title={t("studio.blueprint.sources")} testid="ws-sources" anchor="dataSources">
                    <div className="space-y-1">
                      {(content.dataSources ?? []).map((s, i) => (
                        /* biome-ignore lint/suspicious/noArrayIndexKey: positional rows of an ordered ref list */
                        <div key={i} className="flex items-center gap-2">
                          <select
                            className="max-w-44 rounded-md border border-border bg-background px-2 py-1 text-xs"
                            value={s.ref.startsWith("library:") ? s.ref : ""}
                            onChange={(e) => {
                              if (!e.target.value) return;
                              const sources = [...(content.dataSources ?? [])];
                              sources[i] = { ref: e.target.value };
                              patchContent({ dataSources: sources });
                            }}
                            data-testid={`ws-source-${i}`}
                          >
                            <option value="">{s.ref || t("studio.blueprint.pickCollection")}</option>
                            {collections.map((c) => (
                              <option key={c.id} value={`library:${c.id}`}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t("studio.remove")}
                            onClick={() => patchContent({ dataSources: (content.dataSources ?? []).filter((_, j) => j !== i) })}
                          >
                            ×
                          </Button>
                        </div>
                      ))}
                      <select
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                        value=""
                        onChange={(e) => {
                          if (!e.target.value) return;
                          patchContent({ dataSources: [...(content.dataSources ?? []), { ref: e.target.value }] });
                        }}
                        data-testid="ws-source-add"
                      >
                        <option value="">{t("studio.blueprint.pickCollection")}</option>
                        {collections.map((c) => (
                          <option key={c.id} value={`library:${c.id}`}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    </SectionCard>
                  )}

                  <p className="text-[11px] text-muted-foreground">{t("studio.blueprint.jsonHint")}</p>
                </>
              ) : (
                <div>
                  <Textarea
                    rows={24}
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    className="font-mono text-xs"
                    data-testid="ws-json"
                  />
                  {jsonError && <p className="mt-1 text-xs text-destructive">{jsonError}</p>}
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    data-testid="ws-json-apply"
                    onClick={() => {
                      try {
                        const parsed = JSON.parse(jsonText) as BlueprintContent;
                        setJsonError(null);
                        setTrack("form");
                        patchContent(parsed);
                      } catch (err) {
                        setJsonError((err as Error).message);
                      }
                    }}
                  >
                    {t("studio.blueprint.jsonApply")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </main>

        {/* ── Inspector: ribbon / spec sheet / validation / emit ── */}
        {showInspector && (
          <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-3" data-testid="ws-inspector">
            {doc && docKind === "team" && ribbonView && <LifecycleRibbon view={ribbonView} onAction={onRibbonAction} busy={busy !== null} trialRunning={trialRunning} />}
            {/* 7.1: the cast stage's walk-out-the-door action — provision the
                live fleet from the cast pack (born paused), then land on it. */}
            {doc && docKind === "team" && doc.status === "cast" && doc.castPackId && (
              <Button size="sm" className="w-full" onClick={() => void deployTeam()} disabled={busy !== null} data-testid="ws-deploy-team">
                <Blocks className="h-3.5 w-3.5" /> {t("studio.workspace.deployTeam")}
              </Button>
            )}
            {doc && docKind === "agent" && (
              // 4.4: agent 文档没有团队档位——始终草稿 + 两发射口常驻（服务端
              // approve/cast 409 同源），此处只如实说明，不画假进度。
              <div className="rounded-md border border-border p-3" data-testid="ws-agent-draft-card">
                <div className="flex items-center gap-2">
                  <StatusPill status={DOC_STATUS_TONE[doc.status]} label={t(`studio.blueprint.status.${doc.status}`)} />
                  <span className="text-[10px] text-muted-foreground">{t("studio.workspace.kind.agent")}</span>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">{t("studio.workspace.agent.hint")}</p>
              </div>
            )}
            {doc && (
              <>
                <AgentSpecSheet
                  variant="full"
                  testIdPrefix="ws-spec"
                  lineage={((content?.provenance as { forkOf?: { packId: string; version: number } } | undefined)?.forkOf) ?? null}
                  roles={((content?.agents ?? []) as PackManifestAgent[]).map((a) => ({ id: a.id, name: a.name, persona: a.persona, serving: a.serving != null }))}
                  skills={null}
                  mcp={((content?.mcpServers ?? []) as PackManifestMcp[]).map((m) => ({ ...m, totalTools: totalTools(m.registryName) }))}
                />
                <ValidationPanel verdict={verdict} verifying={verifying} docId={doc?.id ?? null} />
                <div className="space-y-2 border-t border-border pt-3" data-testid="ws-emit">
                  <p className="text-xs font-medium text-muted-foreground">{t("studio.workspace.emit.section")}</p>
                  <Tooltip content={docValid ? "" : t("studio.workspace.emit.needGreen")}>
                    <span className="block">
                      <Button size="sm" className="w-full" disabled={!docValid || !selectedAgent || busy !== null} onClick={() => void emitPreset()} data-testid="ws-emit-preset">
                        {busy === "emit-preset" ? t("studio.emit.busy") : t("studio.emit.preset")}
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip content={docValid ? "" : t("studio.workspace.emit.needGreen")}>
                    <span className="block">
                      <Button size="sm" variant="outline" className="w-full" disabled={!docValid || !(content?.agents?.length) || busy !== null} onClick={() => void emitDraft()} data-testid="ws-emit-draft">
                        {busy === "emit-draft" ? t("studio.emit.busy") : t("studio.emit.draft")}
                      </Button>
                    </span>
                  </Tooltip>
                </div>
              </>
            )}
          </aside>
        )}
      </div>

      {/* ── AI drafting overlay (right-docked; the canvas never squeezes) ── */}
      {aiOpen && (
        <AiDraftOverlay
          prompt={ai.prompt}
          onPrompt={(v) => setAi((s) => ({ ...s, prompt: v }))}
          busy={ai.busy}
          error={ai.error}
          draft={ai.draft}
          onRun={() => void runAiDraft()}
          onClose={() => {
            setAiOpen(false);
            setAi({ prompt: "", busy: false, draft: null, error: null });
          }}
          onAdopt={adoptAi}
        />
      )}
    </div>
  );
}
