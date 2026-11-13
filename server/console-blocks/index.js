// ── Console block builders (openspec: add-pack-console) ──────────────────────
//
// One builder per console block. A builder is a PURE projection over reads the
// caller already has: it never opens a DB, never resolves a target and never
// fetches — the route hands in `db`, the member views and the params.
//
// Why injection instead of importing the fleet route: `memberView` lives in
// `server/routes/fleets.js` together with `resolveTarget` (which `server.js`
// consumes through `resolveFleetTarget`). Importing the route module from here
// would make the route ↔ builder pair a cycle and would drag `dsh-profile.js`
// into this module's import graph — the exact shape of the env-freeze incident
// (a new top-level import reordering module-level constants). So the route
// injects `memberView`, and this module only depends on the DB handle it is
// given. Extracting `memberView` into its own module is a later, separate move.
//
// Absence discipline: a block with no data returns `state: "absent"` plus a
// machine-readable reason. It NEVER fabricates a row, a zero or an estimate —
// "no reports yet" and "zero deliverables" are opposite readings on a console
// a human acts on.

import { reportTimelineEntry } from "../fleet-reports.js";
// Zero-dependency module (no imports of its own): safe to pull in here.
import { expandedEdges } from "../fleet-orchestration.js";

// Stripped from every block when the caller asks for the share surface. The
// console spec forbids the public page from carrying model/roster/tool-face
// information; stripping happens HERE so a new block cannot forget it.
export const SHARE_STRIPPED_MEMBER_FIELDS = [
  "model",
  "fallbackModel",
  "effectiveModel",
  "modelNotice",
  "effort",
  "contextBudget",
  "carrier",
  "inputPolicy",
  "effectiveInputPolicy",
  "taskId",
  "lastTurn",
  "failureStreak",
  "failingSince",
  "lastErrorKind",
  "consecutiveFailures",
];

const DEFAULT_STREAM_LIMIT = 8;
const DEFAULT_DECISION_LIMIT = 5;

function clampLimit(value, fallback, max) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function absent(reason) {
  return { state: "absent", absentReason: reason };
}

function ready(data) {
  return { state: "ready", data };
}

// The team roster: who is on duty and what each post last reported. This is the
// console's headline block — deliberately narrower than the owner cockpit's
// canvas (no orchestration edges, no drawer payloads).
function buildTeam({ fleet, members, now, surface }) {
  if (!members.length) return absent("no_members");
  const statusCounts = {};
  for (const m of members) statusCounts[m.status] = (statusCounts[m.status] ?? 0) + 1;
  const roster = members.map((m) => {
    const post = {
      id: m.id,
      title: m.title,
      parentId: m.parentId,
      targetKind: m.target?.kind ?? null,
      status: m.status,
      statusReason: m.statusReason ?? null,
      kpiSlots: m.kpiSlots ?? [],
      cadence: m.cadence ?? null,
      latestReportAt: m.latestReport?.at ?? null,
      missedRounds: m.missedRounds ?? 0,
      skippedRounds: m.skippedRounds ?? 0,
    };
    if (surface === "share") {
      for (const field of SHARE_STRIPPED_MEMBER_FIELDS) delete post[field];
    }
    return post;
  });
  return ready({
    fleet: { id: fleet.id, name: fleet.name, state: fleet.state },
    statusCounts,
    members: roster,
    sampledAt: now,
  });
}

// The daily stream: each post's newest report, missing posts first — the same
// ordering rule the cockpit's stream uses (a silent post is the interesting
// one). Rows come from the shared timeline mapper so the console and the drawer
// cannot disagree about a row's shape.
function buildStream({ members, params, now }) {
  const limit = clampLimit(params?.limit, DEFAULT_STREAM_LIMIT, 20);
  const rows = members
    .map((m) => ({
      memberId: m.id,
      title: m.title,
      status: m.status,
      report: m.latestReport?.at ? m.latestReport : null,
    }))
    .sort((a, b) => {
      if (a.status === "missing" && b.status !== "missing") return -1;
      if (b.status === "missing" && a.status !== "missing") return 1;
      return (b.report?.at ?? 0) - (a.report?.at ?? 0);
    })
    .slice(0, limit);
  if (!rows.some((r) => r.report)) return absent("no_reports");
  return ready({
    entries: rows.map((r) => ({
      memberId: r.memberId,
      title: r.title,
      status: r.status,
      report: r.report ? reportTimelineEntry({ ...r.report, createdAt: r.report.at, metrics: r.report.slots ?? [] }) : null,
    })),
    sampledAt: now,
  });
}

// KPI wall: declared slots across the roster, each with its latest value and
// the system-computed trend. A slot nobody reported is absent, not zero.
function buildKpi({ members, now }) {
  const bySlot = new Map();
  for (const m of members) {
    for (const slot of m.latestReport?.slots ?? []) {
      const row = bySlot.get(slot.key) ?? {
        key: slot.key,
        label: slot.label,
        unit: slot.unit ?? null,
        posts: [],
      };
      row.posts.push({ memberId: m.id, title: m.title, value: slot.value, trend: slot.trend ?? null });
      bySlot.set(slot.key, row);
    }
  }
  if (!bySlot.size) return absent("no_reported_kpis");
  return ready({ slots: [...bySlot.values()], sampledAt: now });
}

