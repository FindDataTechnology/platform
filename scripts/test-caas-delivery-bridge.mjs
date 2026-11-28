#!/usr/bin/env node
// ── CaaS delivery on the fleet bridge (openspec: add-caas-delivery-contract) ─
//
// Pins the delivery contract as it lands on the first real channel:
//   - a report row carries an envelope-derived form + a receipt: `delivered`
//     with `downgraded=true` because the bridge asked for `read` but can only
//     prove arrival — claiming otherwise is the fake-green this exists to stop
//   - a report WITHOUT chart data degrades to text (never an empty chart, which
//     reads as "no data" when the truth is "no chart spec")
//   - the seat read position advances on pull, is monotonic (a replayed older
//     window cannot rewind it), and turns `delivered` into `consumed` in the
//     store's reconciler — without any page rendering
//   - the idempotency key is stable per (fleet, at, title), so a replayed tick
//     computes the same key
//
//   node --test scripts/test-caas-delivery-bridge.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caas-bridge-"));
process.env.PLATFORM_DATA_DIR = tmp;

const { createZhiyuStore } = await import("../gateway/zhiyu/store.js");
const { registerFleetRoomBridge, reportEnvelope, reportReceipt } = await import(
  "../gateway/fleet-room-bridge.js"
);
const { FORMS, capsFor, resolveForm } = await import("../lib/caas-envelope.js");

const OWNER = "owner@example.com";
const store = createZhiyuStore({ file: path.join(tmp, "zhiyu.db") });
const room = store.roomCreate({ title: "投递验收房", ownerEmail: OWNER });

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fleetShape = (id, name, over = {}) => ({
  id,
  name,
  counts: { onDuty: 1, paused: 0, missing: 0, vacant: 0, passing: 0, failing: 0, total: 1 },
  openDecisions: { count: 0, top: [] },
  stream: [],
  ...over,
});

function bridgeWith(sampleRef) {
  return registerFleetRoomBridge(express(), {
    store,
    resolveUser: () => ({ email: OWNER, groups: [] }),
    rejectUnauthenticated: (_q, r) => r.status(401).json({}),
    sampleFleets: async () => sampleRef.value,
  });
}

const deliveryRows = () =>
  store
    .messagesAfter(room.id, 0)
    .filter((m) => m.meta?.delivery && m.meta.bridge === "report");

test("report row carries a delivered+downgraded receipt", async () => {
  const sampleRef = {
    value: { v: 1, sampledAt: Date.now(), fleets: [fleetShape("fleet_a", "客服班组")] },
  };
  const b = bridgeWith(sampleRef);
  await b.tick(); // baseline

  // The bridge only flows for rooms it has a subscription row for.
  store.fleetSubAdd({ roomId: room.id, fleetId: "fleet_a", fleetName: "客服班组", ownerEmail: OWNER });
  await b.tick(); // baseline the newly-subscribed fleet

  sampleRef.value = {
    v: 1,
    sampledAt: Date.now(),
    fleets: [
      fleetShape("fleet_a", "客服班组", {
        stream: [{ title: "一线客服", at: 1793000000000, summarySnip: "处理 12 单", metrics: {} }],
      }),
    ],
  };
  await b.tick();

  const [row] = deliveryRows();
  assert.ok(row, "a report delivery row lands");
  const d = row.meta.delivery;
  assert.equal(d.ok, true);
  assert.equal(d.ack_declared, "read");
  assert.equal(d.ack_actual, "delivered", "the bridge can only prove arrival");
  assert.equal(d.downgraded, true, "declared read but proved delivered MUST downgrade");
  assert.ok(FORMS.includes(d.form), `form ${d.form} must be a registered form`);
  assert.ok(d.idem, "the row carries an idempotency key");
  assert.ok(d.to?.seatId, "the envelope names its recipient");

  // Without chart data the form must not be `chart` — an empty chart lies.
  assert.notEqual(d.form, "chart", "no chart spec → no chart form");
});

test("the composition helpers are pure and authority-driven", () => {
  const sub = { roomId: room.id, fleetId: "fleet_a", ownerEmail: OWNER };
  const item = { at: 1793000000000, memberTitle: "一线客服" };
  const a = reportEnvelope({ sub, item, ownerEmail: OWNER });
  const b2 = reportEnvelope({ sub, item, ownerEmail: OWNER });
  assert.equal(a.env.correlation.idem, b2.env.correlation.idem, "idempotency key is content-derived");

  // No chart → text; with chart → chart. Both from caas-forms.json, not code.
  assert.equal(reportReceipt({ env: a.env, chartPresent: false }).form, "text");
  assert.equal(reportReceipt({ env: a.env, chartPresent: true }).form, "chart");

  // A recipient that cannot read charts degrades on its own.
  assert.equal(resolveForm(["chart", "text"], capsFor("a2a-slug")), "text");
});

test("seat read position advances on pull and is monotonic", () => {
  const member = store.memberAdd({ roomId: room.id, kind: "user", ref: OWNER, display: "主人" });
  const rows = store.messagesAfter(room.id, 0);
  const maxSeq = rows[rows.length - 1].seq;

  const advanced = store.seatReadAdvance(room.id, member.id, maxSeq);
  assert.equal(advanced, maxSeq);

  // Replaying an OLDER window must not rewind the position.
  const rewound = store.seatReadAdvance(room.id, member.id, 0);
  assert.equal(rewound, maxSeq, "read position never regresses");

  assert.equal(store.seatReadPosition(room.id, member.id), maxSeq);
});

test("consumed is a server-side fact: reconciler flips the receipt", () => {
  const member = store.memberAdd({ roomId: room.id, kind: "user", ref: "member2@example.com", display: "成员" });
  const deliveries = store.seatConsumedDeliveries(room.id, member.id);
  assert.ok(deliveries.length > 0, "the room has delivery rows to reconcile");

  // Before pulling: everything is unconsumed (position starts at 0).
  assert.ok(deliveries.every((d) => d.consumed === false));

  // Pull everything (that is what GET /messages does server-side).
  const maxSeq = Math.max(...deliveries.map((d) => d.seq));
  store.seatReadAdvance(room.id, member.id, maxSeq);

  const after = store.seatConsumedDeliveries(room.id, member.id);
  assert.ok(after.every((d) => d.consumed === true), "pulling proves consumption");
  assert.ok(after.every((d) => d.idem), "each delivery keeps its idempotency key");
});

test("a tick whose report is unchanged does not deliver twice", async () => {
  const sampleRef = {
    value: {
      v: 1,
      sampledAt: Date.now(),
      fleets: [
        fleetShape("fleet_a", "客服班组", {
          stream: [{ title: "一线客服", at: 1793000000000, summarySnip: "处理 12 单", metrics: {} }],
        }),
      ],
    },
  };
  const b = bridgeWith(sampleRef);
  const before = deliveryRows().length;
  await b.tick();
  await b.tick();
  assert.equal(deliveryRows().length, before, "the watermark holds; no re-delivery");
});
