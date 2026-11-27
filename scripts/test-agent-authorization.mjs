#!/usr/bin/env node
// ── Agent authorization is policy, not constants ────────────────────────────
//
// openspec: add-personal-staff-fleet 3b.2 (auditor reads the deputy queue) and
// 3c.1 (delegate sync vs async). Both used to be hard-coded, and both had a
// defensible opposite reading — so they are configuration with a documented
// default, and this file pins BOTH the default and the override.
//
// Run: node --test scripts/test-agent-authorization.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  auditorMayReadDeputyQueue,
  delegateMode,
  summonAutoAccept,
  authorizationPolicy,
  AUTHORIZATION_POLICY_KEYS,
} from "../lib/agent-authorization.js";

/** A stand-in for the deployment_config reader. */
const withConfig = (entries) => ({
  getDeploymentConfig: (k) => (k in entries ? entries[k] : null),
});

const ENV = {
  AGENT_AUDITOR_READ_DEPUTY_QUEUE: process.env.AGENT_AUDITOR_READ_DEPUTY_QUEUE,
  AGENT_DELEGATE_MODE: process.env.AGENT_DELEGATE_MODE,
};

function resetEnv() {
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test.afterEach(() => resetEnv());

// ── Defaults: what an unconfigured deployment gets ──────────────────────────

test("default: an auditor MAY read the deputy queue (reading is not acting)", () => {
  delete process.env.AGENT_AUDITOR_READ_DEPUTY_QUEUE;
  assert.equal(auditorMayReadDeputyQueue(), true,
    "widening is the default; the opposite is opt-in");
});

test("default: delegation is ASYNC (sync is the shape that deadlocks)", () => {
  delete process.env.AGENT_DELEGATE_MODE;
  assert.equal(delegateMode(), "async");
});

// ── Overrides through BOTH layers ──────────────────────────────────────────

test("the stored deployment_config value wins over the env seed", () => {
  process.env.AGENT_AUDITOR_READ_DEPUTY_QUEUE = "1";
  assert.equal(auditorMayReadDeputyQueue(withConfig({ [AUTHORIZATION_POLICY_KEYS.auditorMayReadDeputyQueue]: "0" })), false,
    "config overrides env");
});

test("env works when nothing is stored", () => {
  process.env.AGENT_AUDITOR_READ_DEPUTY_QUEUE = "0";
  assert.equal(auditorMayReadDeputyQueue(withConfig({})), false);
});

test("every documented falsy spelling switches the read lane OFF", () => {
  for (const off of ["0", "false", "OFF", "no"]) {
    assert.equal(auditorMayReadDeputyQueue(withConfig({ [AUTHORIZATION_POLICY_KEYS.auditorMayReadDeputyQueue]: off })), false, off);
  }
});

test("an unrecognised delegate mode falls back to async, never to sync", () => {
  for (const odd of ["sometimes", "true", "1", ""]) {
    assert.equal(delegateMode(withConfig({ [AUTHORIZATION_POLICY_KEYS.delegateMode]: odd })), "async", JSON.stringify(odd));
  }
  assert.equal(delegateMode(withConfig({ [AUTHORIZATION_POLICY_KEYS.delegateMode]: "sync" })), "sync");
});

// ── The status surface sees the same answers ───────────────────────────────

test("the reported policy equals what the callers would get", () => {
  const db = withConfig({
    [AUTHORIZATION_POLICY_KEYS.auditorMayReadDeputyQueue]: "0",
    [AUTHORIZATION_POLICY_KEYS.delegateMode]: "sync",
  });
  assert.deepEqual(authorizationPolicy(db), {
    auditorMayReadDeputyQueue: auditorMayReadDeputyQueue(db),
    delegateMode: delegateMode(db),
    summonAutoAccept: summonAutoAccept(db),
  });
  assert.deepEqual(authorizationPolicy(db), {
    auditorMayReadDeputyQueue: false,
    delegateMode: "sync",
    summonAutoAccept: true,
  });
});

test("a broken config reader degrades to the defaults instead of throwing", () => {
  const broken = { getDeploymentConfig: () => { throw new Error("db down"); } };
  assert.equal(auditorMayReadDeputyQueue(broken), true);
  assert.equal(delegateMode(broken), "async");
  assert.equal(summonAutoAccept(broken), true);
});

// ── summonAutoAccept (2026-11-24) ──────────────────────────────────────────
//
// The owner pressing "召唤" is the approval for a LOCAL post; a market seat's
// deployer is an outside party, so THAT handshake stays. Default on, and off is
// a real switch (not a comment).

test("summon auto-accept defaults on and honours both layers", () => {
  assert.equal(summonAutoAccept(), true, "pressing 召唤 already is the approval");
  assert.equal(summonAutoAccept(withConfig({ [AUTHORIZATION_POLICY_KEYS.summonAutoAccept]: "0" })), false);
  assert.equal(summonAutoAccept(withConfig({ [AUTHORIZATION_POLICY_KEYS.summonAutoAccept]: "false" })), false);
  assert.equal(summonAutoAccept(withConfig({ [AUTHORIZATION_POLICY_KEYS.summonAutoAccept]: "on" })), true);
});