// Decision banner: open items, severity first then closest to policy expiry —
// the same ordering the cockpit applies, reached through the same fields.
function buildDecisions({ db, fleet, members, params, now }) {
  const limit = clampLimit(params?.limit, DEFAULT_DECISION_LIMIT, 20);
  const policy = fleet.decisionPolicy ?? { expiryHours: 72 };
  const expiryMs = policy.expiryHours > 0 ? policy.expiryHours * 3600_000 : null;
  let items = db
    .listDecisions({ fleetId: fleet.id, state: "open" })
    .map((item) => ({
      id: item.id,
      severity: item.severity,
      memberId: item.memberId,
      memberTitle: members.find((m) => m.id === item.memberId)?.title ?? null,
      // Decision rows carry `question` (the db column); `summary` is kept as
      // a fallback for rows written by other lanes.
      summary: item.question ?? item.summary ?? item.title ?? null,
      submittedAt: item.submittedAt,
      expiresAt: expiryMs ? item.submittedAt + expiryMs : null,
    }));
  if (params?.severity === "high") items = items.filter((i) => i.severity === "high");
  const sev = { high: 0, normal: 1, low: 2 };
  items.sort((a, b) => {
    if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity];
    return (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity);
  });
  if (!items.length) return absent("no_open_decisions");
  return ready({ open: items.length, items: items.slice(0, limit), sampledAt: now });
}

// Spend: the projection the owner spend endpoint already serves. Absent when
// the fleet has recorded no runs at all — an unpriced window stays null inside
// a readable block (honest absence inside data, not a fabricated zero).
function buildSpend({ db, fleet, params, now }) {
  const window = params?.window ?? "7d";
  const projection = db.spendProjection(fleet.id, { now });
  const all = projection.allTime ?? {};
  if (!(all.runs > 0) && !(all.turns > 0)) return absent("no_run_records");
  const selected = window === "24h" || window === "30d" ? window : "7d";
  return ready({
    window: selected,
    ...projection.windows[selected],
    allTime: all,
    baseline: projection.baseline,
    sampledAt: projection.sampledAt ?? now,
  });
}

// Orchestration: the DECLARED structure plus its read-time expansion. Absent
// when the fleet declared none — "no edges declared" is a legitimate state.
function buildOrchestration({ fleet, members, now }) {
  const declared = fleet.orchestration ?? null;
  if (!declared) return absent("not_declared");
  let expanded = null;
  try {
    // Declared edges plus the implicit report edges the org tree implies —
    // the same derivation the cockpit renders.
    expanded = expandedEdges({ members, orchestration: declared });
  } catch {
    // A malformed declaration must not take the page down; the block reports
    // the honest reason and the rest of the console still renders.
    return absent("declaration_unreadable");
  }
  return ready({ declared, expanded, sampledAt: now });
}

export const CONSOLE_BLOCK_BUILDERS = {
  team: buildTeam,
  stream: buildStream,
  kpi: buildKpi,
  decisions: buildDecisions,
  spend: buildSpend,
  orchestration: buildOrchestration,
};

/**
 * Assemble the console view model for one fleet and one surface.
 *
 * `section` is the pack's validated `console` declaration. Blocks not declared
 * for this surface are omitted entirely (server-side cut — the response never
 * carries their titles or data).
 */
export function buildConsoleViewModel({
  section,
  surface = "platform",
  db,
  fleet,
  tasks = new Map(),
  model = null,
  now = Date.now(),
  memberView,
}) {
  const blocks = Array.isArray(section?.blocks) ? section.blocks : [];
  // Derive the member views ONCE per request: every block reads the same
  // snapshot, so a block boundary can never show two different member states.
  const members = db
    .listMembers(fleet.id)
    .map((m) => memberView(db, fleet, m, tasks, { now, model }));

  const out = [];
  for (const entry of blocks) {
    const surfaces = Array.isArray(entry.surfaces) && entry.surfaces.length ? entry.surfaces : ["platform", "share"];
    if (!surfaces.includes(surface)) continue; // server-side cut
    const builder = CONSOLE_BLOCK_BUILDERS[entry.block];
    if (!builder) {
      out.push({ block: entry.block, state: "absent", absentReason: "unknown_block" });
      continue;
    }
    const result = builder({
      db,
      fleet,
      members,
      tasks,
      model,
      params: entry.params ?? {},
      surface,
      now,
    });
    out.push({ block: entry.block, ...result });
  }

  return {
    v: 1,
    fleet: { id: fleet.id, name: fleet.name, state: fleet.state },
    surface,
    headline: resolveHeadline(section?.headline, out),
    blocks: out,
    sampledAt: now,
  };
}

// `headline` names "<block>.<field>" inside a declared block. Resolved against
// the assembled blocks: an absent headline block yields null (never 0), and a
// missing field yields null with no fallback guess.
function resolveHeadline(headline, blocks) {
  if (typeof headline !== "string") return null;
  const dot = headline.indexOf(".");
  if (dot <= 0) return null;
  const blockId = headline.slice(0, dot);
  const field = headline.slice(dot + 1);
  const block = blocks.find((b) => b.block === blockId);
  if (!block || block.state !== "ready") return { block: blockId, field, value: null };
  const value = field.split(".").reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), block.data);
  return { block: blockId, field, value: value === undefined ? null : value };
}
