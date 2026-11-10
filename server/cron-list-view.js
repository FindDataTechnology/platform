// The scheduled-task list a caller actually needs (fix-cron-list-scope).
//
// Measured on the deployment: one cell held **816 tasks, 658 of them fleet
// materializations** (a cadence per post). `cron_list` shipped every one as a
// line — 112KB per call, the largest single tool result on the fleet — and 80%
// of it was posts' cadence rows that the fleet surface (`fleet_list` /
// `fleet_spec_read`) already owns.
//
// So the list is scoped, paged, and always says what it left out:
//   scope=user  (default) — the operator's own tasks: what "my scheduled tasks"
//                means, and what this tool is for;
//   scope=fleet           — only fleet materializations (troubleshooting a post's
//                cadence without the rest of the noise);
//   scope=all             — both, for an audit.
// Nothing is hidden silently: the header always states the totals and the scope.
//
// Pure and exported so it has a test face (the MCP module spawns a stdio server
// at import and cannot be imported by a test).

export const CRON_LIST_LIMIT = 30;
export const CRON_LIST_MAX = 200;
export const CRON_SCOPES = ["user", "fleet", "all"];

export function isFleetTask(job) {
  return Boolean(job?.sourceTag?.fleetId);
}

export function shapeCronList(jobs = [], { scope = "user", limit = null, offset = 0 } = {}) {
  const all = Array.isArray(jobs) ? jobs : [];
  const fleet = all.filter(isFleetTask);
  const user = all.filter((j) => !isFleetTask(j));
  const pool = scope === "fleet" ? fleet : scope === "all" ? all : user;

  const requested = Number(limit);
  const cap = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), CRON_LIST_MAX) : CRON_LIST_LIMIT;
  const start = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Math.floor(Number(offset)) : 0;
  const page = pool.slice(start, start + cap);

  // The header carries the accounting in every case, so a scoped or paged view
  // can never read as "this is everything".
  const parts = [`${pool.length} task(s) in scope=${scope}`];
  if (scope !== "all") parts.push(`${all.length} total: ${user.length} operator, ${fleet.length} fleet-materialized`);
  else parts.push(`${user.length} operator, ${fleet.length} fleet-materialized`);
  const range = page.length ? `${start + 1}-${start + page.length} of ${pool.length}` : `none of ${pool.length}`;
  const truncated = start + page.length < pool.length;
  return {
    jobs: page,
    total: pool.length,
    allTotal: all.length,
    userTotal: user.length,
    fleetTotal: fleet.length,
    offset: start,
    limit: cap,
    truncated,
    header: `${parts.join(" · ")} — showing ${range}${truncated ? ` (next offset ${start + page.length})` : ""}.`,
  };
}
