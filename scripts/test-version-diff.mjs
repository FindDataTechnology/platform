// ── 版本快照对比（pack-detail-as-page 3.3）────────────────────────────────────
//
//   node --test scripts/test-version-diff.mjs
//
// 比的是 **manifest 声明的结构**，不是文本。判据：改了的才列出来，没改的不占位。
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeOf, diffShape, changedOnly } from "../web/src/components/packs/version-diff.ts";

test("shapeOf counts what is declared, missing is missing", () => {
  const s = shapeOf({ agents: [{}, {}], skills: [{}], mcpServers: [], memory: {}, console: {} });
  assert.equal(s.roles, 2);
  assert.equal(s.skills, 1);
  assert.equal(s.mcpServers, 0);
  assert.equal(s.hasMemory, true);
  assert.equal(s.hasConsole, true);
  assert.equal(s.hasCluster, false);
});

test("shapeOf tolerates a null manifest", () => {
  const s = shapeOf(null);
  assert.equal(s.roles, 0);
  assert.equal(s.hasMemory, false);
});

test("diffShape marks only the fields that moved", () => {
  const before = shapeOf({ agents: [{}], skills: [{}, {}], memory: {} });
  const after = shapeOf({ agents: [{}], skills: [{}], memory: {} });
  const rows = diffShape(before, after);
  const changed = changedOnly(rows).map((r) => r.field);
  assert.deepEqual(changed, ["skills"], "only skills changed");
});

test("a memory declaration appearing is a change", () => {
  const before = shapeOf({ skills: [{}] });
  const after = shapeOf({ skills: [{}], memory: { store: {} } });
  assert.deepEqual(changedOnly(diffShape(before, after)).map((r) => r.field), ["hasMemory"]);
});

test("identical manifests produce no changed rows", () => {
  const m = { agents: [{}], skills: [{}] };
  assert.deepEqual(changedOnly(diffShape(shapeOf(m), shapeOf(m))), []);
});

test("the diff keeps both sides for a changed row", () => {
  const rows = diffShape(shapeOf({ skills: [{}, {}] }), shapeOf({ skills: [{}] }));
  const row = rows.find((r) => r.field === "skills");
  assert.equal(row.before, 2);
  assert.equal(row.after, 1);
  assert.equal(row.changed, true);
});
