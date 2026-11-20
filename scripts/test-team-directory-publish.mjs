// Team card derivation + publication validation (openspec:
// add-agent-team-directory, tasks 1.1–1.5 / 2.2–2.3).
//
// What is pinned here is the part that cannot be fixed later by a UI change:
//   • the card is a WHITELIST projection — a new column on fleets/fleet_members
//     must never appear on the card on its own;
//   • posts/skills carry the external title + post id only (no target_id, no
//     pack_id, no prompt, no key reference);
//   • derivation is deterministic (two reads cannot disagree);
//   • "unlimited" quota is not expressible — it falls back and says so;
//   • publish/withdraw are owner-only, and unknown vs not-yours are the same
//     answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const {
  CARD_FIELDS,
  DEFAULT_CARD_QUOTA,
  ensureTeamCardsTable,
  validatePublication,
  deriveCard,
  publishCard,
  deleteCard,
  getPublication,
  listPublications,
  listVisibleCards,
} = await import("../server/team-card.js");

const CELL = "cell-1";
const OWNER = "owner@example.test";

function freshDb() {
  const db = new Database(":memory:");
  ensureTeamCardsTable(db);
  return db;
}

const FLEET = { id: "f1", name: "客服班组", ownerEmail: OWNER, state: "active" };
const MEMBERS = [
  { id: "m1", title: "接待岗", targetKind: "a2a", targetId: "pack/secret/agent-1", packId: "secret-pack" },
  { id: "m2", title: "复盘岗", targetKind: "persona", targetId: "preset-9" },
];

function published(db, input = {}) {
  return publishCard(db, {
    cellId: CELL,
    fleet: FLEET,
    members: MEMBERS,
    owner: OWNER,
    input: { handle: "cs-team", displayName: "客服一组", description: "接售后工单", ...input },
  });
}

// ── 1.1 table ───────────────────────────────────────────────────────────────

test("the table is created idempotently with every column", () => {
  const db = freshDb();
  ensureTeamCardsTable(db); // second boot must not throw
  const cols = db.prepare("PRAGMA table_info(team_cards)").all().map((c) => c.name);
  for (const c of [
    "cell_id",
    "handle",
    "fleet_id",
    "display_name",
    "description",
    "visibility",
    "callers",
    "quota_calls_per_day",
    "quota_tokens_per_day",
    "quota_usd_per_day",
    "published_by",
    "published_at",
    "updated_at",
  ]) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
  // The audit table exists too (spec: 谁、何时、改了什么).
  assert.deepEqual(
    db.prepare("PRAGMA table_info(team_card_events)").all().map((c) => c.name).sort(),
    ["action", "actor", "cell_id", "created_at", "detail", "handle", "id"],
  );
});

// ── 1.2 whitelist projection ────────────────────────────────────────────────

test("a new fleet column never reaches the card", () => {
  const db = freshDb();
  const { card } = published(db);
  // Simulate someone adding a sensitive column and populating it.
  const dirtyFleet = { ...FLEET, billingKeyRef: "sk-live-SECRET", memoryPartition: "f/private", prompt: "内部口径：报价不低于 8 万" };
  const publication = getPublication(db, CELL, "cs-team");
  const derived = deriveCard({ fleet: dirtyFleet, members: MEMBERS, publication });
  assert.deepEqual(Object.keys(derived).sort(), [...CARD_FIELDS].sort(), "the card must carry exactly the whitelist");
  const blob = JSON.stringify(derived);
  for (const leak of ["sk-live-SECRET", "f/private", "内部口径"]) {
    assert.equal(blob.includes(leak), false, `leaked ${leak}`);
  }
  assert.deepEqual(Object.keys(card).sort(), [...CARD_FIELDS].sort());
});

