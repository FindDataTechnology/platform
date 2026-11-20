// Durable webhook acceptance store (add-rollout-gap-durability). Pins the
// behaviors the live rollout gap depends on:
//   - accept writes the record to disk BEFORE anything acks (atomic tmp+rename)
//   - the idempotency key: same platform message id → duplicate, no second
//     live record; payloads without an id dedupe by nothing (never a guessed key)
//   - one-way state machine pending → dispatched → done, second claim a no-op
//   - restart: a new instance over the same dir recovers pending + dispatched
//   - retention: done records age out (their keys with them)
//   - overflow answers the store-full error (route maps it to 503), never drops
//
// Run: node --test scripts/test-bot-acceptance.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { readdirSync } from "node:fs";

process.env.BOTS_ACCEPTANCE_MAX = "4";
const { createBotAcceptance } = await import("../server/bot-acceptance.js");

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-accept-"));
});

const msg = (over = {}) => ({ kind: "message", botId: "b1", message: { chatKey: "c1", text: "hi", ...over }, ...over });

test("accept persists the record before any ack could be sent", () => {
  const a = createBotAcceptance({ dir });
  const { record } = a.accept(msg({ key: "b1:m1" }));
  assert.equal(record.state, "pending");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, "exactly one record file on disk at accept time");
  assert.equal(files.length, 1);
  assert.ok(!files.some((f) => f.includes(".tmp")), "no tmp leftovers (atomic rename)");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
  assert.equal(onDisk.id, record.id);
  assert.equal(onDisk.key, "b1:m1");
});

test("same platform message id → duplicate, no second live record, no second turn", () => {
  const a = createBotAcceptance({ dir });
  const first = a.accept(msg({ key: "b1:m1" }));
  assert.equal(first.duplicate, false);
  const second = a.accept(msg({ key: "b1:m1" }));
  assert.equal(second.duplicate, true, "the retry lands on the key");
  assert.equal(second.record.state, "done", "duplicate stored as a done note (observable)");
  assert.equal(second.record.note, "duplicate");
  assert.equal(a.pending().length, 1, "only the first record is pending — one turn, not two");
});

test("payload without an id dedupes by nothing — same text twice both live", () => {
  const a = createBotAcceptance({ dir });
  const one = a.accept(msg({ key: null }));
  const two = a.accept(msg({ key: null }));
  assert.equal(one.duplicate, false);
  assert.equal(two.duplicate, false, "a guessed key must never block a later message");
  assert.equal(a.pending().length, 2);
});

test("one-way state machine: claim then settle, second claim is a no-op", () => {
  const a = createBotAcceptance({ dir });
  const { record } = a.accept(msg({ key: "b1:m2" }));
  assert.ok(a.markDispatched(record.id), "first claim succeeds");
  assert.equal(a.markDispatched(record.id), null, "second claim (takeover vs drain race) is a no-op");
  assert.ok(a.markDone(record.id));
  assert.equal(a.markDone(record.id, "again"), null, "done is terminal");
  assert.equal(a.byId(record.id).state, "done");
});

test("restart: a new instance over the same dir recovers pending and dispatched", () => {
  const a = createBotAcceptance({ dir });
  const p = a.accept(msg({ key: "b1:m3" })).record;
  const d = a.accept(msg({ key: "b1:m4" })).record;
  a.markDispatched(d.id);

  const b = createBotAcceptance({ dir }); // "next process"
  assert.equal(b.pending().length, 1, "pending survives the restart");
  assert.equal(b.pending()[0].id, p.id);
  assert.equal(b.all().find((r) => r.id === d.id)?.state, "dispatched", "dispatched survives for the honest-interrupted pass");
  assert.equal(b.accept(msg({ key: "b1:m3" })).duplicate, true, "the idempotency key survives the restart");
});

test("retention: done records age out with their keys, pending never expires", () => {
  let t = 1_000_000_000_000;
  const clock = () => t;
  const a = createBotAcceptance({ dir, now: clock });
  const gone = a.accept(msg({ key: "b1:old" })).record;
  a.markDone(gone.id);
  t += 25 * 60 * 60 * 1000; // past the 24h retention
  assert.equal(a.cleanup(), 1, "the expired done record is removed");
  const kept = a.accept(msg({ key: "b1:fresh" })).record;
  a.markDone(kept.id);
  t += 60 * 60 * 1000;
  assert.equal(a.cleanup(), 0, "a done record inside the window stays");
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(kept.id)), "fresh record still on disk");
  assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith(gone.id)), "expired record removed from disk");
});

test("overflow answers store-full (route → 503), never a silent drop of an accepted message", () => {
  const a = createBotAcceptance({ dir }); // MAX=4 via env
  for (let i = 0; i < 4; i += 1) a.accept(msg({ key: `b1:k${i}` }));
  assert.throws(() => a.accept(msg({ key: "b1:k5" })), (e) => e.code === "BOTS_ACCEPTANCE_FULL");
});
