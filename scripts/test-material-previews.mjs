// ── 目录预览条目的形状契约（surface-material-previews 1.2）────────────────────
//
// 三条判据，各自能红：
//   · 每条 preview 有非空 name 与非空 blurb（缺一项就不该出现在产物里）；
//   · 每物种 ≤3 条（入口页总共只挂 3 条，且高度不得随库存变化）；
//   · 某物种没有 material ⇒ 该键是**空数组**，不是缺键、也不是 fabricated 条目。
//
//   node --test scripts/test-material-previews.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPreview } from "../scripts/plaza-export.mjs";

/** 一条最小 material（导出器内存形状）。 */
function mat(category, name, summary, over = {}) {
  return {
    id: `${category}-${name}`,
    category,
    human: { en: { name, summary }, "zh-CN": { name, summary } },
    canonical: { brief: summary },
    badges: {},
    ...over,
  };
}

const CATS = ["pack", "skill", "mcp", "facade", "official-data"];

/** 预览行的 name/blurb 现在是五语槽（polish-facet-read-surfaces D7）。这些用例
 *  验的是「内容判据」，与语言无关，所以统一在 zh 主轨上断言；语言形状另有
 *  专门用例（见文件末尾）。 */
const zh = (v) => (typeof v === "string" ? v : (v?.["zh-CN"] ?? ""));


test("每条预览都有非空 name 与非空 blurb", () => {
  const out = buildPreview(CATS.map((c) => mat(c, `${c}-item`, `${c} 的一句话说明`)));
  for (const [species, rows] of Object.entries(out)) {
    for (const r of rows) {
      assert.ok(zh(r.name).trim(), `${species}: name 为空`);
      assert.ok(zh(r.blurb).trim(), `${species}: blurb 为空`);
    }
  }
});

test("每物种至多 3 条", () => {
  const many = Array.from({ length: 10 }, (_, i) => mat("pack", `包${String(i).padStart(2, "0")}`, "说明"));
  const out = buildPreview(many);
  assert.equal(out.pack.length, 3, `期望 3 条，实际 ${out.pack.length}`);
});

test("无 material 的物种得到空数组，而不是缺键", () => {
  const out = buildPreview([mat("pack", "唯一的包", "说明")]);
  for (const c of CATS) {
    assert.ok(Array.isArray(out[c]), `${c}: 必须是数组，缺键会让前端无法区分「没有」与「产物过期」`);
  }
  assert.equal(out.pack.length, 1);
  assert.equal(out.skill.length, 0);
  assert.equal(out.mcp.length, 0);
});

test("既无 summary 也无 description 的 material 不进 preview（不编造）", () => {
  const bare = { id: "x", category: "pack", human: { en: { name: "无名" }, "zh-CN": { name: "无名" } }, canonical: {}, badges: {} };
  const out = buildPreview([bare, mat("pack", "有说明的包", "这是一句说明")]);
  assert.equal(out.pack.length, 1, "只有能回答「这是什么」的条目该出现");
  assert.equal(zh(out.pack[0].name), "有说明的包");
});

test("featured/official 优先，其余按名字稳定排序", () => {
  const mats = [
    mat("pack", "乙包", "说明乙"),
    mat("pack", "官方包", "说明官方", { badges: { official: true } }),
    mat("pack", "甲包", "说明甲"),
  ];
  const out = buildPreview(mats);
  assert.equal(zh(out.pack[0].name), "官方包", "official 必须排第一");
  // 剩下两个按 localeCompare 稳定排序，两次调用结果必须一致
  const again = buildPreview(mats);
  assert.deepEqual(out.pack, again.pack, "排序必须稳定（同一输入两次结果相同）");
});

test("badge 只在有可数事实时出现", () => {
  const withTools = mat("mcp", "带工具的 MCP", "说明", { toolCount: 7 });
  const plain = mat("pack", "普通包", "说明");
  const out = buildPreview([withTools, plain]);
  assert.equal(out.mcp[0].badge, "7");
  assert.equal("badge" in out.pack[0], false, "没有可数事实就不带 badge 键");
});

test("blurb 截断到 160 显示宽以内", () => {
  const long = "很长的说明".repeat(100);
  const out = buildPreview([mat("pack", "长说明包", long)]);
  assert.ok(zh(out.pack[0].blurb).length <= 160, `blurb 长度 ${zh(out.pack[0].blurb).length} 超限`);
});

// ── pack 的 blurb 优先用 display.promise（D2）────────────────────────────────
//
// 列表行带 `display.promise`（manifest 的一句话承诺，已按 locale 投影）。
// 用它而不是 description：description 动辄 200 字，塞进卡片预览就是详情页
// 当年要替换掉的那种「被截半句」。这条钉住 annotatePack 的优先级。
test("pack 的 summary 优先取 display.promise，其次 description", async () => {
  const { annotatePack } = await import("../scripts/plaza-export.mjs");
  const row = (over) => ({ id: "p1", name: "测试包", description: "很长的描述".repeat(30), visibility: "public", unlisted: false, ...over });
  // 有 promise ⇒ 用它
  const withP = annotatePack({ en: [row({ display: { promise: "一句话承诺" } })] }, "2026-11-24", "test");
  const m1 = withP.find((x) => x.category === "pack");
  assert.equal(m1.human.en.summary, "一句话承诺", "有 display.promise 时必须用它");
  // 没有 ⇒ 回落 description
  const withoutP = annotatePack({ en: [row({})] }, "2026-11-24", "test");
  const m2 = withoutP.find((x) => x.category === "pack");
  assert.ok(m2.human.en.summary.startsWith("很长的描述"), "无 promise 时回落到 description");
});

