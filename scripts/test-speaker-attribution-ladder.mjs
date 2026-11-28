// The attribution ladder (openspec: add-speaker-attribution, 2.x–6.x).
//
// This is the capability's safety boundary, so the tests are written as
// refusals first: what must NEVER happen (a guess dispatching, a biometric
// field surviving, a binding leaking into the next recording) before what must.
//
//   node --test scripts/test-speaker-attribution-ladder.mjs

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const {
  BASIS,
  CLUSTER_ANONYMOUS,
  CLUSTER_SESSION,
  assertNoBiometrics,
  attributionSummary,
  bindCluster,
  bindingsMap,
  decideDispatch,
  deriveAttributions,
  ensureSpeakerTables,
  listAttributions,
  listBindingEvents,
  listBindings,
  listConflicts,
  normalizeClusters,
  planDispatch,
  purgeAttributions,
  unbindCluster,
  writeAttributions,
} = await import("../server/speaker-attribution.js");

const OWNER = "owner@x.test";
const NOW = Date.UTC(2026, 10, 12, 10, 0, 0);

function fresh() {
  const db = new Database(":memory:");
  ensureSpeakerTables(db);
  return db;
}

const slice = (seq, startMs, durationMs, text = `第${seq}段`) => ({
  seq,
  startMs,
  durationMs,
  status: "done",
  text,
});

const persist = (db, rows, { captureId = "cap_1", now = NOW } = {}) => {
  const out = writeAttributions(db, { captureId, owner: OWNER, rows, now });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
};

// ── 2.x data layer ────────────────────────────────────────────────────────

test("2.1 the three tables are created idempotently", () => {
  const db = fresh();
  ensureSpeakerTables(db); // second boot must not throw
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const t of ["speaker_attributions", "speaker_bindings", "speaker_binding_events"]) {
    assert.ok(tables.includes(t), `missing ${t}`);
  }
});

test("2.1 attribution rows die with their capture", () => {
  const db = fresh();
  persist(db, deriveAttributions({ chunks: [slice(0, 0, 30_000)] }));
  bindCluster(db, { captureId: "cap_1", owner: OWNER, cluster: CLUSTER_ANONYMOUS, member: "a@x.test", actor: OWNER, now: NOW });
  assert.ok(listAttributions(db, { captureId: "cap_1" }).length > 0);

  const purged = purgeAttributions(db, { captureId: "cap_1" });
  assert.ok(purged.rows > 0);
  assert.equal(listAttributions(db, { captureId: "cap_1" }).length, 0);
  assert.equal(listBindings(db, { captureId: "cap_1" }).length, 0);
  assert.equal(listBindingEvents(db, { captureId: "cap_1" }).length, 0);
});

test("2.2 a biometric field is refused and named, never written", () => {
  const db = fresh();
  const rows = deriveAttributions({ chunks: [slice(0, 0, 30_000)] });
  // Someone later "improves" the artifact by attaching the voiceprint.
  const poisoned = rows.map((r) => ({ ...r, voiceprint: [0.1, 0.2], embedding: { v: 1 } }));
  const refused = writeAttributions(db, { captureId: "cap_2", owner: OWNER, rows: poisoned, now: NOW });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "biometric_field");
  assert.ok(refused.offending.some((p) => /voiceprint/.test(p.split(".")[1] ?? p)));
  assert.equal(listAttributions(db, { captureId: "cap_2" }).length, 0, "nothing was written");

  // And the clean shape passes the same gate.
  assert.deepEqual(assertNoBiometrics({ rows: deriveAttributions({ chunks: [slice(0, 0, 1000)] }) }), { ok: true });
  assert.equal(assertNoBiometrics({ audio: "base64..." }).ok, false);
  assert.equal(assertNoBiometrics({ a: { b: { mfcc: [] } } }).ok, false);
});

test("2.3 cluster numbering is deterministic: same input, same numbers", () => {
  const raw = [
    { speaker: "B", start: 4, end: 6 },
    { speaker: "A", start: 0, end: 2 },
    { speaker: "C", start: 8, end: 9 },
    { speaker: "A", start: 2, end: 4 },
  ];
  const a = normalizeClusters(raw);
  const b = normalizeClusters([...raw].reverse());
  assert.deepEqual(a, b, "input order must not change the numbering");
  // First to SPEAK is speaker_1 — not the first in the array.
  assert.deepEqual(
    a.map((c) => c.cluster),
    ["speaker_1", "speaker_1", "speaker_2", "speaker_3"],
  );
});

