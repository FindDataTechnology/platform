// ── Publish checklist: the four gates in one place (complete-creator-loop) ───
//
//   node --test scripts/test-publish-checklist.mjs
//
// 钉住的契约：
//   · 四条闸逐条变成可定位的行（工具面 / 词表 / 英文覆盖 / 清单结构）；
//   · 缺数据不猜：词表没取到 → 不出词表行；覆盖读取失败 → 不出覆盖行；
//   · 服务端拒绝落到同一形状：英文覆盖拒绝拆成多行，其它拒绝一行带原文；
//   · 判据不被呈现层放宽或收紧——本模块只汇总，不新增条件。
//
// 反向验证见 4.2：把「缺数据」分支改成给出结论，本文件必须转红。

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  buildChecklist,
  undecidedFaceServers,
  outOfVocabularyPicks,
  rowsFromRefusal,
  groupChecklist,
} = await import("../web/src/lib/publishChecklist.ts");

const base = {
  mcpPicked: [],
  mcpTools: {},
  fullSurfaceReasons: {},
  vocabularySlugs: [],
  domainPicks: [],
  audiencePicks: [],
  coverage: null,
};

test("a clean draft has an empty checklist", () => {
  assert.deepEqual(buildChecklist(base), []);
});

test("an undecided tool surface is one row per server", () => {
  const input = {
    ...base,
    mcpPicked: ["fd-open-data-mcp", "fd-daos"],
    mcpTools: { "fd-open-data-mcp": ["query"], "fd-daos": [] },
    fullSurfaceReasons: { "fd-daos": "  " }, // blank reason == still undecided
  };
  assert.deepEqual(undecidedFaceServers(input), ["fd-daos"]);
  const rows = buildChecklist(input);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gate, "toolsFace");
  assert.equal(rows[0].subject, "fd-daos");
  assert.equal(rows[0].locatable, true);
});

test("a deliberated full surface is not a gap", () => {
  const input = {
    ...base,
    mcpPicked: ["fd-daos"],
    mcpTools: { "fd-daos": [] },
    fullSurfaceReasons: { "fd-daos": "整面可用，已评估" },
  };
  assert.deepEqual(undecidedFaceServers(input), []);
  assert.deepEqual(buildChecklist(input), []);
});

test("out-of-vocabulary picks are named once each", () => {
  const input = {
    ...base,
    vocabularySlugs: ["legal", "finance"],
    domainPicks: ["legal", "别的东西"],
    audiencePicks: ["别的东西", "金融"],
  };
  assert.deepEqual(outOfVocabularyPicks(input), ["别的东西", "金融"]);
  const rows = buildChecklist(input);
  assert.equal(rows.filter((r) => r.gate === "vocabulary").length, 2);
});

test("an unloaded vocabulary table produces no verdict", () => {
  // The table failed to load: we cannot judge, so we say nothing.
  const input = { ...base, vocabularySlugs: [], domainPicks: ["whatever"] };
  assert.deepEqual(outOfVocabularyPicks(input), []);
  assert.deepEqual(buildChecklist(input), []);
});

test("failed coverage read produces no coverage rows", () => {
  assert.deepEqual(buildChecklist({ ...base, coverage: null }), []);
});

test("coverage gaps become one locatable row each", () => {
  const rows = buildChecklist({
    ...base,
    coverage: { total: 4, covered: 2, missing: ["name", "guide.steps[0].title"] },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.subject),
    ["name", "guide.steps[0].title"],
  );
  assert.equal(rows.every((r) => r.gate === "enCoverage" && r.locatable), true);
});

test("a server refusal maps into the same row shape", () => {
  const rows = rowsFromRefusal({
    code: "official_en_coverage_incomplete",
    message: "英文覆盖不完整",
    missing: ["description", "tags"],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].gate, "enCoverage");

  const plain = rowsFromRefusal({ message: "manifest.tooLarge: 12 MB" });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].gate, "manifest");
  assert.equal(plain[0].locatable, false, "an unknown refusal is not pretended to be locatable");
  assert.match(plain[0].subject, /manifest\.tooLarge/);

  assert.deepEqual(rowsFromRefusal({}), [], "no message, no row");
});

test("groups keep a stable order and drop empty gates", () => {
  const rows = [
    ...buildChecklist({
      ...base,
      mcpPicked: ["srv"],
      vocabularySlugs: ["legal"],
      domainPicks: ["bogus"],
      coverage: { total: 1, covered: 0, missing: ["name"] },
    }),
  ];
  const groups = groupChecklist(rows);
  assert.deepEqual(
    groups.map((g) => g.gate),
    ["toolsFace", "vocabulary", "enCoverage"],
  );
  assert.equal(groupChecklist([]).length, 0);
});