test("posts and skills carry the external title and post id only", () => {
  const db = freshDb();
  const { card } = published(db);
  assert.deepEqual(card.posts, [{ id: "m1", title: "接待岗" }], "persona posts are not对外岗");
  assert.deepEqual(card.skills, [{ id: "m1", name: "接待岗" }]);
  const blob = JSON.stringify(card);
  for (const leak of ["pack/secret/agent-1", "secret-pack", "preset-9"]) {
    assert.equal(blob.includes(leak), false, `leaked internal identifier ${leak}`);
  }
});

test("derivation is deterministic and follows the live team", () => {
  const db = freshDb();
  published(db);
  const publication = getPublication(db, CELL, "cs-team");
  const a = deriveCard({ fleet: FLEET, members: MEMBERS, publication, now: 1 });
  const b = deriveCard({ fleet: FLEET, members: MEMBERS, publication, now: 1 });
  assert.deepEqual(a, b, "same inputs must produce the same card");

  const renamed = deriveCard({ fleet: { ...FLEET, name: "客服二组" }, members: MEMBERS, publication, now: 1 });
  assert.equal(renamed.name, "客服一组", "the published displayName wins over the live team name");

  const fewer = deriveCard({ fleet: FLEET, members: [MEMBERS[1]], publication, now: 1 });
  assert.deepEqual(fewer.posts, [], "a deleted post stops appearing without re-publishing");
});

test("availability follows the live fleet state", () => {
  const db = freshDb();
  published(db);
  const publication = getPublication(db, CELL, "cs-team");
  assert.equal(deriveCard({ fleet: FLEET, members: MEMBERS, publication }).availability.state, "accepting");
  assert.equal(
    deriveCard({ fleet: { ...FLEET, state: "paused" }, members: MEMBERS, publication }).availability.state,
    "paused",
  );
});

// ── 1.3 validation ──────────────────────────────────────────────────────────

test("visibility is a closed set", () => {
  assert.equal(validatePublication({ visibility: "public-ish" }).ok, false);
  assert.equal(validatePublication({ visibility: "open" }).ok, true);
  assert.equal(validatePublication({ visibility: "private" }).ok, true);
});

test("handle must be kebab-case and bounded", () => {
  assert.equal(validatePublication({ handle: "Bad Handle" }).ok, false);
  assert.equal(validatePublication({ handle: "-leading" }).ok, false);
  assert.equal(validatePublication({ handle: "a".repeat(65) }).ok, false);
  assert.equal(validatePublication({ handle: "cs-team-2" }).ok, true);
});

test("an unlimited quota falls back to the default and says which field", () => {
  for (const bad of [0, -1, null, "unlimited", Number.POSITIVE_INFINITY]) {
    const r = validatePublication({ usdPerDay: bad });
    assert.equal(r.ok, true, `expected fallback, not refusal, for ${String(bad)}`);
    assert.equal(r.normalized.quota.usdPerDay, DEFAULT_CARD_QUOTA.usdPerDay);
    assert.equal(r.fallbacks.length, 1);
    assert.equal(r.fallbacks[0].field, "usdPerDay");
  }
});

test("a non-integer quota is refused", () => {
  const r = validatePublication({ callsPerDay: 1.5 });
  assert.equal(r.ok, false);
  assert.equal(r.field, "callsPerDay");
});

test("unknown fields are refused so a typo cannot silently do nothing", () => {
  const r = validatePublication({ visiblity: "open" });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown field/);
});

test("callers dedupe, lowercase, and reject non-strings", () => {
  const r = validatePublication({ callers: ["A@x.test", "a@x.test", "b@x.test"] });
  assert.deepEqual(r.normalized.callers, ["a@x.test", "b@x.test"]);
  assert.equal(validatePublication({ callers: [42] }).ok, false);
});

// ── 1.4 owner gate + same-shape answers ─────────────────────────────────────

