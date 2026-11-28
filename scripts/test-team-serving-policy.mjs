// Serving policy matrix (openspec: add-team-as-a2a-agent, 2.3–2.4).
//
// The matrix is the contract: visibility × caller × quota, every cell asserting
// a SPECIFIC code. "Some refusal" is not enough — the caller's next step differs
// per code (get approved vs ask to be listed vs wait for tomorrow), and a
// policy that collapses them into `internal_error` or one generic `forbidden`
// makes the UI unable to say the true thing.
//
// Two extra properties beyond the grid:
//   • an unauthenticated caller never learns anything past "unauthorized" —
//     depth/quota/approval are all checked AFTER identity;
//   • the code vocabulary is CLOSED, asserted by scanning the serving modules
//     for `code: "…"` literals. That catches a future endpoint inventing its
//     own refusal before it ships.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  decideServing,
  servingError,
  quotaResetAt,
  SERVING_ERROR_CODES,
  SERVING_HTTP_STATUS,
  QUOTA_FIELDS,
} = await import("../server/team-serving-policy.js");

const OWNER = "owner@x.test";
const LISTED = "listed@x.test";
const STRANGER = "stranger@x.test";

const QUOTA = { callsPerDay: 200, tokensPerDay: 2_000_000, usdPerDay: 5 };

const publication = (over = {}) => ({
  handle: "cs-team",
  visibility: "listed",
  callers: [LISTED, OWNER],
  quota: QUOTA,
  reception: "post-1",
  publishedBy: OWNER,
  ...over,
});

const callerOf = (subject) => (subject ? { kind: "session", subject } : null);

function decide(over = {}) {
  return decideServing({
    publication: publication(over.publication),
    caller: callerOf(over.subject === undefined ? LISTED : over.subject),
    fleetState: over.fleetState ?? "active",
    ownerEmail: OWNER,
    usage: over.usage ?? { calls: 0, tokens: 0, usd: 0 },
    approvals: over.approvals ?? [],
    depth: over.depth ?? 0,
    maxDepth: over.maxDepth ?? 3,
    now: () => 1_000_000,
    ...(over.publicationRaw !== undefined ? { publication: over.publicationRaw } : {}),
  });
}

// ── 2.3 the exhaustive grid ────────────────────────────────────────────────

test("visibility × caller × quota: every cell returns its own code", () => {
  const CALLERS = [
    ["no identity", null, "unauthorized"],
    ["owner", OWNER, "ok"],
    ["allow-listed", LISTED, "ok"],
    ["stranger", STRANGER, null], // depends on visibility — filled per row
  ];
  const VISIBILITIES = [
    ["private", "not_found"],
    ["listed", "needs_approval"],
    ["open", "not_listed"],
  ];

  for (const [visibility, strangerCode] of VISIBILITIES) {
    for (const [who, subject, fixed] of CALLERS) {
      // `private` answers not_found to EVERYONE, anonymous included: making
      // an anonymous caller see `unauthorized` while a stranger sees
      // `not_found` would be an existence oracle in itself.
      const expected = visibility === "private" ? "not_found" : (fixed ?? strangerCode);
      // quota has room
      const withRoom = decide({ publication: { visibility }, subject });
      assert.equal(withRoom.ok, expected === "ok", `${visibility}/${who} (room): ${JSON.stringify(withRoom)}`);
      if (expected !== "ok") {
        assert.equal(withRoom.code, expected, `${visibility}/${who} must be ${expected}`);
      }
      if (visibility === "private") assert.equal(withRoom.code, "not_found");

      // quota exhausted — only reachable for a caller who passed authorization
      if (expected === "ok") {
        for (const field of QUOTA_FIELDS) {
          const out = decide({
            publication: { visibility },
            subject,
            usage: { calls: field === "calls" ? 200 : 0, tokens: field === "tokens" ? 2_000_000 : 0, usd: field === "usd" ? 5 : 0 },
          });
          assert.equal(out.ok, false, `${visibility}/${who} with ${field} exhausted must refuse`);
          assert.equal(out.code, "quota_exceeded");
          assert.equal(out.detail.field, field);
        }
      }
    }
  }
});

test("identity is resolved before anything about the CALLER is revealed", () => {
  // `no_reception` is a published fact (the card itself is marked uncallable),
  // so it is answered before identity — nothing about the caller leaks by
  // saying it. Everything that describes the CALLER's standing stays behind
  // identity: a stranger on a listed team never sees depth or quota.
  assert.equal(
    decide({ publication: { visibility: "listed", reception: null }, subject: STRANGER, usage: { calls: 999 }, depth: 5 }).code,
    "no_reception",
  );
  const behindIdentity = decide({
    publication: { visibility: "listed", callers: [] },
    subject: STRANGER,
    usage: { calls: 999, tokens: 999, usd: 999 },
    depth: 5,
  });
  assert.equal(behindIdentity.code, "needs_approval", "depth/quota never pre-empt an authorization refusal");
});

// ── approvals (listed) ────────────────────────────────────────────────────

