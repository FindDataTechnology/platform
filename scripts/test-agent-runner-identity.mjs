#!/usr/bin/env node
// ── 身份规则：三处实现跑同一份夹具 ─────────────────────────────────────────
//
// retire-wanxing-twin-face 4.1 / 4.2。公开 agent 身份（slugFor）是跨服务契约：
// 萬星门面用它定路由、facet 用它连接部署簿记、runner 用它上报机群事件。三处各
// 有一份实现，任何一处"顺手整理一下"都会让另两处对不上，而且症状是静默的（条
// 目消失或挂错出处，不是报错）。
//
// 判据只有一份：`../fd-wanxing/contracts/agent-identity.fixture.json` 的 12 条
// cases。本测试让每个实现都跑全量，再互相校验——**若两个实现都错成同一个样
// 子，夹具那条仍然红**，这正是"多处复制要一起改"的解药。
//
//   node --test scripts/test-agent-runner-identity.mjs
//
// 夹具在兄弟仓（萬星已独立）；本仓测试跑在有兄弟仓的工作区里。找不到就明确
// 失败并指名路径，绝不 skip —— skip 会让这条判据在 CI 里静默消失。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

// The fixture is VENDORED (facet/contract/, byte-identical copy) so this test
// runs when paas is checked out alone — a cross-repo file read would silently
// disappear from any CI that lacks the sibling. The sibling copies are still
// consulted when present: a workspace holding a stale vendor is exactly the
// drift this change exists to catch. Cross-repo byte equality is enforced by
// finddata's scripts/check_wanxing_contract_drift.py.
const VENDORED = path.join(ROOT, "facet", "contract", "agent-identity.fixture.json");
const SIBLINGS = [
  process.env.WANXING_CONTRACTS_DIR,
  path.join(ROOT, "..", "fd-wanxing", "contracts"),
  path.join(ROOT, "..", "..", "finddata", "fd-wanxing", "contracts"),
].filter(Boolean);

assert.ok(existsSync(VENDORED), `vendored fixture missing: ${VENDORED}`);
const fixtureText = readFileSync(VENDORED, "utf8");
const fixture = JSON.parse(fixtureText);

// If a sibling owner copy is reachable, it must be byte-identical to the vendor.
const sibling = SIBLINGS.find((d) => existsSync(path.join(d, "agent-identity.fixture.json")));
if (sibling) {
  const ownerText = readFileSync(path.join(sibling, "agent-identity.fixture.json"), "utf8");
  assert.equal(fixtureText, ownerText,
    `the vendored fixture is stale relative to ${sibling} — re-copy the owner file over facet/contract/`);
}

const facadeJudge = (await import("../facet/supply-catalog.js")).slugFor;
const runnerJudge = (await import("../agent-runner/fleet.js")).slugFor;

test("4.1 the fixture declares a revision and a usable set of cases", () => {
  assert.match(fixture["x-contract-rev"], /^\d+$/);
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length >= 10);
  for (const c of fixture.cases) {
    assert.equal(typeof c.input, "string", `case needs a string input: ${JSON.stringify(c)}`);
    assert.equal(typeof c.expect, "string", `case needs a string expect: ${JSON.stringify(c)}`);
  }
});

test("4.1 facet/supply-catalog.js matches every fixture case", () => {
  const failures = [];
  for (const c of fixture.cases) {
    const actual = facadeJudge(c.input);
    if (actual !== c.expect) failures.push(`input ${JSON.stringify(c.input)}\n    expect ${JSON.stringify(c.expect)}\n    actual ${JSON.stringify(actual)}`);
  }
  assert.deepEqual(failures, [], `facet slugFor diverged from the fixture:\n  ${failures.join("\n  ")}`);
});

test("4.1 agent-runner/fleet.js matches every fixture case", () => {
  const failures = [];
  for (const c of fixture.cases) {
    const actual = runnerJudge(c.input);
    if (actual !== c.expect) failures.push(`input ${JSON.stringify(c.input)}\n    expect ${JSON.stringify(c.expect)}\n    actual ${JSON.stringify(actual)}`);
  }
  assert.deepEqual(failures, [], `runner slugFor diverged from the fixture:\n  ${failures.join("\n  ")}`);
});

test("4.1 the two in-repo copies agree with each other on every case", () => {
  // Redundant with the two tests above ONLY while the fixture is complete. It
  // stays because the failure mode we care about is "one copy was tidied up":
  // this test names the disagreement directly instead of leaving it to be read
  // off two expect-mismatch dumps.
  const diffs = [];
  for (const c of fixture.cases) {
    const a = facadeJudge(c.input);
    const b = runnerJudge(c.input);
    if (a !== b) diffs.push(`input ${JSON.stringify(c.input)}: facet=${JSON.stringify(a)} runner=${JSON.stringify(b)}`);
  }
  assert.deepEqual(diffs, [], `the two slugFor copies disagree:\n  ${diffs.join("\n  ")}`);
});