// ── official-data 只取「源」，指标不进预览 ───────────────────────────────────
//
// 483 条里 461 是指标（SPY_ma5 / 000001_close 这种展开项），22 个是数据源。
// 按名字排序必然全是指标，而 `000001_close` 对读者等于没说。spec 的原话是
// "Sources are listed first; indicators expand" —— 预览跟这个口径。
test("official-data 预览只取源，不取指标", () => {
  const mats = [
    mat("official-data", "000001_close", "000001_close（astock）", { anchorKind: "indicator" }),
    mat("official-data", "SPY_ma5", "SPY_ma5（yfinance）", { anchorKind: "indicator" }),
    mat("official-data", "世界银行", "世界银行开放数据：全球发展指标", { anchorKind: "source", anchorSource: "worldbank" }),
  ];
  const out = buildPreview(mats);
  assert.equal(out["official-data"].length, 1, "只该出现 source 类");
  assert.equal(zh(out["official-data"][0].name), "世界银行");
});

// ── 同义反复的 blurb 剔除 ────────────────────────────────────────────────────
//
// 「阿尔法哨兵」的 summary 就是它自己的名字——那种条目占了位置却说零信息。
test("blurb 与 name 相同的条目不进预览", () => {
  const mats = [
    mat("facade", "阿尔法哨兵", "阿尔法哨兵"),
    mat("facade", "有真说明的分身", "以决策账本为准复盘，不改写历史"),
  ];
  const out = buildPreview(mats);
  assert.equal(out.facade.length, 1);
  assert.equal(zh(out.facade[0].name), "有真说明的分身");
});

// ── 模板变量不得出现在预览里 ────────────────────────────────────────────────
//
// `{{fleetContext}}` 这类占位符由 agent harness 在运行时填充，读者面看到的是
// 一对裸花括号。实测 AI Company 的 summary 就带着它。剥掉；剥完不成句就不进预览。
test("模板变量被剥掉，剥完不成句则不出现", () => {
  const withVar = mat("pack", "带变量的包", "Official showcase: CEO patrol ({{fleetContext}} injected) plus roles");
  const onlyVar = mat("pack", "只有变量的包", "{{fleetContext}}");
  const out = buildPreview([withVar, onlyVar]);
  assert.equal(out.pack.length, 1, "只剩那条剥完仍成句的");
  assert.doesNotMatch(zh(out.pack[0].blurb), /\{\{|\}\}/, "预览里不得留模板花括号");
});

// 括号里含模板变量时，整个括号连同残词一起删（「( injected)」读作错别字）
test("括号内含模板变量的整段被删掉，句子仍完整", () => {
  const m = mat("pack", "带括号变量的包", "Official showcase: CEO patrol ({{fleetContext}} injected) + three roles");
  const out = buildPreview([m]);
  assert.doesNotMatch(zh(out.pack[0].blurb), /\(\s*injected\)/, "不得留下孤立的括号残词");
  assert.match(zh(out.pack[0].blurb), /CEO patrol \+ three roles/, "删括号后句子必须连贯");
});

// ── 五语槽（polish-facet-read-surfaces D7 / 7.1）──────────────────────────────
//
// 同一张卡里不能有两种语言：zh 页面里 pack 是英文、mcp 是中文，读起来像坏掉。
// 所以 name/blurb 各带五个 locale 的槽，前端按读者语言取。
test("preview 行带五语槽，非 zh 槽与 zh 槽不全等", () => {
  const m = {
    id: "pack-bilingual",
    category: "pack",
    human: {
      "zh-CN": { name: "蓝图构造师", summary: "把自然语言描述编译成可发布的团队蓝图" },
      en: { name: "Vertical Constructor", summary: "Compile natural language into a publishable team blueprint" },
      es: { name: "Constructor Vertical", summary: "Compila lenguaje natural en un plano publicable" },
      fr: { name: "Constructeur vertical", summary: "Compiler le langage naturel en plan publiable" },
      ja: { name: "垂直コンストラクタ", summary: "自然言語を公開可能なチーム青写真にコンパイル" },
    },
    canonical: {},
    badges: {},
  };
  const [row] = buildPreview([m]).pack;
  for (const loc of ["zh-CN", "en", "es", "fr", "ja"]) {
    assert.equal(typeof row.name[loc], "string", `${loc}: name 必须是字符串槽`);
    assert.equal(typeof row.blurb[loc], "string", `${loc}: blurb 必须是字符串槽`);
  }
  assert.equal(row.name.en, "Vertical Constructor");
  assert.notEqual(row.name.en, row.name["zh-CN"], "非 zh 槽不能回落到 zh（否则五语是假象）");
});

test("某语言缺句子时该槽为空串，条目不因此消失", () => {
  const m = {
    id: "pack-zh-only",
    category: "pack",
    human: { "zh-CN": { name: "只有中文的包", summary: "只有中文的一句话" } },
    canonical: {},
    badges: {},
  };
  const [row] = buildPreview([m]).pack;
  assert.equal(row.name["zh-CN"], "只有中文的包");
  assert.equal(row.blurb.en, "", "缺哪一语言的句子就是空串，不借用别的语言");
});
