// Team a2a dispatch (openspec: add-team-as-a2a-agent, 3.4 + 1.1/1.2 on this seam).
//
// The door this dispatcher unlocks is the product's headline promise — another
// owner's team can CALL yours. The three things that must hold, each with a
// wrong version that looks fine:
//
//   identity     — the answer comes from the reception post, and the row that
//                  records the call lands on THAT post. An attribution that
//                  falls back to a preset scan writes the row on the wrong post
//                  (or on none) and the cockpit shows a call nobody made.
//   depth        — outbound is inbound + 1, and the bound refuses BEFORE the
//                  request exists. A hardcoded 1 resets every chain to the top
//                  and the cap can never trip.
//   no fake ok   — a reception that cannot answer (persona, missing target)
//                  fails BY NAME and starts no turn. An "ok" with empty text
//                  would bill the caller's quota for nothing.
//
//   node --test scripts/test-team-dispatch.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTeamDispatch } from "../server/team-dispatch.js";
import { createFleetDatabase } from "../server/routes/fleets-db.js";

const FLEET = "f_dispatch";
const RECEPTION = "post-reception";
const PERSONA = "post-persona";

/** A fleet with one a2a reception post and one persona post beside it. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-dispatch-"));
  const fleetDb = createFleetDatabase({ file: path.join(dir, "f.db") });
  fleetDb.createFleet({ id: FLEET, name: "被调的队", ownerEmail: "owner@t" });
  fleetDb.createMember({ id: RECEPTION, fleetId: FLEET, title: "接待岗", targetKind: "a2a", targetId: "registry-agent-1", parentId: null, kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: PERSONA, fleetId: FLEET, title: "本地岗", targetKind: "persona", targetId: "preset-9", parentId: null, kpiSlots: [], cadence: null });
  const fleet = fleetDb.getFleet(FLEET);
  const members = fleetDb.listMembers(FLEET);
  return {
    fleetDb,
    dir,
    args: (extra = {}) => ({
      fleet,
      members,
      reception: members.find((m) => m.id === RECEPTION),
      text: "请帮我核对这份清单",
      caller: { subject: "caller@other" },
      callId: "call_1",
      depth: 0,
      ...extra,
    }),
  };
}

function entryFor(id) {
  return id === "registry-agent-1" ? { id, mode: "a2a", url: "http://agent.test/a2a" } : null;
}

/** A turn executor that records calls and answers with fixed text. */
function recorder({ answer = "（答复）收到", fail = null } = {}) {
  const calls = [];
  const runTurn = async (url, text, opts) => {
    calls.push({ url, text, opts });
    if (fail) throw fail;
    opts.onDelta?.(answer);
    return { text: answer };
  };
  return { calls, runTurn };
}

const rows = (fleetDb) => fleetDb.db.prepare("SELECT * FROM member_turn_events ORDER BY id").all();