test("approval admits a stranger, expiry closes the door again", () => {
  const valid = decide({ publication: { visibility: "listed" }, subject: STRANGER, approvals: [{ subject: STRANGER, expiresAt: 2_000_000 }] });
  assert.equal(valid.ok, true);

  const noExpiry = decide({ publication: { visibility: "listed" }, subject: STRANGER, approvals: [{ subject: STRANGER, expiresAt: null }] });
  assert.equal(noExpiry.ok, true, "a one-off approval has no expiry and stays valid");

  const expired = decide({ publication: { visibility: "listed" }, subject: STRANGER, approvals: [{ subject: STRANGER, expiresAt: 999_999 }] });
  assert.equal(expired.code, "needs_approval");

  const someoneElse = decide({ publication: { visibility: "listed" }, subject: STRANGER, approvals: [{ subject: LISTED, expiresAt: null }] });
  assert.equal(someoneElse.code, "needs_approval", "an approval is per caller, never a blanket");
});

test("open does not consult approvals — the allow-list is the only door", () => {
  const out = decide({
    publication: { visibility: "open", callers: [] },
    subject: STRANGER,
    approvals: [{ subject: STRANGER, expiresAt: null }],
  });
  assert.equal(out.code, "not_listed", "an open team with an empty allow-list admits nobody");
});

// ── state / reception / depth ─────────────────────────────────────────────

test("paused and archived are different facts with different codes", () => {
  assert.equal(decide({ fleetState: "paused" }).code, "team_paused");
  assert.equal(decide({ fleetState: "paused", subject: OWNER }).code, "team_paused", "even the owner sees a paused team as paused");
  assert.equal(decide({ fleetState: "archived" }).code, "not_found");
});

test("an unpublished, private and withdrawn team answer identically", () => {
  const unpublished = decideServing({ publication: null, caller: callerOf(LISTED), ownerEmail: OWNER, fleetState: "active" });
  const priv = decide({ publication: { visibility: "private" } });
  const withdrawn = decideServing({ publication: null, caller: callerOf(OWNER), ownerEmail: OWNER, fleetState: "active" });
  for (const out of [unpublished, priv, withdrawn]) {
    assert.equal(out.ok, false);
    assert.deepEqual({ code: out.code, message: out.message }, { code: "not_found", message: "Team not found" });
  }
});

test("no reception post means the team cannot be called at all", () => {
  assert.equal(decide({ publication: { reception: null }, subject: OWNER }).code, "no_reception");
  assert.equal(decide({ publication: { reception: "" }, subject: OWNER }).code, "no_reception", "an empty id is not a post");
});

test("depth is checked before quota so a too-deep chain cannot spend the budget", () => {
  const out = decide({ subject: OWNER, depth: 3, maxDepth: 3, usage: { calls: 200, tokens: 2_000_000, usd: 5 } });
  assert.equal(out.code, "depth_exceeded", "depth wins over quota");
  assert.equal(out.detail.max, 3);
  assert.equal(decide({ subject: OWNER, depth: 2, maxDepth: 3 }).ok, true);
  assert.equal(decide({ subject: OWNER, depth: 0, maxDepth: Number.POSITIVE_INFINITY }).ok, true, "no bound configured = unbounded");
});

// ── 2.4 the closed set ────────────────────────────────────────────────────

test("every code has an HTTP status and a readable message", () => {
  for (const code of SERVING_ERROR_CODES) {
    const out = servingError(code);
    assert.equal(out.code, code);
    assert.equal(typeof out.message, "string");
    assert.ok(out.message.length > 0);
    assert.equal(Number.isInteger(SERVING_HTTP_STATUS[code]), true, `no HTTP mapping for ${code}`);
  }
  // An invented code degrades to internal_error rather than reaching a caller.
  const invented = servingError("very_forbidden");
  assert.equal(invented.code, "internal_error");
  assert.equal(invented.message, "Internal error");
});

test("no serving module invents a code outside the set", () => {
  const ROOT = path.resolve(import.meta.dirname, "..");
  const files = ["server/team-serving-policy.js", "server/caller-identity.js"];
  const literal = /\bcode:\s*["']([a-z_]+)["']/g;
  const found = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of src.matchAll(literal)) found.push({ rel, code: m[1] });
  }
  assert.ok(found.length > 0, "the scan must actually see codes (a scanner that finds nothing proves nothing)");
  const stray = found.filter((f) => !SERVING_ERROR_CODES.includes(f.code));
  assert.deepEqual(stray, [], `codes outside the closed set: ${JSON.stringify(stray)}`);
});

test("the quota reset instant is the next UTC midnight and is readable", () => {
  const now = Date.UTC(2026, 10, 12, 13, 45, 0); // 2026-11-12T13:45Z
  const reset = quotaResetAt(now);
  assert.equal(reset, Date.UTC(2026, 10, 13, 0, 0, 0));
  assert.equal(reset > now, true);
  assert.equal(reset - now <= 24 * 60 * 60 * 1000, true, "the window can never exceed a day");
});
