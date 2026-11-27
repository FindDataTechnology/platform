// Audience projection (agent-as-employee-model 5.x).
//
// One fact bundle -> three views. No view keeps its own copy: every number is
// read from `facts` at projection time, so general/professional/self cannot
// disagree. A field that cannot be read is `{ unavailable: reason }` with
// reason in undeclared | source_unavailable | forbidden — never 0 / [] / stale.

export const AUDIENCES = ["general", "professional", "self"];

const un = (reason, detail) => ({ unavailable: reason, ...(detail ? { detail } : {}) });

// A fact read that may have failed: { ok: true, value } | { ok: false, error }.
const read = (f, missingReason = "source_unavailable") =>
  f == null ? un("undeclared") : f.ok ? f.value : un(missingReason, f.error ?? null);

function costOf(facts) {
  const spend = read(facts.spend);
  if (spend?.unavailable) return spend;
  const w = spend.windows?.["30d"];
  if (!w || w.costUsd == null) return un("undeclared", "no priced turns in window");
  return { window: "30d", usd: w.costUsd, turns: w.turns };
}

function difficulties(facts) {
  const reports = read(facts.reports);
  if (reports?.unavailable) return reports;
  return reports
    .flatMap((r) => (r.blockers ?? []).map((b) => ({ memberId: r.memberId, text: typeof b === "string" ? b : b?.text ?? JSON.stringify(b), at: r.createdAt })));
}

function progress(facts) {
  const turns = read(facts.turns);
  if (turns?.unavailable) return turns;
  const counts = {};
  for (const t of turns) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { recentTurns: turns.length, byStatus: counts, lastAt: turns[0]?.startedAt ?? null };
}

function reportSummaries(facts) {
  const reports = read(facts.reports);
  if (reports?.unavailable) return reports;
  return reports.map((r) => ({ memberId: r.memberId, summary: r.summary, at: r.createdAt, ref: `report:${r.id}` }));
}

function outcomes(facts) {
  const reports = read(facts.reports);
  if (reports?.unavailable) return reports;
  const withMetrics = reports.filter((r) => r.metrics && Object.keys(r.metrics).length);
  if (!withMetrics.length) return un("undeclared", "no member reported metrics");
  return withMetrics.map((r) => ({ memberId: r.memberId, metrics: r.metrics, at: r.createdAt }));
}

function commitments(facts) {
  const decisions = read(facts.openDecisions);
  if (decisions?.unavailable) return decisions;
  return decisions.map((d) => ({ id: d.id, memberId: d.memberId ?? null, title: d.title ?? d.question ?? null, expiresAt: d.expiresAt ?? null, ref: `decision:${d.id}` }));
}

export function project(audience, facts, { memberId = null } = {}) {
  if (!AUDIENCES.includes(audience)) return { error: `audience must be one of ${AUDIENCES.join("|")}` };

  if (audience === "general") {
    return {
      audience,
      reports: reportSummaries(facts),
      progress: progress(facts),
      difficulties: difficulties(facts),
      cost: costOf(facts),
      outcomes: outcomes(facts),
      commitments: commitments(facts),
      detailRef: "professional",
    };
  }

  if (audience === "professional") {
    return {
      audience,
      cost: costOf(facts),
      spend: read(facts.spend),
      turns: read(facts.turns),
      reports: read(facts.reports),
      openDecisions: read(facts.openDecisions),
    };
  }

  // self: only this member's slice; other members' rows never leave here.
  if (!memberId) return { error: "self view requires memberId" };
  const role = read(facts.role);
  const member = read(facts.member);
  const budget = member?.unavailable ? member
    : member.contextBudget == null ? un("undeclared") : { contextBudget: member.contextBudget };
  const notices = read(facts.teamNotices);
  const memory = read(facts.memoryScope, "forbidden");
  const ownReports = read(facts.reports);
  return {
    audience,
    memberId,
    budget,
    cost: costOf(facts),
    permissions: role?.unavailable ? role : (role.organs?.hands ?? un("undeclared")),
    rules: role?.unavailable ? role : (role.organs?.charter ?? un("undeclared")),
    teamNotices: notices,
    visibleMemory: memory,
    myLatestReport: ownReports?.unavailable ? ownReports : (ownReports.find((r) => r.memberId === memberId) ?? un("undeclared", "no report yet")),
  };
}
