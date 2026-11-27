// check-bench-fleet-lane.mjs 的判据本体（纯函数）钉死。
//
// 这条闸存在的理由只有一个：**零产出不会红任何东西**。2026-11-14 与 11-15 两次实测，
// fleet_1793422472811_i28xac 的 owner 在承载它的 cell 里 wire-customer 一直 stale=1
// （2026-11-10T06:44Z 起），于是 盘账员取不到数 → 建模师空批 → 提案员零提交，而提案面、
// 工单面、绑定闸、机器面全部绿。判据落在「持有 bench 凭据的那支舰队，它 owner 在自己 cell
// 里的凭据行是否还活着」。
import assert from "node:assert/strict";
import { test } from "node:test";
import { judge, normalizeLaneInput, verdictOf } from "../scripts/check-bench-fleet-lane.mjs";

const j = (input, opts) => judge(normalizeLaneInput(input), opts);

const base = () => ({
  fleets: [
    { id: "fleet_A", ownerEmail: "O@x.y", cell: "cell1" },
    { id: "fleet_B", ownerEmail: "o@x.y", cell: "cell2" },
  ],
  credentials: [
    { cell: "cell1", email: "o@x.y", line: "lex", stale: 0 },
    { cell: "cell1", email: "o@x.y", line: "wire-customer", stale: 1, updatedAt: "2026-11-10T06:44:08.346Z" },
  ],
  benchHolders: ["fleet_A"],
});

test("the live shape: a stale lane row is a hit and names the line + timestamp", () => {
  const r = j(base());
  assert.equal(verdictOf(r), "fail");
  const hit = r.findings.find((f) => f.code === "R2");
  assert.ok(hit, "R2 must fire");
  assert.match(hit.detail, /wire-customer/);
  assert.match(hit.detail, /2026-11-10T06:44/);
  assert.ok(r.notes.some((n) => /重授权/.test(n)), "the note must name the human action, not just the symptom");
});

test("owner email is matched case-insensitively", () => {
  const input = base();
  input.fleets[0].ownerEmail = "O@X.Y";
  assert.equal(j(input).findings.filter((f) => f.code === "R2").length, 1);
});

test("a fleet whose own cell has no rows is a hit (R1), not a pass", () => {
  const input = base();
  input.credentials = [{ cell: "cell2", email: "o@x.y", line: "lex", stale: 0 }];
  const r = j(input);
  assert.equal(verdictOf(r), "fail");
  assert.ok(r.findings.some((f) => f.code === "R1"));
});

test("rows in another cell do not make this fleet's lane look healthy or sick", () => {
  const input = base();
  input.credentials = [
    { cell: "cell1", email: "o@x.y", line: "lex", stale: 0 },
    { cell: "cell2", email: "o@x.y", line: "wire-customer", stale: 1 },
  ];
  assert.equal(verdictOf(j(input)), "ok", "cell2's stale row must not red a cell1 fleet");
});

test("only holders are judged; a non-holder's stale row is not my finding", () => {
  const input = base();
  input.benchHolders = ["fleet_B"];
  input.credentials = [
    { cell: "cell1", email: "o@x.y", line: "wire-customer", stale: 1 },
    { cell: "cell2", email: "o@x.y", line: "lex", stale: 0 },
  ];
  assert.equal(verdictOf(j(input)), "ok");
});

test("a holder missing from the roster is undecidable for that fleet, and reported", () => {
  const input = base();
  input.benchHolders = ["fleet_ghost"];
  const r = j(input);
  assert.ok(r.findings.some((f) => f.code === "R0"));
});

test("no holders at all ⇒ undetermined, never 'nothing to check so green'", () => {
  const input = base();
  input.benchHolders = null;
  const r = j(input);
  assert.equal(verdictOf(r), "undetermined");
});

test("--bench-holders overrides the payload (the caller decides the population)", () => {
  const input = base();
  input.benchHolders = ["fleet_A"];
  // cell2 gets a FRESH row so fleet_B is genuinely healthy; fleet_A's stale
  // cell1 row must then be invisible — if it leaked in, this would go red.
  input.credentials = [
    { cell: "cell1", email: "o@x.y", line: "wire-customer", stale: 1 },
    { cell: "cell2", email: "o@x.y", line: "lex", stale: 0 },
  ];
  const r = j(input, { holders: ["fleet_B"] });
  assert.equal(verdictOf(r), "ok");
  assert.equal(r.counts.population, 1);
});