test("4.2 both sites name the fixture as their pin (not a paraphrase of it)", () => {
  for (const rel of ["facet/supply-catalog.js", "agent-runner/fleet.js"]) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(src.includes("agent-identity.fixture.json"), `${rel} must name the fixture it is pinned by`);
    // A historical mention in prose is fine; importing the retired twin is not.
    assert.ok(!/from\s+["'][^"']*gateway\/wanxing/.test(src), `${rel} must not import the retired twin`);
  }
});

// ── 第三处副本：前端（.tsx）──────────────────────────────────────────────────
//
// `web/src/components/packs/PackDetailDialog.tsx` 里还有一份 `wanxingSlugFor`，
// 用来拼控制台/对话页 URL。它跑在浏览器里，不能 import 服务端模块，所以必然是抄的。
// 抄的那份没法在这个仓里跑 vitest（web 是独立 package，本工作树没有 web/node_modules），
// 于是判据退一步但仍然是判据：**三处的替换序列逐字符相同**。改任一处（哪怕只是把
// `+` 改成 `*`）都会红——这正是"多处复制要一起改"要防的那种改动。

function replacementChain(src, name) {
  // 抓 `name = ... => ...` 或 `name(...) { return ... }` 之后的整条表达式，
  // 只取 .replace(/re/, "to") 序列。
  const at = src.indexOf(name);
  assert.ok(at >= 0, `definition not found: ${name}`);
  const tail = src.slice(at, at + 400);
  const chain = [...tail.matchAll(/\.replace\(\s*\/((?:\\.|[^/\n])+)\/([gimsuy]*)\s*,\s*"([^"]*)"\s*\)/g)]
    .map((m) => [m[1], m[2], m[3]]);
  assert.ok(chain.length >= 2, `expected at least two .replace() steps in ${name}, saw ${chain.length}`);
  // `.toLowerCase()` is part of the rule, not decoration: without it an agentPath
  // that carries uppercase (the registry issues them) resolves to a DIFFERENT
  // slug. Comparing only the .replace() chain would call that "identical" — the
  // first version of this test did exactly that and stayed green when the suffix
  // was removed. (Caught by trying to make it red.)
  const lowered = /\.toLowerCase\(\)/.test(tail);
  return JSON.stringify({ chain, lowered });
}

test("identity: the frontend copy carries the SAME replacement chain (no third rule)", () => {
  const sites = {
    "facet/supply-catalog.js": replacementChain(readFileSync(path.join(ROOT, "facet", "supply-catalog.js"), "utf8"), "export function slugFor"),
    "agent-runner/fleet.js": replacementChain(readFileSync(path.join(ROOT, "agent-runner", "fleet.js"), "utf8"), "export const slugFor"),
    "web/src/components/packs/PackDetailDialog.tsx": replacementChain(
      readFileSync(path.join(ROOT, "web", "src", "components", "packs", "PackDetailDialog.tsx"), "utf8"), "const wanxingSlugFor"),
    // Diagnostic probes carry their own copy too. Both omitted `.toLowerCase()`
    // until 2026-11-13 — which means an agentPath with any uppercase character
    // (the registry issues them: /packs/egaYyOaZVTf0FWlLvaGAQA/…) resolved to a
    // DIFFERENT slug than the serving plane's, so a "probe says healthy/absent"
    // reading could be about an agent nobody serves. A lying diagnostic is worse
    // than no diagnostic; hence they are held to the same chain.
  };
  // 上面三处是**必在**的副本（服务端、runner、前端），判据不会变空。
  //
  // 探针另有两份副本，但它们按 `scripts/probe-*.mjs` 被公开快照整体排除
  // （`make-public-snapshot.mjs` 的 EXCLUDE_GLOBS：探针打的是公司部署，不进开源
  // drop）。所以这里只约束**在场的**副本：缺席不是通过，是"在此树不可判"。
  // 2026-11-14 实证——这两行原是无条件 readFileSync，镜像仓 CI 的 unit 分片因此
  // 连续 5 轮 `ENOENT scripts/probe-deployment-secrets.mjs` 红，而出片不依赖 CI，
  // 于是红了两小时没人看见（本地全绿，因为本地有这两个文件）。
  const OPTIONAL_PROBES = [
    ["scripts/probe-deployment-secrets.mjs", "const agentKeyNow"],
    ["scripts/probe-harness-materializer-live.mjs", "function agentKeyFor"],
  ];
  for (const [rel, name] of OPTIONAL_PROBES) {
    const full = path.join(ROOT, rel);
    if (!existsSync(full)) continue;
    sites[rel] = replacementChain(readFileSync(full, "utf8"), name);
  }
  assert.ok(Object.keys(sites).length >= 3, "判据不接受空集：三处必在副本必须全部读到");
  const uniq = new Set(Object.values(sites));
  assert.equal(uniq.size, 1,
    `the copies diverge:\n${Object.entries(sites).map(([f, c]) => `  ${f}: ${c}`).join("\n")}`);
  // And the shared chain is the one the fixture pins, character for character.
  assert.equal([...uniq][0],
    JSON.stringify({ chain: [["^\\/+", "", ""], ["[^A-Za-z0-9._-]+", "g", "-"]], lowered: true }),
    "the replacement chain (or its .toLowerCase()) no longer matches what the fixture describes");
});