test("3.4 the reception's answer comes back and ONE existing turn row records it", async () => {
  const { fleetDb, dir, args } = fixture();
  const { calls, runTurn } = recorder({ answer: "清单对得上" });
  const dispatch = createTeamDispatch({
    ownerEmail: "owner@t",
    getEntry: entryFor,
    runTurn,
    fleetDb,
    log: { warn() {} },
  });

  const out = await dispatch(args());
  assert.equal(out.text, "清单对得上", "the caller gets the reception's text");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://agent.test/a2a", "the published a2a target's url");
  assert.equal(calls[0].text, "请帮我核对这份清单", "the caller's words verbatim, no template");

  const all = rows(fleetDb);
  assert.equal(all.length, 1, "exactly one row — no second bookkeeping table");
  const row = all[0];
  assert.equal(row.member_id, RECEPTION, "attributed to the reception post, not a preset scan hit");
  assert.equal(row.fleet_id, FLEET);
  assert.equal(row.source, "delegation", "a team call IS a delegated turn");
  assert.equal(row.status, "ok");
  assert.equal(row.depth, 1, "outbound depth = inbound (0) + 1");
  fleetDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("1.2 the inbound depth reaches the remote call as inbound + 1, on the row too", async () => {
  const { fleetDb, dir, args } = fixture();
  const { calls, runTurn } = recorder();
  const dispatch = createTeamDispatch({ ownerEmail: "owner@t", getEntry: entryFor, runTurn, fleetDb, log: { warn() {} } });

  await dispatch(args({ depth: 1 }));
  assert.equal(calls[0].opts.depth, 2, "the header the client will send");
  assert.equal(rows(fleetDb)[0].depth, 2, "and the row agrees — one derivation, not two");
  fleetDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("2.x a reception that is not an a2a post fails by name and starts no turn", async () => {
  const { fleetDb, dir, args } = fixture();
  const { calls, runTurn } = recorder();
  const dispatch = createTeamDispatch({ ownerEmail: "owner@t", getEntry: entryFor, runTurn, fleetDb, log: { warn() {} } });
  const members = args().members;

  await assert.rejects(
    () => dispatch(args({ reception: members.find((m) => m.id === PERSONA) })),
    (err) => err.code === "reception_not_remote",
    "a persona reception is a named refusal, not an empty answer",
  );
  assert.equal(calls.length, 0, "no remote turn — nothing to bill for");
  assert.equal(rows(fleetDb).length, 0, "and no row pretending it ran");
  fleetDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a reception whose a2a target left the catalog is refused by name", async () => {
  const { fleetDb, dir, args } = fixture();
  const { calls, runTurn } = recorder();
  const dispatch = createTeamDispatch({ ownerEmail: "owner@t", getEntry: () => null, runTurn, fleetDb, log: { warn() {} } });

  await assert.rejects(() => dispatch(args()), (err) => err.code === "reception_unreachable");
  assert.equal(calls.length, 0);
  fleetDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("1.2 a chain that would exceed the bound is refused before the request exists", async () => {
  const { fleetDb, dir, args } = fixture();
  const { calls, runTurn } = recorder();
  const dispatch = createTeamDispatch({ ownerEmail: "owner@t", getEntry: entryFor, runTurn, fleetDb, log: { warn() {} } });

  // bound is 3; inbound 2 would make outbound 3 — one hop too far.
  await assert.rejects(() => dispatch(args({ depth: 2 })), (err) => err.code === "depth_bound");
  assert.equal(calls.length, 0, "the over-bound call never left the process");
  fleetDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a failed remote turn is recorded as failed with its error, and still throws", async () => {
  const { fleetDb, dir, args } = fixture();
  const err = new Error("upstream 502");
  err.code = -32012;
  const { runTurn } = recorder({ fail: err });
  const dispatch = createTeamDispatch({ ownerEmail: "owner@t", getEntry: entryFor, runTurn, fleetDb, log: { warn() {} } });

  await assert.rejects(() => dispatch(args()), /upstream 502/);
  const all = rows(fleetDb);
  assert.equal(all.length, 1, "the failure is visible in the ledger, not only in the caller's console");
  assert.equal(all[0].status, "failed");
  assert.match(String(all[0].error), /upstream 502/);
  fleetDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the caller's own credentials are not borrowed: no token means a named failure", async () => {
  const { fleetDb, dir, args } = fixture();
  // Only `calls` is taken from the recorder: this test supplies its own
  // executor below, so the recorder's would be shadowed (and Biome rightly
  // calls a destructured-but-unused binding a bug).
  const { calls } = recorder();
  const dispatch = createTeamDispatch({
    ownerEmail: "owner@t",
    // A real runA2aTurn refuses when the deployment has no agent credential;
    // this pins that the dispatcher passes the resolved pair through instead of
    // inventing one.
    runTurn: async (url, text, opts) => {
      calls.push({ url, text, opts });
      if (!opts.gatewayToken && !opts.agentToken) throw new Error("no registry service credential configured");
      return { text: "ok" };
    },
    getEntry: entryFor,
    fleetDb,
    log: { warn() {} },
  });
  const saved = { ...process.env };
  delete process.env.AGENT_SERVING_REGISTRY_TOKEN;
  delete process.env.MARKET_REGISTRY_TOKEN;
  delete process.env.AGENT_SERVING_BACKEND_TOKEN;
  try {
    await assert.rejects(() => dispatch(args()), /credential/);
    assert.equal(calls.length, 1, "it tried, with whatever the deployment has (nothing)");
  } finally {
    process.env = saved;
    fleetDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
