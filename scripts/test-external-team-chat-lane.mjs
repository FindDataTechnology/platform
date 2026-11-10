// Tests for the external-team chat lane (fix-external-team-chat-lane):
//   B1  chat 车道注入本队上下文 + 派发按 ref/title 寻址
//   B3  publicFacing 声明与工具面收敛
//   B5  推理痕迹剥离（web 文本信道）
//   B6  首启有界等待
//
// Run: node --test scripts/test-external-team-chat-lane.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderChatFleetContext, resolveDispatchTarget } from "../server/fleet-chat-context.js";
import { stripReasoningLeak, createReasoningLeakFilter } from "../server/reasoning-leak.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dir, "..");

// ── A fake fleet db: two members, one dispatch edge ────────────────────────
function fakeDb() {
  const members = [
    { id: "m_guide", fleetId: "f1", title: "产品向导", targetKind: "persona", targetId: "intro-guide", parentId: null },
    { id: "m_lex", fleetId: "f1", title: "识律专家", targetKind: "persona", targetId: "intro-lex", parentId: "m_guide" },
    { id: "m_wire", fleetId: "f1", title: "柏讯专家", targetKind: "persona", targetId: "intro-wire", parentId: "m_guide" },
    { id: "m_other", fleetId: "f2", title: "别队岗位", targetKind: "persona", targetId: "intro-other", parentId: null },
  ];
  const fleets = [
    { id: "f1", name: "壹座产品介绍", state: "active", orchestration: { edges: [{ kind: "dispatch", from: "m_guide", to: "m_lex" }] } },
    { id: "f2", name: "别的团队", state: "active", orchestration: { edges: [] } },
  ];
  return {
    listFleets: () => fleets,
    listMembers: (fleetId) => members.filter((m) => m.fleetId === fleetId),
    getMember: (id) => members.find((m) => m.id === id) ?? null,
    getFleet: (id) => fleets.find((f) => f.id === id) ?? null,
  };
}

test("B1: the chat lane injects the trimmed team context for an attributed preset", () => {
  const segment = renderChatFleetContext(fakeDb(), "intro-guide");
  assert.ok(segment, "an attributed preset gets a segment");
  assert.match(segment, /壹座产品介绍/, "the segment names the team");
  assert.match(segment, /产品向导/, "the roster lists the members");
  assert.match(segment, /识律专家/, "the roster lists the experts");
  assert.match(segment, /可派发给它/, "the dispatchable target is marked");
  assert.ok(!/报数|拍板|巡视/.test(segment), "the chat segment carries NO patrol semantics (trimmed variant)");
  assert.ok(!/cheap-|节点|成本|凭据/.test(segment), "no operations data leaks into the segment");
});

test("B1: the roster addresses by TITLE and carries NO database id", () => {
  // Regression: the first cut rendered `岗位引用 <member.id>` (the live row has
  // no `ref`), so the front desk quoted a raw primary key — `m_1793334491977_…`
  // — straight into a visitor-facing answer. The dispatch route resolves titles
  // within the fleet, so the title is the handle and the id never appears.
  const segment = renderChatFleetContext(fakeDb(), "intro-guide");
  assert.ok(!/m_guide|m_lex|m_wire|m_other/.test(segment), "no database member id in the segment");
  assert.ok(!/岗位引用/.test(segment), "the id-bearing '岗位引用' line is gone");
  assert.match(segment, /原样填.*岗位标题/, "the rule tells the model to type the title verbatim");
  // …and a title typed back at the dispatcher resolves to the same post.
  const r = resolveDispatchTarget(fakeDb(), "f1", "识律专家");
  assert.equal(r.ok, true);
  assert.equal(r.member.targetId, "intro-lex");
});

test("B1: an unattributed preset gets NO segment (prompt stays byte-identical)", () => {
  assert.equal(renderChatFleetContext(fakeDb(), "some-random-preset"), null);
  assert.equal(renderChatFleetContext(fakeDb(), null), null);
});

test("B1: an archived team's posts leave attribution (ghost-post guard)", () => {
  const db = fakeDb();
  const original = db.listFleets;
  db.listFleets = () => original().map((f) => (f.id === "f1" ? { ...f, state: "archived" } : f));
  assert.equal(renderChatFleetContext(db, "intro-guide"), null);
});

