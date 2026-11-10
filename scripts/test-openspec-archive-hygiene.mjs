#!/usr/bin/env node
// ── Archive hygiene: "complete" must mean "in effect" ───────────────────────
//
// Three changes were found sitting in openspec/changes/ with every task ticked
// and `openspec validate --strict` green (add-memory-visible-ux,
// add-erp-supply-chain-gateway-proxy, add-lex-line-board). Their spec deltas
// were therefore NOT in openspec/specs/ — the contract they described had never
// taken effect, while `openspec list` showed a reassuring "✓ Complete".
//
// The failure mode is structural, not careless: ticking the last task feels
// like finishing, and nothing anywhere fails when the archive step is skipped.
// This check is that missing failure. It is deliberately narrow — it does not
// judge whether a change SHOULD be archived, so it can only fail when a change
// claims completion it has not delivered into specs/.
//
// ── Deferrals (2026-11-11) ──────────────────────────────────────────────────
// The rule above has one real-world gap: a change can be finished in its own
// lane while its AUTHOR still owns the archive step (they are mid-release, or
// they ticked the last box minutes ago). Flagging that as a violation pressures
// whoever runs the lane next into archiving somebody else's live work — which is
// how duplicate-archive conflicts happen.
//
// So a fully-ticked-but-open change may be DEFERRED in
// openspec/archive-pending.json, with a reason and an `until` date:
//
//   { "deferred": [
//       { "change": "<change-name>", "reason": "<why it is still open>",
//         "until": "2026-11-13" } ] }
//
// Three deliberate constraints keep this from becoming a dumping ground:
//   1. a reason is REQUIRED (an unexplained deferral fails);
//   2. an `until` date is REQUIRED and must parse as YYYY-MM-DD;
//   3. once `until` passes, the change is an offender again — the deferral
//      EXPIRES by itself, so forgetting to remove it cannot silence the gate.
// A deferral that no longer describes anything (the change was archived, or
// reopened) is reported loudly but does not fail: that is cleanup advice, and
// failing on it would red the gate on good news.
//
//   node --test scripts/test-openspec-archive-hygiene.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGES = path.join(REPO, "openspec", "changes");
const PENDING = path.join(REPO, "openspec", "archive-pending.json");

