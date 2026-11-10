#!/usr/bin/env node
// ── Exhausted budget must degrade, not kill the round ───────────────────────
//
// Live 2026-11-10, the owner cell's model_budget table:
//
//   deepseek-v4.1-flash  daily  8,070,816 / 8,000,000   exhausted
//   glm-5.3-flash        daily    109,713 / 8,000,000   1.4%
//   deepseek-flash       daily          0 / 20,000,000  untouched
//
// Every optimizer round failed with
//   budget_exhausted: all candidate models over daily/monthly budget
// while a model with 20 billion tokens of room sat on the same runner — because
// the chain is built from DECLARATIONS (member → fallback → fleet → cell) and
// never consults budget. "No room on the declared chain" must degrade to "use a
// model that has room", not to "do not run".
//
//   node --test scripts/test-budget-fallback.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { pickBudgetFallback } = await import(path.join(here, "../server/fleet-model.js"));

const ROSTER = ["deepseek-v4.1-flash", "glm-5.3-flash", "deepseek-flash"];
const probeFor = (blockedModels) => (m) => ({ allowed: !blockedModels.includes(m) });

const cands = (...models) => models.map((m) => ({ model: m, source: "member" }));

test("1. the live shape: both declared hops exhausted ⇒ the untouched model is chosen", () => {
  const blocked = [{ model: "deepseek-v4.1-flash" }, { model: "glm-5.3-flash" }];
  const pick = pickBudgetFallback({
    candidates: cands("deepseek-v4.1-flash", "glm-5.3-flash"),
    blocked,
    roster: ROSTER,
    probe: probeFor(["deepseek-v4.1-flash", "glm-5.3-flash"]),
  });
  assert.equal(pick, "deepseek-flash");
});

test("2. a declared candidate is never re-offered as the rescue", () => {
  const pick = pickBudgetFallback({
    candidates: cands("a"),
    blocked: [{ model: "a" }],
    roster: ["a"],
    probe: () => ({ allowed: true }), // even if the probe now says ok
  });
  assert.equal(pick, null, "already-tried models never come back");
});

test("3. unknown verdict ⇒ NOT eligible (unknown is not empty)", () => {
  const pick = pickBudgetFallback({
    candidates: cands("a"),
    blocked: [{ model: "a" }],
    roster: ["b"],
    probe: () => null,
  });
  assert.equal(pick, null);
});

test("4. a throwing probe cannot make a model eligible", () => {
  const pick = pickBudgetFallback({
    candidates: cands("a"),
    blocked: [{ model: "a" }],
    roster: ["b", "c"],
    probe: (m) => { if (m === "b") throw new Error("probe down"); return { allowed: true }; },
  });
  assert.equal(pick, "c", "skips the failing probe, keeps scanning");
});

test("5. first eligible in roster order wins (stable across rounds, no flicker)", () => {
  const pick = pickBudgetFallback({
    candidates: cands("a"),
    blocked: [{ model: "a" }],
    roster: ["x", "y", "z"],
    probe: () => ({ allowed: true }),
  });
  assert.equal(pick, "x");
});

test("6. no probe / no roster ⇒ null (degrade-open, no invented model)", () => {
  assert.equal(pickBudgetFallback({ candidates: cands("a"), blocked: [{ model: "a" }] }), null);
  assert.equal(pickBudgetFallback({ candidates: cands("a"), blocked: [{ model: "a" }], roster: null, probe: () => ({ allowed: true }) }), null);
});

test("7. when nothing has room, null — the caller still reports budget_exhausted honestly", () => {
  const pick = pickBudgetFallback({
    candidates: cands("a"),
    blocked: [{ model: "a" }],
    roster: ["b", "c"],
    probe: () => ({ allowed: false, blocked: ["daily"] }),
  });
  assert.equal(pick, null);
});

test("8. candidates accept bare strings as well as { model }", () => {
  const pick = pickBudgetFallback({
    candidates: ["a"],
    blocked: [],
    roster: ["a", "b"],
    probe: () => ({ allowed: true }),
  });
  assert.equal(pick, "b", "a bare-string candidate is still excluded");
});