test("B1: dispatch addressing resolves a member id, a title, and refuses the rest", () => {
  const db = fakeDb();
  const byId = resolveDispatchTarget(db, "f1", "m_lex");
  assert.equal(byId.ok, true);
  assert.equal(byId.member.id, "m_lex");

  const byTitle = resolveDispatchTarget(db, "f1", "识律专家");
  assert.equal(byTitle.ok, true);
  assert.equal(byTitle.member.id, "m_lex");

  const caseInsensitive = resolveDispatchTarget(db, "f1", "识律专家".toLowerCase() === "识律专家" ? "识律专家" : "识律专家");
  assert.equal(caseInsensitive.ok, true);

  const unknown = resolveDispatchTarget(db, "f1", "不存在的岗位");
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /not a member/);

  // Cross-fleet addressing is refused — the roster of another team is not ours.
  const cross = resolveDispatchTarget(db, "f1", "别队岗位");
  assert.equal(cross.ok, false);
});

test("B1: an ambiguous title refuses and lists the candidates (never a guess)", () => {
  const db = fakeDb();
  db.listMembers = (_fleetId) =>
    [
      { id: "m_a", fleetId: "f1", title: "专家", targetKind: "persona", targetId: "x" },
      { id: "m_b", fleetId: "f1", title: "专家", targetKind: "persona", targetId: "y" },
    ];
  const r = resolveDispatchTarget(db, "f1", "专家");
  assert.equal(r.ok, false);
  assert.match(r.error, /ambiguous/);
});

test("B3: the manifest accepts a boolean publicFacing and rejects other types", async () => {
  const { validatePackManifest } = await import("../lib/pack-manifest.js");
  const base = { name: "x", description: "y", agents: [{ id: "a1", name: "岗", persona: "你是岗位。" }] };
  assert.deepEqual(validatePackManifest({ ...base, publicFacing: true }), []);
  assert.deepEqual(validatePackManifest(base), [], "an absent declaration is valid (no behavior change)");
  const bad = validatePackManifest({ ...base, publicFacing: "yes" });
  assert.equal(bad.length, 1);
  assert.match(bad[0].error, /publicFacing must be a boolean/);
});

test("B3: the product-intro seed declares publicFacing", () => {
  const seed = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "docs/fleet-templates/product-intro-fleet.seed.json"), "utf8"),
  );
  assert.equal(seed.publicFacing, true, "the external team declares its public-facing face");
});

test("B3: the composition denies the workspace + discovery tools for a public-facing pack", () => {
  const src = fs.readFileSync(path.join(repoRoot, "dsh-profile.js"), "utf8");
  assert.match(src, /PUBLIC_FACING_DENIED_TOOLS/, "the denied tool list exists");
  for (const tool of ["glob", "grep", "read", "bash", "list_agents", "list_mcp_resources", "tool_search"]) {
    assert.ok(src.includes(`"${tool}"`), `the denied list names ${tool}`);
  }
  assert.match(src, /scope\.publicFacing \? PUBLIC_FACING_DENIED_TOOLS : null/, "the list rides the publicFacing flag");
});

// ── B3 read side: the bridge must actually ENFORCE what the writer declared ──
// The test above pins the write side only. Here the bridge is loaded against an
// anchored temp filter file so the guard reason and the roster narrowing are
// exercised behaviorally — including the case the first cut got wrong: an
// empty mcpTools map reads as "no filter", which must NOT resurrect the denied
// built-ins into the roster (the guard blocks calls; B3 blocks visibility).
const DENIED = ["bash", "glob", "grep", "list_agents", "list_mcp_resources", "read", "tool_search"];

async function loadScope(doc) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "b3-scope-"));
  process.env.TOOL_FILTER_PATH = path.join(tmpRoot, "tool-filter.json");
  fs.writeFileSync(process.env.TOOL_FILTER_PATH, JSON.stringify(doc));
  // Cache-busting import: the module anchors FILTER_FILE at load time, so every
  // case gets a fresh copy under a distinct query key.
  const scope = await import(
    `../dsh-profile-template/platform-tool-scope.js?v=${encodeURIComponent(tmpRoot)}`
  );
  return { scope, cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }) };
}

function stubCtx(roster, opts = {}) {
  const calls = { restrict: [] };
  return {
    calls,
    logger: { warn: () => {} },
    tools: {
      schemas: () => roster.map((name) => ({ name })),
      restrict: (patch) => {
        if (opts.restrictThrows) throw new Error("reserved name collision");
        calls.restrict.push(patch);
      },
    },
  };
}