// Read the change list from tasks.md — NOT through the `openspec` CLI. The CLI
// is installed globally on a developer machine but is deliberately NOT a
// dependency of this repo, so shelling out to `npx openspec` would fail (or
// worse, try to download) inside CI's fresh snapshot. The markdown is the
// source of truth anyway: a task is done iff its line starts with "- [x]".
function changeList() {
  if (!existsSync(CHANGES)) return [];
  const changes = [];
  for (const entry of readdirSync(CHANGES, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    const tasksPath = path.join(CHANGES, entry.name, "tasks.md");
    if (!existsSync(tasksPath)) continue;
    const lines = readFileSync(tasksPath, "utf8").split("\n");
    const total = lines.filter((l) => /^- \[[ xX]\]/.test(l)).length;
    const done = lines.filter((l) => /^- \[[xX]\]/.test(l)).length;
    changes.push({ name: entry.name, completedTasks: done, totalTasks: total });
  }
  return changes;
}

// A change "claims completion" when it has tasks AND all of them are ticked.
// The two are different assertions on purpose: a 0-task change is not complete.
const completeButOpen = (changes) =>
  changes.filter((c) => (c.totalTasks ?? 0) > 0 && c.completedTasks === c.totalTasks);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// LOCAL calendar date, not UTC. A deferral's `until` is a date a human wrote in
// their own calendar ("archive by the 13th"), so comparing it against the UTC
// date lets an entry outlive its deadline by the UTC offset — measured: at
// 2026-11-11 00:35 CST the UTC date is still 2026-11-10, so an entry with
// `until: 2026-11-10` read as LIVE and the gate stayed green a day too long.
// (Found by trying to prove the expiry branch fires at all: back-dating to
// "yesterday" did not turn it red.)
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Well-formed AND unexpired. Pure (takes `now`) so the expiry branch can be
// pinned by a test instead of being asserted through `Map.has` — the first
// version of the in-test reverse check did exactly that and was therefore
// vacuous in the expired direction.
function isActiveDeferral(d, now) {
  if (!d?.change) return false;
  if (typeof d.reason !== "string" || !d.reason.trim()) return false;
  if (typeof d.until !== "string" || !DATE.test(d.until)) return false;
  // ISO dates compare lexicographically; an expired deferral is inactive.
  return now <= d.until;
}

/** Deferrals that are well-formed and not yet expired, keyed by change name. */
function activeDeferrals(now = today()) {
  if (!existsSync(PENDING)) return new Map();
  const doc = JSON.parse(readFileSync(PENDING, "utf8"));
  const out = new Map();
  for (const d of doc?.deferred ?? []) {
    if (isActiveDeferral(d, now)) out.set(d.change, d);
  }
  return out;
}

test("a change with every task ticked is archived, not merely listed as complete", () => {
  const deferred = activeDeferrals();
  const offenders = completeButOpen(changeList())
    .filter((c) => !deferred.has(c.name))
    .map((c) => `${c.name} (${c.completedTasks}/${c.totalTasks})`);
  assert.deepEqual(
    offenders,
    [],
    "every task is ticked but the change still sits in openspec/changes/, so its spec delta " +
      "never reached openspec/specs/ — archive it (openspec archive <name> --yes), leave a " +
      "deliberate unticked task with a reason, or defer it in openspec/archive-pending.json " +
      `with a reason and an expiry date:\n${offenders.join("\n")}`,
  );
});

test("the check itself fails on a synthetic offender", () => {
  // Reverse verification, in-test: if this predicate ever stops catching the
  // shape it exists for, the suite must say so rather than pass vacuously.
  //
  // This is also where the deferral semantics are pinned: a live deferral
  // suppresses the verdict, an expired one does NOT.
  const fake = [
    { name: "done-but-open", completedTasks: 3, totalTasks: 3 },
    { name: "genuinely-open", completedTasks: 2, totalTasks: 3 },
    { name: "no-tasks", completedTasks: 0, totalTasks: 0 },
  ];
  assert.deepEqual(completeButOpen(fake).map((c) => c.name), ["done-but-open"]);

  // The deferral predicate, pinned directly (not through Map.has — see the
  // note on isActiveDeferral: an earlier version of this check asserted the
  // Map, which made the "expired" direction pass no matter what).
  const live = { change: "done-but-open", reason: "author is mid-release", until: "2999-01-01" };
  const dead = { ...live, until: "2000-01-01" };
  assert.equal(isActiveDeferral(live, today()), true, "a live deferral must be active");
  assert.equal(isActiveDeferral(dead, today()), false, "an EXPIRED deferral must be inactive — the gate has to come back on its own");
  assert.equal(isActiveDeferral({ ...live, reason: "  " }, today()), false, "an unexplained deferral must not count");
  assert.equal(isActiveDeferral({ ...live, until: "2026/11/13" }, today()), false, "a non-ISO date must not count");

  const suppressed = completeButOpen(fake).filter((c) => !new Map([[live.change, live]]).has(c.name));
  assert.deepEqual(suppressed.map((c) => c.name), [], "a live deferral must suppress the violation");
  // Per-change, with an expired deferral: the offender must come back. (The
  // first version ignored `c` entirely and asserted a constant — biome flagged
  // the unused parameter, which is exactly the smell.)
  const resurfaced = completeButOpen(fake).filter(
    (c) => !isActiveDeferral({ change: c.name, reason: "author is mid-release", until: "2000-01-01" }, today()),
  );
  assert.deepEqual(resurfaced.map((c) => c.name), ["done-but-open"], "expiry must bring the offender back");

  // The error TEXT is part of the contract: an expired deferral must name the
  // change AND all three remediation moves with their concrete command/path.
  // Without this the gate can stay green while quietly degrading to "expired"
  // with no next step.
  const note = expiryRemediation([{ change: "done-but-open", until: "2000-01-01" }]);
  for (const must of [
    "done-but-open",
    "2000-01-01",
    "openspec archive done-but-open --yes",
    "openspec/archive-pending.json",
    'a new "reason"',
    "openspec/changes/done-but-open/tasks.md",
    "do NOT simply delete this entry",
  ]) {
    assert.ok(note.includes(must), `expiry message must mention ${JSON.stringify(must)}`);
  }
});

/**
 * The remediation text for expired deferrals, one block per entry.
 *
 * An expiry is the one state where the gate EXPECTS a human decision, so the
 * message has to carry the whole decision, not just "expired": exactly one of
 * three moves, each with the concrete command/path for THIS change. Kept as a
 * pure function so the wording itself is pinned by a test — a message nobody
 * verifies is where a gate quietly stops telling you what to do.
 */
function expiryRemediation(entries) {
  return entries
    .map((d) => {
      const name = d.change;
      return (
        `\n  ${name}  (deferred until ${d.until}) — pick exactly one:\n` +
        `    (a) it IS done → archive it:  openspec archive ${name} --yes\n` +
        `    (b) it must stay open, and you have a NEW reason → edit openspec/archive-pending.json:\n` +
        `        set a new "reason" (why it is still open today) and a new "until"; renewing with the\n` +
        `        old reason is not a reason.\n` +
        `    (c) it must stay open with no new reason → untick one task in\n` +
        `        openspec/changes/${name}/tasks.md with a line saying why (that is the gate's\n` +
        `        built-in escape hatch, and it is visible to readers of the change).\n` +
        `    Whatever you pick, do NOT simply delete this entry to silence the gate.`
      );
    })
    .join("\n");
}

test("deferrals carry a reason and an unexpired date; stale ones are reported", () => {
  if (!existsSync(PENDING)) return;
  const doc = JSON.parse(readFileSync(PENDING, "utf8"));
  const entries = doc?.deferred ?? [];
  assert.ok(Array.isArray(entries), "openspec/archive-pending.json: `deferred` must be an array");

  const malformed = [];
  const expired = [];
  const stale = [];
  const open = new Set(completeButOpen(changeList()).map((c) => c.name));
  const now = today();
  for (const d of entries) {
    const name = d?.change;
    if (!name) {
      malformed.push("entry without `change`");
      continue;
    }
    if (typeof d.reason !== "string" || !d.reason.trim()) malformed.push(`${name}: reason missing`);
    if (typeof d.until !== "string" || !DATE.test(d.until)) {
      malformed.push(`${name}: until must be YYYY-MM-DD`);
    } else if (now > d.until) {
      expired.push({ change: name, until: d.until });
    }
    // Not an assertion: a deferral for a change that is archived or reopened is
    // just leftover bookkeeping — say so, don't red the lane on good news.
    if (!open.has(name)) stale.push(name);
  }
  assert.deepEqual(malformed, [], `archive-pending.json has malformed entries:\n${malformed.join("\n")}`);
  assert.deepEqual(
    expired,
    [],
    `these deferrals are past their \`until\` date (today is ${now}). The change is due to be\n` +
      `archived, and re-deferring is only legitimate with a NEW reason — otherwise tick nothing and\n` +
      `treat the change as unfinished:\n${expiryRemediation(expired)}\n`,
  );
  if (stale.length) {
    console.log(`[archive-pending] leftover deferral(s), safe to delete: ${stale.join(", ")}`);
  }
});
