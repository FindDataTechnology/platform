// Tests for the CaaS envelope authority (openspec: add-caas-delivery-contract).
// Run: node --test lib/caas-envelope.test.js

import test from "node:test";
import assert from "node:assert/strict";

import {
  FORMS,
  VERSION,
  canonicalAck,
  ackRank,
  resolveForm,
  capsFor,
  maxAckFor,
  validateEnvelope,
  ackProjection,
  idemKeyFor,
} from "./caas-envelope.js";

test("authority file is versioned and holds the five forms", () => {
  assert.equal(typeof VERSION, "number");
  assert.deepEqual([...FORMS].sort(), ["asset", "chart", "file", "link", "text"]);
});

test("resolveForm picks the sender's first form the recipient can read", () => {
  // A2A seats read text + asset only; chart is first in the envelope but unused.
  assert.equal(resolveForm(["chart", "asset"], capsFor("a2a-slug")), "asset");
  // A room seat can read everything.
  assert.equal(resolveForm(["chart"], capsFor("room-seat")), "chart");
});

test("no intersection returns null rather than a silent fallback", () => {
  assert.equal(resolveForm(["chart"], capsFor("a2a-slug")), null);
  assert.equal(resolveForm(["chart"], capsFor("external-endpoint")), null);
});

test("validateEnvelope names every missing required field", () => {
  const r = validateEnvelope({});
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.sort(), ["ack", "correlation.idem", "forms", "to"]);
});

test("validateEnvelope rejects an unregistered form", () => {
  const r = validateEnvelope({
    to: "seat_1",
    forms: ["chart", "hologram"],
    ack: "delivered",
    correlation: { idem: "k1" },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /hologram/);
});

test("validateEnvelope accepts a complete envelope", () => {
  const r = validateEnvelope({
    to: { seatId: "seat_1" },
    forms: ["chart", "link"],
    ack: "read",
    correlation: { idem: "fleet:r1:2026-11-18" },
  });
  assert.equal(r.ok, true);
});

test("ack aliases collapse; read/acted are consumed", () => {
  assert.equal(canonicalAck("read"), "consumed");
  assert.equal(canonicalAck("acted"), "consumed");
  assert.equal(canonicalAck("bogus"), null);
  assert.ok(ackRank("consumed") > ackRank("delivered"));
  assert.ok(ackRank("delivered") > ackRank("none"));
});

test("ackProjection marks downgrade when declared strength not proven", () => {
  // Declared read (=consumed) but only delivered: downgraded, NOT satisfied.
  const p = ackProjection({ ackDeclared: "read", ackActual: "delivered" });
  assert.equal(p.state, "delivered");
  assert.equal(p.downgraded, true);
});

test("ackProjection does not mark downgrade when strength is met", () => {
  const p = ackProjection({ ackDeclared: "delivered", ackActual: "consumed" });
  assert.equal(p.state, "consumed");
  assert.equal(p.downgraded, false);
});

test("ackProjection distinguishes retryable failures", () => {
  const unreachable = ackProjection({ failed: true, retryable: true, reason: "timeout" });
  assert.equal(unreachable.state, "failed");
  assert.equal(unreachable.retryable, true);
  const badEnvelope = ackProjection({ failed: true, retryable: false, reason: "bad envelope" });
  assert.equal(badEnvelope.retryable, false);
});

test("recipient capability ceilings are known for every kind", () => {
  for (const kind of ["room-seat", "a2a-slug", "platform-identity", "external-endpoint"]) {
    assert.ok(capsFor(kind).length > 0, `${kind} has caps`);
    assert.ok(canonicalAck(maxAckFor(kind)), `${kind} has a max ack`);
  }
  assert.deepEqual(capsFor("nope"), []);
  assert.equal(maxAckFor("nope"), null);
});

test("idemKeyFor is stable for identical input and differs otherwise", () => {
  const a = idemKeyFor({ to: "seat_1", form: "chart", body: { x: 1 } });
  const b = idemKeyFor({ to: "seat_1", form: "chart", body: { x: 1 } });
  const c = idemKeyFor({ to: "seat_1", form: "chart", body: { x: 2 } });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