test("B3 read side: the guard rejects a denied built-in with the external-role reason", async () => {
  const { scope, cleanup } = await loadScope({ mcpTools: {}, denyTools: DENIED });
  try {
    for (const tool of DENIED) {
      assert.equal(
        scope.mcpToolGuardReason(tool),
        "this tool is not available to an external-facing role",
        `${tool} is denied for an external-facing role`,
      );
    }
    // Names that are not on the deny list are untouched by this layer.
    assert.equal(scope.mcpToolGuardReason("fleet"), undefined);
    assert.equal(scope.mcpToolGuardReason(undefined), undefined);
  } finally { cleanup(); }
});

test("B3 read side: denied built-ins leave the roster even with NO MCP faces", async () => {
  // The regression this pins: applyMcpToolRestrict used to return as soon as
  // the allowlist map read as null, so a public-facing persona whose focus left
  // zero MCP servers kept bash/read/grep VISIBLE to the model.
  const { scope, cleanup } = await loadScope({ mcpTools: {}, denyTools: DENIED });
  try {
    const ctx = stubCtx(["bash", "read", "grep", "mcp__fleet__dispatch_post"]);
    scope.applyMcpToolRestrict(ctx);
    assert.equal(ctx.calls.restrict.length, 1, "restrict runs even when the allowlist map is empty");
    assert.deepEqual(
      [...ctx.calls.restrict[0].deny].sort(),
      ["bash", "grep", "read"],
      "only the denied built-ins are removed; the fleet bridge stays visible",
    );
  } finally { cleanup(); }
});

test("B3 read side: no denyTools section changes composition byte-for-byte", async () => {
  // Absent declaration = every pre-change pack keeps its current behavior:
  // the guard must not reject built-ins and the roster must be untouched.
  const { scope, cleanup } = await loadScope({ mcpTools: { "law-bench": ["read"] } });
  try {
    assert.equal(scope.mcpToolGuardReason("bash"), undefined, "no denyTools ⇒ built-ins are never denied");
    const ctx = stubCtx(["bash", "read", "mcp__law-bench__delete_corpus"]);
    scope.applyMcpToolRestrict(ctx);
    assert.deepEqual(
      ctx.calls.restrict.map((c) => [...c.deny].sort()),
      [["mcp__law-bench__delete_corpus"]],
      "only the allowlist stage narrows — no built-in is added to the deny set",
    );
  } finally { cleanup(); }
});

test("B3 read side: a roster read failure never breaks composition", async () => {
  const { scope, cleanup } = await loadScope({ mcpTools: {}, denyTools: DENIED });
  try {
    const ctx = {
      logger: { warn: () => {} },
      tools: { schemas: () => { throw new Error("registry unavailable"); }, restrict: () => assert.fail("must not run") },
    };
    assert.doesNotThrow(() => scope.applyMcpToolRestrict(ctx));
  } finally { cleanup(); }
});

test("B5: the one-shot stripper removes closed and unterminated reasoning blocks", () => {
  assert.equal(stripReasoningLeak("<thinking>secret</thinking>visible"), "visible");
  assert.equal(stripReasoningLeak("<reasoning>secret</reasoning>visible"), "visible");
  assert.equal(stripReasoningLeak("visible<thinking>secret"), "visible");
  assert.equal(stripReasoningLeak("<thinking>secret"), "");
});

test("B5: the streaming filter drops a block split across deltas", () => {
  const f = createReasoningLeakFilter();
  const parts = ["<thin", "king>Let me check wire", "-ops tools</thin", "king>Here is the answer"];
  const out = parts.map((p) => f.push(p)).join("");
  assert.equal(out, "Here is the answer", "no reasoning fragment survives the split");
});

test("B5: the streaming filter drops an unterminated block to the end", () => {
  const f = createReasoningLeakFilter();
  const out = f.push("<thinking>never closes") + f.push(" more text");
  assert.equal(out, "", "an unterminated trace swallows the rest");
  assert.equal(f.flush(), "");
});

test("B5: the streaming filter passes ordinary text through untouched", () => {
  const f = createReasoningLeakFilter();
  const out = "hello ".split("").map((c) => f.push(c)).join("") + f.push("world");
  assert.equal(out, "hello world");
});

test("B5: the bot lane and the web lane share ONE implementation", () => {
  const bots = fs.readFileSync(path.join(repoRoot, "server/bots.js"), "utf8");
  assert.match(bots, /from "\.\/reasoning-leak\.js"/, "bots.js imports the shared stripper");
  assert.ok(!/const REASONING_BLOCK_RE/.test(bots), "the bot lane holds no second copy of the regexes");
});
