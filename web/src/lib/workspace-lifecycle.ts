// workspace-lifecycle — the lifecycle ribbon as a pure projection of the
// server's real state machine (add-agent-builder-workspace design D3).
//
// The UI never invents a gate: every stage/next-action below mirrors
// server/routes/blueprints.js exactly —
//   approve requires a fully green validation (422 short-circuit);
//   cast requires status=approved AND the caller is the approver (403);
//   trial requires status=cast (409 "先有包才能装台" — trial rides AFTER cast);
//   signoff needs a report; a stale signoff (reportRanAt ≠ ranAt) re-opens sign;
//   reseal = cast again while status=cast, self-approved, self-signed, report
//   unmodified since approval (editing resets status to draft and clears the
//   approval — store.updateBlueprintContent), so "edited after cast" is the
//   DRAFT stage with a recast note, never a fake "reseal" affordance.

export type RibbonStageKey = "draft" | "approve" | "cast" | "trial" | "sign" | "reseal";
export type StageState = "done" | "current" | "upcoming";

export interface RibbonDoc {
  status: "draft" | "approved" | "cast";
  approvedBy: string | null;
  castPackId: string | null;
  castPackVersion: number | null;
  /** report.ranAt — null when no trial has ever run. */
  trialRanAt: number | null;
  /** report.signoff.by — null when unsigned. */
  signedBy: string | null;
  /** report.signoff.reportRanAt === report.ranAt (rerun voids the old sign). */
  signedMatches: boolean;
}

export interface RibbonContext {
  /** Latest validation verdict for the SAVED content (the gate the server checks). */
  verdictOk: boolean;
  /** Current user email; null when unknown (auth off) — never a false disable. */
  userEmail: string | null;
  /** A save round-trip is in flight (next action waits, nothing lies). */
  saving: boolean;
}

export type RibbonAction = "approve" | "cast" | "trial" | "sign" | "unsign" | "reseal";

export interface RibbonView {
  stages: { key: RibbonStageKey; state: StageState }[];
  /** The single primary next action; null = nothing actionable (e.g. unsign is secondary). */
  next: { action: RibbonAction; enabled: boolean; reasonKey: string | null } | null;
  /** Secondary action rendered as a quiet button (unsign). */
  secondary: { action: RibbonAction; enabled: boolean; reasonKey: string | null } | null;
  /** Extra honest note under the ribbon (locale key), or null. */
  noticeKey: string | null;
}

export const RIBBON_STAGE_ORDER: RibbonStageKey[] = ["draft", "approve", "cast", "trial", "sign"];

/** A document kind bounds the pipeline SHAPE (fix-agent-document-emit D2): a team
 *  document has trial/sign/reseal; an agent document stops at cast (no fleet, so
 *  no round to run — the server 409s trial/signoff by kind, mirrored here). */
export type RibbonKind = "team" | "agent";

/** The stage set per kind, in order. The agent set deliberately carries none of
 *  trial/sign/reseal — their appearance on an agent ribbon would promise a lane
 *  the server refuses. */
export const RIBBON_STAGES: Record<RibbonKind, RibbonStageKey[]> = {
  team: ["draft", "approve", "cast", "trial", "sign"],
  agent: ["draft", "approve", "cast"],
};

export function teamRibbon(doc: RibbonDoc, ctx: RibbonContext, kind: RibbonKind = "team"): RibbonView {
  const { verdictOk, userEmail, saving } = ctx;
  // With auth off nobody is known — the approver-only cast gate is then the
  // server's job (a 403 there is honest); never disable on an unknown email.
  const knownUser = userEmail != null;
  const isApprover = !knownUser || doc.approvedBy === userEmail;
  const signedFresh = doc.trialRanAt != null && doc.signedBy != null && doc.signedMatches;

  const order = RIBBON_STAGES[kind];
  const stage = (key: RibbonStageKey, current: RibbonStageKey): { key: RibbonStageKey; state: StageState } => ({
    key,
    state: key === current ? "current" : order.indexOf(key) < order.indexOf(current) ? "done" : "upcoming",
  });

  if (doc.status === "draft") {
    return {
      stages: order.map((k) => stage(k, "draft")),
      next: { action: "approve", enabled: verdictOk && !saving, reasonKey: verdictOk ? null : "ribbonNeedGreen" },
      secondary: null,
      // Edited after a cast: the server reset status to draft and cleared the
      // approval — say so, the market pack is untouched meanwhile.
      noticeKey: doc.castPackId ? "ribbonRecastNote" : null,
    };
  }

  if (doc.status === "approved") {
    return {
      stages: order.map((k) => stage(k, "cast")),
      next: {
        action: "cast",
        enabled: isApprover && !saving,
        reasonKey: isApprover ? null : "ribbonOnlyApprover",
      },
      secondary: null,
      noticeKey: null,
    };
  }

  // status === "cast"
  // agent 文档的链止于 cast：没有 trial/sign/reseal，next 为 null（borne out by
  // the stage set above, so this branch simply says "done").
  if (kind === "agent") {
    return {
      stages: order.map((k) => ({ key: k, state: "done" as StageState })),
      next: null,
      secondary: null,
      noticeKey: "ribbonCastRef",
    };
  }

  if (doc.trialRanAt == null) {
    return {
      stages: order.map((k) => stage(k, "trial")),
      next: { action: "trial", enabled: !saving, reasonKey: null },
      secondary: null,
      noticeKey: "ribbonCastRef",
    };
  }
  if (!signedFresh) {
    return {
      stages: order.map((k) => stage(k, "sign")),
      next: { action: "sign", enabled: !saving, reasonKey: null },
      secondary: doc.signedBy != null && !doc.signedMatches ? { action: "unsign", enabled: !saving, reasonKey: null } : null,
      noticeKey: doc.signedBy != null && !doc.signedMatches ? "ribbonSignStale" : "ribbonCastRef",
    };
  }
  // Green + signed + unmodified since approval → reseal (cast again so the
  // signed report rides into the market manifest). Approver discipline holds.
  return {
    stages: [...order.map((k) => ({ key: k, state: "done" as StageState })), { key: "reseal", state: "current" as StageState }],
    next: {
      action: "reseal",
      enabled: isApprover && !saving,
      reasonKey: isApprover ? null : "ribbonOnlyApprover",
    },
    secondary: { action: "unsign", enabled: !saving, reasonKey: null },
    noticeKey: "ribbonResealHint",
  };
}
