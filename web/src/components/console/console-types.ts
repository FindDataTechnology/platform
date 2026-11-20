// Console view-model types (add-pack-console).
//
// The wire shape the platform's `GET /api/fleets/:id/console` returns. Both
// hosts (the 壹座 page and the facet share page) read this same object — the
// surface cut already happened server-side, so a host never has to decide what
// it is allowed to show.
//
// `data` is intentionally `unknown` per block: each block renderer narrows its
// own shape. That keeps a new block from having to widen every other block's
// type, and it keeps an older client able to degrade an unknown block instead
// of crashing the page.

export type ConsoleSurface = "platform" | "share";

export interface ConsoleBlockBase {
  block: string;
  state: "ready" | "absent";
  /** Present when state === "absent" — a machine-readable reason, not prose. */
  absentReason?: string;
}

export interface ConsoleBlockView extends ConsoleBlockBase {
  data?: unknown;
}

export interface ConsoleHeadline {
  block: string;
  field: string;
  value: string | number | null;
}

export interface ConsoleFleetSummary {
  id: string;
  name: string;
  state: string;
  /** Owner-side publication state (absent on responses from older servers). */
  published?: boolean;
  slug?: string | null;
}

export interface ConsoleViewModel {
  v: number;
  fleet: ConsoleFleetSummary;
  surface: ConsoleSurface;
  headline: ConsoleHeadline | null;
  blocks: ConsoleBlockView[];
  sampledAt: number;
}

// ── block payloads (what each renderer narrows to) ──────────────────────────

export interface ConsoleMemberRow {
  id: string;
  title: string;
  parentId?: string | null;
  targetKind?: string | null;
  status: string;
  statusReason?: string | null;
  kpiSlots?: Array<{ key: string; label: string; unit?: string | null }>;
  latestReportAt?: number | null;
  missedRounds?: number;
  skippedRounds?: number;
}

export interface ConsoleTeamData {
  fleet: ConsoleFleetSummary;
  statusCounts: Record<string, number>;
  members: ConsoleMemberRow[];
  sampledAt: number;
}

export interface ConsoleStreamEntry {
  memberId: string;
  title: string;
  status: string;
  report: { at: number; summary?: string | null; source?: string | null } | null;
}

export interface ConsoleStreamData {
  entries: ConsoleStreamEntry[];
  sampledAt: number;
}

export interface ConsoleKpiSlot {
  key: string;
  label: string;
  unit?: string | null;
  posts: Array<{ memberId: string; title: string; value: string | number; trend: number | null }>;
}

export interface ConsoleKpiData {
  slots: ConsoleKpiSlot[];
  sampledAt: number;
}

export interface ConsoleDecisionItem {
  id: string;
  severity: string;
  memberId: string;
  memberTitle: string | null;
  summary: string | null;
  submittedAt: number;
  expiresAt: number | null;
}

export interface ConsoleDecisionsData {
  open: number;
  items: ConsoleDecisionItem[];
  sampledAt: number;
}

export interface ConsoleSpendData {
  window: "24h" | "7d" | "30d";
  runs: number;
  turns: number;
  usageInput: number | null;
  usageOutput: number | null;
  costUsd: number | null;
  pricedTurns: number;
  baseline?: string;
  sampledAt: number;
}

export interface ConsoleOrchestrationData {
  declared: { edges?: Array<{ kind?: string; from?: string; to?: string }> } | null;
  expanded: Array<{ kind?: string; from?: string; to?: string; derived?: boolean }> | null;
  sampledAt: number;
}

// The status vocabulary the fleet read face uses. Colour never speaks alone
// (web-design-system): every status maps to a StatusKind AND keeps its text.
export const MEMBER_STATUS_KIND: Record<string, "running" | "paused" | "failed" | "waiting" | "neutral"> = {
  on_duty: "running",
  paused: "paused",
  failing: "failed",
  missing: "waiting",
  vacant: "waiting",
  passive: "neutral",
};
