// /memory 仪表盘测试（add-memory-visible-ux 任务 3.3）：weeklyCounts 聚合口径、
// 时间线混排排序、harness 徽标取值。范式=项目既有纯函数测试（web 无组件测试
// 设施，无 vitest/testing-library）——但被测纯函数住在 MemoryPage.tsx 里
// （任务文件所有权把节奏条+时间线都钉在该页），node 不能直接 import .tsx，
// 故用 web/node_modules 的 typescript 对该页做 transpile（去类型与 JSX），
// react/react-i18next/react-router-dom/@/api/memory 以 data: URL 桩替换
// （组件体在 import 期不执行，桩只为让模块装载到导出面），经 module.registerHooks
// 同线程注册后动态导入。仓库零落文件、零新增依赖。

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { registerHooks, createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_PATH = join(ROOT, "web/src/pages/MemoryPage.tsx");

let mod;

before(async () => {
  const ts = createRequire(join(ROOT, "web/package.json"))("typescript");
  const STUB = "data:text/javascript," + encodeURIComponent(
    [
      "export default {};",
      "export const useCallback = () => () => {};",
      "export const useEffect = () => {};",
      "export const useMemo = () => () => {};",
      "export const useState = () => () => {};",
      "export const useTranslation = () => ({ t: (k) => k });",
      "export const useNavigate = () => () => {};",
      "export const jsx = () => null;",
      "export const jsxs = () => null;",
      "export const Fragment = () => null;",
      "export const listMemoryEntries = async () => ({ items: [] });",
      "export const listDeployerMemoryEntries = async () => ({ items: [] });",
      "export const listPromotions = async () => ({ proposals: [] });",
      "export const acceptPromotion = async () => ({});",
      "export const ignorePromotion = async () => ({});",
    ].join("\n"),
  );
  registerHooks({
    resolve(specifier, context, next) {
      if (
        specifier.startsWith("@/") ||
        specifier === "react" ||
        specifier.startsWith("react/") ||
        specifier === "react-i18next" ||
        specifier === "react-router-dom"
      ) {
        return { url: STUB, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.endsWith(".tsx") || url.endsWith(".ts")) {
        const src = readFileSync(new URL(url).pathname, "utf8");
        const out = ts.transpileModule(src, {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
          fileName: url,
        }).outputText;
        return { format: "module", source: out, shortCircuit: true };
      }
      return next(url, context);
    },
  });
  mod = await import(`file://${PAGE_PATH}`);
});

// ── 测试日期构造：全部走本地时区（new Date(y, m, d, …)），口径断言与时区无关。
// 固定「现在」= 2026-11-07（周六）。本周一 = 2026-11-02 00:00 本地。
const NOW = new Date(2026, 10, 7, 12, 0, 0);
const entry = (over = {}) => ({
  path: over.path ?? "u/x/m-" + Math.random().toString(36).slice(2),
  title: over.title ?? "条目",
  project: "u/x",
  layer: over.layer ?? "L1",
  ts: over.ts ?? new Date(2026, 10, 3, 10, 0, 0).toISOString(),
  ...over,
});

test("startOfWeek: 周六的本周一是 11-02 00:00，周日落上周一（ISO 8601 周制）", () => {
  const sat = mod.startOfWeek(NOW);
  assert.deepEqual([sat.getFullYear(), sat.getMonth(), sat.getDate(), sat.getHours()], [2026, 10, 2, 0]);
  // 周日（2026-11-01）属于 10-26 那一周，不是 11-02
  const sun = mod.startOfWeek(new Date(2026, 10, 1, 23, 0, 0));
  assert.deepEqual([sun.getFullYear(), sun.getMonth(), sun.getDate()], [2026, 9, 26]);
});

test("weeklyCounts: 上周条目不算——fetch 双保险之外再按 ts 过滤", () => {
  const items = [
    entry({ layer: "L0", ts: new Date(2026, 10, 1, 23, 59, 0).toISOString() }), // 上周日
    entry({ layer: "L0", ts: new Date(2026, 10, 2, 0, 0, 0).toISOString() }), // 周一零点=窗口起点，算
    entry({ layer: "L1", ts: new Date(2026, 10, 5, 8, 0, 0).toISOString() }),
  ];
  const out = mod.weeklyCounts(items, [], NOW);
  assert.equal(out.capture, 1);
  assert.equal(out.note, 1);
});

test("weeklyCounts: 四计数口径（L0 捕获 / L1 note / 更正前缀 / promotions 数）", () => {
  const items = [
    entry({ layer: "L0", title: "回合捕获：部署验证通过" }),
    entry({ layer: "L0", title: "回合捕获：上线窗口确认" }),
    entry({ layer: "L1", title: "交接：ci 绿了" }),
    entry({ layer: "L1", title: "更正：部署脚本要加 --frozen-lockfile" }),
    entry({ layer: "L2", title: "更正：缓存键含 commit sha" }),
    entry({ layer: "L2", title: "本周的更正经验谈" }), // 「更正」不在前缀 → 不算
  ];
  const out = mod.weeklyCounts(items, [{ path: "p1" }, { path: "p2" }], NOW);
  // note 按 layer=L1 计、更正按标题前缀计——两条口径独立：更正 note 本身是
  // L1，同时进 note 与 correction（与任务口径一致，不互相扣除）。
  assert.deepEqual(out, { capture: 2, note: 2, correction: 2, pendingPromotion: 2 });
});

test("weeklyCounts: 更正前缀判定含首空白容忍，且更正与 layer 无关", () => {
  const items = [
    entry({ layer: "L1", title: "  更正：缩进规则" }),
    entry({ layer: "L0", title: "讨论里提到更正流程" }), // 句中「更正」不算
  ];
  const out = mod.weeklyCounts(items, [], NOW);
  assert.equal(out.correction, 1);
});

test("weeklyCounts: 空入参安全（items/promotions 缺失不抛）", () => {
  const out = mod.weeklyCounts(undefined, undefined, NOW);
  assert.deepEqual(out, { capture: 0, note: 0, correction: 0, pendingPromotion: 0 });
});

test("timelineSort: L0/note/L2 按 ts 倒序混排，无效 ts 沉底", () => {
  const t = (d, h) => new Date(2026, 10, d, h, 0, 0).toISOString();
  const items = [
    entry({ path: "a", layer: "L1", ts: t(4, 9) }),
    entry({ path: "b", layer: "L0", ts: t(5, 18) }),
    entry({ path: "c", layer: "L2", ts: t(3, 8) }),
    entry({ path: "d", layer: "L0", ts: "not-a-date" }),
    entry({ path: "e", layer: "L1", ts: t(6, 7) }),
  ];
  const out = mod.timelineSort(items);
  assert.deepEqual(
    out.map((x) => x.path),
    ["e", "b", "a", "c", "d"],
  );
});

test("timelineSort: 同 ts 保持原序（稳定），空/单元素平凡", () => {
  const same = "2026-11-05T10:00:00.000Z";
  const items = [
    entry({ path: "first", layer: "L0", ts: same }),
    entry({ path: "second", layer: "L1", ts: same }),
    entry({ path: "third", layer: "L2", ts: same }),
  ];
  const out = mod.timelineSort(items);
  assert.deepEqual(
    out.map((x) => x.path),
    ["first", "second", "third"],
  );
  assert.deepEqual(mod.timelineSort([]), []);
  const one = [entry({ path: "solo" })];
  assert.deepEqual(mod.timelineSort(one), one);
});

test("entryHarness: metadata 对象与 JSON 字符串两形态都取得到", () => {
  assert.equal(mod.entryHarness({ harness: "claude-code" }), "claude-code");
  assert.equal(mod.entryHarness(JSON.stringify({ harness: "claude-code" })), "claude-code");
  assert.equal(mod.entryHarness(JSON.stringify({ harness: "zhiyu", lane: "zhiyu" })), "zhiyu");
});

test("entryHarness: 坏 JSON/缺 harness/非字符串形态一律空串（不渲染徽标）", () => {
  assert.equal(mod.entryHarness("{not json"), "");
  assert.equal(mod.entryHarness({ lane: "zhiyu" }), "");
  assert.equal(mod.entryHarness(JSON.stringify({ harness: 42 })), "");
  assert.equal(mod.entryHarness(null), "");
  assert.equal(mod.entryHarness(undefined), "");
  assert.equal(mod.entryHarness(123), "");
});