// ── 3.x L0 session identity ───────────────────────────────────────────────

test("3.1 a personal-device recording is the speaker, with no cluster and no separation", () => {
  const rows = deriveAttributions({
    sessionMember: "me@x.test",
    chunks: [slice(0, 0, 30_000), slice(1, 30_000, 30_000)],
    // Even if separation were available, L0 does not need it.
    diarization: [],
  });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.certainty, "session");
    assert.equal(r.member, "me@x.test");
    assert.equal(r.cluster, CLUSTER_SESSION);
    assert.equal(r.basis, BASIS.session);
    assert.equal(r.conflict, null);
  }
  assert.equal(
    rows.some((r) => /^speaker_/.test(r.cluster)),
    false,
    "L0 must not produce anonymous clusters",
  );
});

test("3.2 a conflict keeps the session identity and records ONE readable anomaly", () => {
  const db = fresh();
  const diarization = [{ speaker: "X", start: 0, end: 30 }];
  // A binding on cluster speaker_1 exists for someone else.
  const bindings = new Map([["speaker_1", "someone-else@x.test"]]);
  const rows = deriveAttributions({
    sessionMember: "me@x.test",
    chunks: [slice(0, 0, 30_000)],
    diarization,
    bindings,
  });
  assert.equal(rows[0].member, "me@x.test", "session identity wins");
  assert.equal(rows[0].certainty, "session");
  assert.ok(rows[0].conflict, "the disagreement is recorded");
  assert.deepEqual(rows[0].conflict.clusters, ["speaker_1"]);

  persist(db, rows);
  const conflicts = listConflicts(db, { captureId: "cap_1" });
  assert.equal(conflicts.length, 1, "exactly one anomaly, not one per field");
  assert.match(conflicts[0].conflict.note, /会话身份/);
});

// ── 4.x honest degradation (the live case: the lane separates nothing) ─────

test("4.2 without separation the slice is anonymous and SAYS the场 was not separated", () => {
  const rows = deriveAttributions({ chunks: [slice(0, 0, 30_000), slice(1, 30_000, 30_000)] });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.cluster, CLUSTER_ANONYMOUS);
    assert.equal(r.certainty, "anonymous");
    assert.equal(r.member, null);
    assert.equal(r.basis, BASIS.anonymousNoDiarization);
  }
  // The refusal this encodes: "not separated" must never be rendered as
  // "only one person spoke".
  assert.equal(
    rows.some((r) => r.cluster === "speaker_1"),
    false,
    "no cluster may be invented",
  );
});

