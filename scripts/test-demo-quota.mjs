// Unit contract for the demo quota signal (openspec: add-mp-demo-quota-end):
// the budget arithmetic (per-cell vs everyone shapes, remaining(), the null
// for non-applicable identities) and the coded limit replies. The store's
// routing of the codes is exercised live by the sandbox probe (tasks 4.2).

import test from "node:test";
import assert from "node:assert/strict";
import { createDemoBudget, DEMO_LIMIT_REPLY, SANDBOX_LIMIT_REPLY } from "../server/ws.js";

const demoUser = { groups: ["demo"] };
const accountUser = { groups: ["user"] };

test("per-cell budget: demo identities draw down, others draw freely", () => {
  const budget = createDemoBudget(2);
  assert.equal(budget.take(demoUser), true);
  assert.equal(budget.take(demoUser), true);
  assert.equal(budget.take(demoUser), false, "cap reached for the demo identity");
  assert.equal(budget.take(accountUser), true, "non-demo identities are never capped");
});

test("remaining(): counts down for the budgeted, null for everyone else", () => {
  const budget = createDemoBudget(3);
  assert.equal(budget.remaining(demoUser), 3);
  assert.equal(budget.remaining(accountUser), null, "no budget applies to a bound account");
  budget.take(demoUser);
  assert.equal(budget.remaining(demoUser), 2);
  budget.take(demoUser);
  budget.take(demoUser);
  assert.equal(budget.remaining(demoUser), 0, "clamped at zero, never negative");
});

test("sandbox (everyone) budget: every connection counts, remaining ignores identity", () => {
  const budget = createDemoBudget(2, { everyone: true });
  assert.equal(budget.remaining(null), 2);
  assert.equal(budget.take(null), true);
  assert.equal(budget.remaining(null), 1);
  assert.equal(budget.take(null), true);
  assert.equal(budget.take(null), false);
  assert.equal(budget.remaining(null), 0);
});

test("limit replies carry the machine-readable quota shape", () => {
  assert.equal(DEMO_LIMIT_REPLY.type, "error");
  assert.equal(DEMO_LIMIT_REPLY.code, "demo_limit");
  assert.ok(DEMO_LIMIT_REPLY.message.includes("绑定"));
  assert.equal(SANDBOX_LIMIT_REPLY.type, "error");
  assert.equal(SANDBOX_LIMIT_REPLY.code, "sandbox_limit");
  assert.ok(SANDBOX_LIMIT_REPLY.message.includes("重连"), "sandbox reply invites reconnect");
});
