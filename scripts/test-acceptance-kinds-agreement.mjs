// ── acceptance kinds agreement (complete-team-authoring-loop 2.6) ──────────
//
// AcceptanceEditor keeps a literal copy of the server's closed assertion-kind
// set, because the web bundle cannot import a server module. A copy that drifts
// would let the form offer a kind the validator rejects — exactly the silent
// class of bug this change exists to remove. So the copy is pinned here.
//
//   node --test scripts/test-acceptance-kinds-agreement.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");

const { TRIAL_ASSERTION_KINDS } = await import("../web/src/lib/assertion-kinds.ts");
const { TRIAL_ASSERTION_KINDS: SERVER_KINDS } = await import("../server/blueprint-validate.js");

test("web 侧的断言闭集与服务端逐项一致", () => {
  assert.deepEqual([...TRIAL_ASSERTION_KINDS], [...SERVER_KINDS]);
});

test("服务端仍把 llm-judged 计入成本闸（表单面的 overCap 提示依赖它）", () => {
  const src = readFileSync(path.join(ROOT, "server/blueprint-validate.js"), "utf8");
  assert.match(src, /JUDGE_ASSERTION_CAP/);
  assert.match(src, /kind === "llm-judged"[\s\S]{0,200}rubric/);
});

test("错误码映射覆盖 acceptance 闭集（行内报错不落回无摘要）", () => {
  const src = readFileSync(path.join(ROOT, "web/src/lib/error-codes.ts"), "utf8");
  for (const code of [
    "acceptance_entry_invalid",
    "acceptance_kind_unsupported",
    "acceptance_target_invalid",
    "acceptance_expect_invalid",
    "acceptance_rubric_required",
    "acceptance_judge_cap",
  ]) {
    assert.ok(src.includes(code), `error-codes.ts 缺 ${code}`);
  }
});