test("4.4 a slice where two clusters overlap is refused an identity", () => {
  const rows = deriveAttributions({
    chunks: [slice(0, 0, 60_000)],
    diarization: [
      { speaker: "A", start: 0, end: 30 },
      { speaker: "B", start: 30, end: 60 },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cluster, CLUSTER_ANONYMOUS);
  assert.equal(rows[0].member, null);
  assert.equal(rows[0].basis, BASIS.anonymousMultiPerson);
});

test("L1 with real separation and no binding is still anonymous (no identity inference)", () => {
  const rows = deriveAttributions({
    chunks: [slice(0, 0, 30_000)],
    diarization: [{ speaker: "A", start: 0, end: 30 }],
  });
  assert.equal(rows[0].cluster, "speaker_1");
  assert.equal(rows[0].certainty, "anonymous");
  assert.equal(rows[0].member, null, "a cluster is not a person");
});

// ── 5.x binding ───────────────────────────────────────────────────────────

test("5.1 a binding to someone who was not present is refused, with the reason", () => {
  const db = fresh();
  persist(db, deriveAttributions({ chunks: [slice(0, 0, 30_000)], diarization: [{ speaker: "A", start: 0, end: 30 }] }));
  const refused = bindCluster(db, {
    captureId: "cap_1",
    owner: OWNER,
    cluster: "speaker_1",
    member: "stranger@x.test",
    actor: OWNER,
    allowedMembers: ["a@x.test", "b@x.test"],
    now: NOW,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "member_not_present");
  assert.equal(refused.detail.member, "stranger@x.test");
  assert.equal(listBindings(db, { captureId: "cap_1" }).length, 0);
});

test("5.2 bind → rebind → unbind each leave an audit trail", () => {
  const db = fresh();
  persist(db, deriveAttributions({ chunks: [slice(0, 0, 30_000)], diarization: [{ speaker: "A", start: 0, end: 30 }] }));

  const bound = bindCluster(db, { captureId: "cap_1", owner: OWNER, cluster: "speaker_1", member: "a@x.test", actor: "admin@x.test", now: NOW });
  assert.equal(bound.ok, true);
  assert.equal(bound.op, "bind");
  assert.equal(listAttributions(db, { captureId: "cap_1" })[0].member, "a@x.test");
  assert.equal(listAttributions(db, { captureId: "cap_1" })[0].certainty, "bound");

  const rebound = bindCluster(db, { captureId: "cap_1", owner: OWNER, cluster: "speaker_1", member: "b@x.test", actor: "admin@x.test", now: NOW + 1000 });
  assert.equal(rebound.op, "rebind");
  assert.equal(rebound.previous, "a@x.test");
  assert.equal(listAttributions(db, { captureId: "cap_1" })[0].member, "b@x.test");

  const unbound = unbindCluster(db, { captureId: "cap_1", cluster: "speaker_1", actor: "admin@x.test", now: NOW + 2000 });
  assert.equal(unbound.ok, true);
  assert.equal(listAttributions(db, { captureId: "cap_1" })[0].member, null, "back to anonymous");
  assert.equal(listAttributions(db, { captureId: "cap_1" })[0].certainty, "anonymous");
  assert.equal(decideDispatch({ certainty: "anonymous" }).dispatch, false);

  const events = listBindingEvents(db, { captureId: "cap_1" });
  assert.deepEqual(
    events.map((e) => e.op),
    ["bind", "rebind", "unbind"],
  );
  assert.equal(events[1].from, "a@x.test");
  assert.equal(events[1].to, "b@x.test");
  assert.equal(events[1].actor, "admin@x.test", "who did it is part of the record");
  assert.equal(events[2].from, "b@x.test");
  assert.equal(events[2].to, null);
});

test("5.4 a binding never carries into the next capture", () => {
  const db = fresh();
  persist(db, deriveAttributions({ chunks: [slice(0, 0, 30_000)], diarization: [{ speaker: "A", start: 0, end: 30 }] }), {
    captureId: "cap_1",
  });
  bindCluster(db, { captureId: "cap_1", owner: OWNER, cluster: "speaker_1", member: "a@x.test", actor: OWNER, now: NOW });

  // The next recording numbers its cluster the same way — and must stay anonymous.
  const nextRows = deriveAttributions({
    chunks: [slice(0, 0, 30_000)],
    diarization: [{ speaker: "A", start: 0, end: 30 }],
    bindings: bindingsMap(db, { captureId: "cap_2" }),
  });
  assert.equal(nextRows[0].cluster, "speaker_1", "same number, as expected");
  assert.equal(nextRows[0].member, null, "and no inherited identity");
  assert.equal(nextRows[0].certainty, "anonymous");
});

test("5.3 rebinding updates the view and the trail keeps the moment", () => {
  const db = fresh();
  persist(db, deriveAttributions({ chunks: [slice(0, 0, 30_000)], diarization: [{ speaker: "A", start: 0, end: 30 }] }));
  bindCluster(db, { captureId: "cap_1", owner: OWNER, cluster: "speaker_1", member: "a@x.test", actor: OWNER, now: NOW });
  bindCluster(db, { captureId: "cap_1", owner: OWNER, cluster: "speaker_1", member: "c@x.test", actor: OWNER, now: NOW + 5000 });

  const view = listAttributions(db, { captureId: "cap_1" });
  assert.equal(view[0].member, "c@x.test", "the view follows the latest binding");
  const rebind = listBindingEvents(db, { captureId: "cap_1" }).find((e) => e.op === "rebind");
  assert.equal(rebind.at, NOW + 5000, "the moment is recorded");
  assert.equal(rebind.from, "a@x.test");
  assert.equal(rebind.to, "c@x.test");
});

test("the session cluster is not bindable — it is not a guess", () => {
  const db = fresh();
  assert.equal(
    bindCluster(db, { captureId: "cap_1", owner: OWNER, cluster: CLUSTER_SESSION, member: "a@x.test", actor: OWNER }).code,
    "cluster_not_bindable",
  );
});

// ── 6.x dispatch admission ────────────────────────────────────────────────

test("6.1 the certainty × team matrix: anonymous never dispatches", () => {
  for (const certainty of ["session", "bound"]) {
    assert.equal(decideDispatch({ certainty, hasTeam: true }).dispatch, true, certainty);
    assert.equal(decideDispatch({ certainty, hasTeam: false }).reason, "no_team");
  }
  for (const hasTeam of [true, false]) {
    const d = decideDispatch({ certainty: "anonymous", hasTeam });
    assert.equal(d.dispatch, false, `anonymous with team=${hasTeam}`);
    assert.equal(d.reason, "needs_confirmation");
    assert.equal(d.code, "attribution_uncertain");
  }
});

test("6.1 a plan over a mixed capture dispatches only the confident rows", () => {
  const rows = [
    { cluster: CLUSTER_SESSION, certainty: "session" },
    { cluster: "speaker_1", certainty: "bound" },
    { cluster: CLUSTER_ANONYMOUS, certainty: "anonymous" },
    { cluster: "speaker_2", certainty: "anonymous" },
  ];
  const planned = planDispatch(rows, { hasTeam: true });
  assert.deepEqual(
    planned.map((p) => p.decision.dispatch),
    [true, true, false, false],
  );
  assert.equal(planned.filter((p) => p.decision.reason === "needs_confirmation").length, 2);
});

test("6.1 with no team nothing dispatches and nothing queues for confirmation", () => {
  const planned = planDispatch([{ cluster: CLUSTER_SESSION, certainty: "session" }], { hasTeam: false });
  assert.equal(planned[0].decision.dispatch, false);
  assert.equal(planned[0].decision.reason, "no_team", "a missing team is not an uncertain attribution");
});

// ── 7.x summary ───────────────────────────────────────────────────────────

test("the summary counts what a surface needs, including anomalies", () => {
  const rows = [
    { cluster: CLUSTER_SESSION, certainty: "session", conflict: { clusters: ["speaker_1"] } },
    { cluster: "speaker_1", certainty: "bound", conflict: null },
    { cluster: CLUSTER_ANONYMOUS, certainty: "anonymous", conflict: null },
  ];
  const s = attributionSummary(rows);
  assert.equal(s.total, 3);
  assert.equal(s.session, 1);
  assert.equal(s.bound, 1);
  assert.equal(s.anonymous, 1);
  assert.equal(s.dispatchable, 2);
  assert.equal(s.needsConfirmation, 1);
  assert.equal(s.conflicts, 1);
  // One clustered slice out of two non-session slices is PARTIAL separation —
  // rendering it as "separated" would hide the slice that fell back (4.3).
  assert.equal(s.separation, "partial");
  assert.equal(s.separated, false);
});

test("4.3 a capture whose separation stopped mid-way reports partial, not full", () => {
  // The first two slices were separated; the lane then returned plain text.
  const rows = deriveAttributions({
    chunks: [slice(0, 0, 30_000), slice(1, 30_000, 30_000), slice(2, 60_000, 30_000)],
    diarization: [{ speaker: "A", start: 0, end: 30 }],
  });
  const s = attributionSummary(rows);
  assert.equal(s.separation, "partial");
  assert.equal(s.separated, false);
  // The separated part keeps its cluster; the rest says it was not separated.
  assert.equal(rows[0].cluster, "speaker_1");
  assert.equal(rows[1].cluster, CLUSTER_ANONYMOUS);
  assert.equal(rows[1].basis, BASIS.anonymousNoDiarization);
  assert.equal(rows[2].basis, BASIS.anonymousNoDiarization);
});

test("7.2 the same three-speaker sample derives the same attribution three times", () => {
  // A fixed fixture, run three times: the ladder must be deterministic, because
  // a human will later click on these cluster names.
  const chunks = [slice(0, 0, 30_000), slice(1, 30_000, 30_000), slice(2, 60_000, 30_000), slice(3, 90_000, 30_000)];
  const diarization = [
    { speaker: "B", start: 0, end: 30 },
    { speaker: "A", start: 30, end: 60 },
    { speaker: "C", start: 60, end: 90 },
    { speaker: "A", start: 90, end: 120 },
  ];
  const runs = [0, 1, 2].map(() => deriveAttributions({ chunks, diarization }));
  const shape = (rows) => rows.map((r) => `${r.cluster}@${r.startMs}:${r.certainty}:${r.member}`);
  assert.deepEqual(shape(runs[0]), shape(runs[1]));
  assert.deepEqual(shape(runs[1]), shape(runs[2]));
  // And the numbering follows first appearance in TIME: B spoke first.
  assert.deepEqual(
    runs[0].map((r) => r.cluster),
    ["speaker_1", "speaker_2", "speaker_3", "speaker_2"],
  );
});

test("an unseparated capture reports separated:false — the honest default", () => {
  const rows = deriveAttributions({ chunks: [slice(0, 0, 30_000)] });
  assert.equal(attributionSummary(rows).separated, false);
});