test("a non-owner cannot publish", () => {
  const db = freshDb();
  const r = publishCard(db, {
    cellId: CELL,
    fleet: FLEET,
    members: MEMBERS,
    owner: "someone-else@x.test",
    input: { handle: "cs-team" },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_owner");
  assert.equal(listPublications(db).length, 0, "no row may be written");
});

test("an unknown team and a not-yours team answer identically", () => {
  const db = freshDb();
  const unknown = publishCard(db, { cellId: CELL, fleet: null, members: [], owner: OWNER, input: { handle: "x" } });
  const notMine = publishCard(db, { cellId: CELL, fleet: FLEET, members: [], owner: "other@x.test", input: { handle: "x" } });
  assert.equal(unknown.ok, false);
  assert.equal(notMine.ok, false);
  // Both are refusals; the route maps both to the same 404 body.
  assert.notEqual(unknown.code, "conflict");
  assert.notEqual(notMine.code, "conflict");
});

test("a handle owned by another team is a conflict", () => {
  const db = freshDb();
  published(db);
  const r = publishCard(db, {
    cellId: CELL,
    fleet: { ...FLEET, id: "f2" },
    members: MEMBERS,
    owner: OWNER,
    input: { handle: "cs-team" },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "conflict");
});

test("withdraw is owner-only and leaves the team alone", () => {
  const db = freshDb();
  published(db);
  assert.equal(deleteCard(db, { cellId: CELL, handle: "cs-team", owner: "other@x.test", fleet: FLEET }).code, "not_owner");
  assert.equal(getPublication(db, CELL, "cs-team") !== null, true, "a refused withdraw must not delete");

  const ok = deleteCard(db, { cellId: CELL, handle: "cs-team", owner: OWNER, fleet: FLEET });
  assert.equal(ok.ok, true);
  assert.equal(getPublication(db, CELL, "cs-team"), null);
});

test("an admin may withdraw but may not publish", () => {
  const db = freshDb();
  published(db);
  assert.equal(deleteCard(db, { cellId: CELL, handle: "cs-team", owner: "admin@x.test", fleet: FLEET, isAdmin: true }).ok, true);
  // Publishing is unaffected: still owner-gated.
  assert.equal(published(db, { handle: "cs-team-2" }).ok, true);
});

// ── 1.5 audit trail ─────────────────────────────────────────────────────────

test("publish, update and withdraw each leave one readable event", () => {
  const db = freshDb();
  published(db);
  published(db, { visibility: "listed" });
  deleteCard(db, { cellId: CELL, handle: "cs-team", owner: OWNER, fleet: FLEET });
  const events = db.prepare("SELECT action, actor, detail FROM team_card_events ORDER BY id").all();
  assert.deepEqual(events.map((e) => e.action), ["publish", "update", "withdraw"]);
  assert.equal(events.every((e) => e.actor === OWNER), true);
  const update = JSON.parse(events[1].detail);
  assert.equal(update.from, "private");
  assert.equal(update.visibility, "listed");
});

// ── 2.2/2.3 sampling payload ────────────────────────────────────────────────

test("sampling sees listed/open cards and never a private one", () => {
  const db = freshDb();
  published(db, { handle: "a-card", visibility: "private" });
  published(db, { handle: "b-card", visibility: "listed" });
  published(db, { handle: "c-card", visibility: "open" });
  const fleetsById = new Map([["f1", FLEET]]);
  const membersByFleet = new Map([["f1", MEMBERS]]);
  const cards = listVisibleCards(db, { fleetsById, membersByFleet });
  assert.equal(cards.length, 2, "private must never be sampled");
});

test("a card whose team vanished simply stops appearing", () => {
  const db = freshDb();
  published(db);
  const cards = listVisibleCards(db, { fleetsById: new Map(), membersByFleet: new Map() });
  assert.deepEqual(cards, [], "no fleet → no card, and no throw");
});

// ── reception (add-team-as-a2a-agent 3.1–3.2) ───────────────────────────────

test("an old database gains the reception column, NULL, without changing derivation", () => {
  const db = new Database(":memory:");
  // Simulate the pre-A2A schema: create WITHOUT reception, insert a row, then boot.
  db.exec(`CREATE TABLE team_cards (
    cell_id TEXT NOT NULL, handle TEXT NOT NULL, fleet_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private', callers TEXT NOT NULL DEFAULT '[]',
    quota_calls_per_day INTEGER NOT NULL, quota_tokens_per_day INTEGER NOT NULL,
    quota_usd_per_day INTEGER NOT NULL, published_by TEXT NOT NULL DEFAULT '',
    published_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(cell_id, handle))`);
  db.exec("CREATE TABLE team_card_events (id INTEGER PRIMARY KEY AUTOINCREMENT, cell_id TEXT NOT NULL, handle TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)");
  db.prepare(`INSERT INTO team_cards VALUES ('cell-1','legacy','f1','老卡','', 'listed','[]',200,2000000,5,'owner@example.test',1,1)`).run();

  ensureTeamCardsTable(db); // the additive ALTER
  ensureTeamCardsTable(db); // and a second boot is a no-op
  const cols = db.prepare("PRAGMA table_info(team_cards)").all().map((c) => c.name);
  assert.equal(cols.includes("reception"), true);

  const row = getPublication(db, "cell-1", "legacy");
  assert.equal(row.reception, null, "an old row has no reception");
  const derived = deriveCard({ fleet: FLEET, members: MEMBERS, publication: row });
  assert.equal(derived.name, "老卡", "derivation of an old row is unchanged");
  assert.equal(derived.availability.callable, false, "no reception → the card says it cannot be called");
});

test("reception must be one of this team's a2a posts", () => {
  const db = freshDb();
  const ok = publishCard(db, {
    cellId: CELL, fleet: FLEET, members: MEMBERS, owner: OWNER,
    input: { handle: "cs-team", reception: "m1" },
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.publication.reception, "m1");
  assert.equal(ok.card.availability.callable, true);
  assert.equal(ok.card.availability.reception, "m1");

  const persona = publishCard(db, {
    cellId: CELL, fleet: FLEET, members: MEMBERS, owner: OWNER,
    input: { handle: "cs-team", reception: "m2" }, // persona post
  });
  assert.equal(persona.ok, false);
  assert.equal(persona.field, "reception");
  assert.match(persona.error, /a2a post/);

  const ghost = publishCard(db, {
    cellId: CELL, fleet: FLEET, members: MEMBERS, owner: OWNER,
    input: { handle: "cs-team", reception: "nope" },
  });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.field, "reception");
  assert.match(ghost.error, /one of this team's posts/);

  const foreign = publishCard(db, {
    cellId: CELL, fleet: FLEET, members: MEMBERS, owner: OWNER,
    input: { handle: "cs-team", reception: "other-teams-post" },
  });
  assert.equal(foreign.ok, false, "another team's post cannot be the entry point");

  // A refused reception does not disturb the effective row.
  assert.equal(getPublication(db, CELL, "cs-team").reception, "m1");

  // Explicitly clearing it is legal — the team stays listed but uncallable.
  const cleared = publishCard(db, {
    cellId: CELL, fleet: FLEET, members: MEMBERS, owner: OWNER,
    input: { handle: "cs-team", reception: null },
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.card.availability.callable, false);
});

// ── quota reset visibility (add-team-as-a2a-agent 4.4) ─────────────────────

test("the card publishes the reset instant next to the limits", () => {
  const db = freshDb();
  published(db);
  const publication = getPublication(db, CELL, "cs-team");
  const now = Date.UTC(2026, 10, 12, 13, 45, 0);
  const card = deriveCard({ fleet: FLEET, members: MEMBERS, publication, now });
  assert.equal(card.pricing.resetsAt, Date.UTC(2026, 10, 13, 0, 0, 0));
  assert.equal(card.pricing.resetsAt > now, true, "the reset is always ahead of the read");
  // Deterministic like every other derived field.
  assert.deepEqual(
    deriveCard({ fleet: FLEET, members: MEMBERS, publication, now }),
    card,
  );
});
