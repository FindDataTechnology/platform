#!/usr/bin/env node
// ── Display format v2 validation matrix (overhaul-market-catalog-presentation
// 4.1) ───────────────────────────────────────────────────────────────────────
//
// The v2 display fields (identity/promise/audience/outcomes/examples/domain)
// are OPTIONAL presentation — the same validator answers for the publish
// endpoint and the install path (spec: 发布面与安装面共用). Pins:
//   1. a full v2 manifest inside every cap validates clean
//   2. every cap fires on the right field PATH (promise width, examples count,
//      outcomes shape, domain vocabulary, accent color)
//   3. an absent field costs nothing: a legacy manifest validates with zero
//      v2-shaped errors (byte-identity of the payload itself is pinned by
//      4.5's projection diff test)
//   4. runtime contracts are untouched by v2 fields — the same manifest
//      validates identically with and without them
//
//   node --test scripts/test-pack-display-format.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { validatePackManifest } = await import("../lib/pack-manifest.js");
const { lineSlugs } = await import("../lib/pack-taxonomy.js");

// A minimal legal pack: one skill, nothing else. Every case below spreads this
// and adds display fields, so a failure names the display field, never a base.
const BASE = {
  name: "显示格式测试包",
  description: "用于钉 v2 校验矩阵的基础包。",
  skills: [{ name: "s", description: "d", content: "# s" }],
};

const FULL_V2 = {
  identity: { mark: { kind: "glyph", value: "柏" }, accent: "wire" },
  promise: "四件套策略工坊：从设计到回测一句话讲清。",
  audience: ["investing", "legal"],
  outcomes: [
    { title: "可跑的因子库", detail: "每周更新的回测工作流" },
    { title: "晨会纪要" },
  ],
  examples: [
    { title: "问风险", prompt: "评估这份组合的回撤风险" },
    { title: "拟策略", prompt: "按动量因子拟一条月度调仓策略" },
  ],
  domain: ["investing"],
};

const displayErrors = (manifest) =>
  validatePackManifest(manifest).filter((e) =>
    ["identity", "promise", "audience", "outcomes", "examples", "domain"].some(
      (k) => String(e.entry ?? e.error).startsWith(k),
    ),
  );

test("完整 v2 manifest 通过校验（全部字段在册且在上限内）", () => {
  assert.deepEqual(displayErrors({ ...BASE, ...FULL_V2 }), []);
});

test("缺省降级：老 manifest 零 v2 错误，新增字段绝不无中生有", () => {
  const legacy = validatePackManifest(BASE);
  assert.equal(legacy.length, 0, `legacy 必须完全干净，实际: ${JSON.stringify(legacy)}`);
});

test("承诺超宽按显示宽拒（31 个 CJK 字 = 宽 61 > 60）", () => {
  const errs = displayErrors({ ...BASE, promise: "长".repeat(31) });
  assert.equal(errs.length, 1);
  assert.match(errs[0].entry, /^promise$/);
  assert.match(errs[0].error, /display-width/);
  // 恰在预算内放行——上限是含等号语义（60 宽）。
  assert.equal(displayErrors({ ...BASE, promise: "长".repeat(30) }).length, 0);
});

test("条数越界拒并说明允许区间（examples 1 条 / 5 条；outcomes 1 条 / 6 条）", () => {
  const one = displayErrors({ ...BASE, examples: [{ title: "t", prompt: "p" }] });
  assert.equal(one.length, 1);
  assert.match(one[0].error, /2-4 entries/);
  const five = displayErrors({
    ...BASE,
    examples: Array.from({ length: 5 }, () => ({ title: "t", prompt: "p" })),
  });
  assert.match(five[0].error, /2-4 entries/);
  const outcomes1 = displayErrors({ ...BASE, outcomes: [{ title: "t" }] });
  assert.match(outcomes1[0].error, /2-5 entries/);
  const outcomes6 = displayErrors({
    ...BASE,
    outcomes: Array.from({ length: 6 }, () => ({ title: "t" })),
  });
  assert.match(outcomes6[0].error, /2-5 entries/);
});

test("词表外领域被拒，错误指名 slug 与字段路径", () => {
  const errs = displayErrors({ ...BASE, domain: ["investing", "crypto"] });
  assert.equal(errs.length, 1);
  assert.equal(errs[0].entry, "domain[1]");
  assert.match(errs[0].error, /controlled vocabulary/);
  // audience 用同一受控词表。
  const aud = displayErrors({ ...BASE, audience: ["investing", "made-up", "legal"] });
  assert.equal(aud.length, 1);
  assert.equal(aud[0].entry, "audience[1]");
});

test("色值不可自由填写：accent 只接受线 slug（十六进制单独点名）", () => {
  const hex = displayErrors({ ...BASE, identity: { accent: "#ff0000" } });
  assert.equal(hex.length, 1);
  assert.equal(hex[0].entry, "identity.accent");
  assert.match(hex[0].error, /free color values are not writable/);
  const bogus = displayErrors({ ...BASE, identity: { accent: "not-a-line" } });
  assert.match(bogus[0].error, new RegExp(lineSlugs().join("/")));
});

test("identity.mark 形状钉死（kind 三选、glyph/emoji 1-2 字、image 受控引用串）", () => {
  assert.equal(displayErrors({ ...BASE, identity: { mark: { kind: "emoji", value: "🐛" } } }).length, 0);
  assert.equal(displayErrors({ ...BASE, identity: { mark: { kind: "glyph", value: "法律" } } }).length, 0, "2 字合法");
  assert.match(
    displayErrors({ ...BASE, identity: { mark: { kind: "glyph", value: "壹座智能体" } } })[0].error,
    /1-2 characters/,
  );
  assert.match(displayErrors({ ...BASE, identity: { mark: { kind: "svg", value: "x" } } })[0].error, /one of glyph\/emoji\/image/);
  assert.match(displayErrors({ ...BASE, identity: { mark: { kind: "image", value: "  " } } })[0].error, /controlled reference/);
});

test("examples/outcomes 条目形状：未知键与空文本报字段路径", () => {
  const e1 = displayErrors({ ...BASE, examples: [{ title: "t", prompt: "p" }, { title: "t", prompt: "p", color: "red" }] });
  assert.equal(e1[0].entry, "examples[1]");
  const e2 = displayErrors({ ...BASE, outcomes: [{ title: "  " }, { title: "t" }] });
  assert.equal(e2[0].entry, "outcomes[0].title");
});

test("运行时契约不因 v2 字段移动：同包带/不带 v2 的其余错误恒等", () => {
  const withV2 = validatePackManifest({ ...BASE, ...FULL_V2 });
  const without = validatePackManifest(BASE);
  assert.deepEqual(withV2, without, "v2 字段不得给 base 合法包带来任何新错误");
  // 坏包不因 v2 字段而洗白：基础违规原样在。
  const broken = validatePackManifest({ ...BASE, skills: [{ name: "s", content: "# s" }], ...FULL_V2 });
  const brokenNoV2 = validatePackManifest({ ...BASE, skills: [{ name: "s", content: "# s" }] });
  assert.ok(broken.length > 0 && broken.length === brokenNoV2.length);
});

// ── 4.2 叠加校验 (pack-locale-tracks: 显示字段的 zh 主轨与顶层叠加块) ────────
// The same validator answers for overlay blocks. Pins the new scenarios of the
// MODIFIED requirement one for one.

const BASE_V2 = {
  ...BASE,
  promise: "一句话讲清这个包。",
  domain: ["investing", "risk"],
  audience: ["legal"],
  outcomes: [
    { title: "因子库", detail: "每周更新" },
    { title: "纪要" },
  ],
  examples: [
    { title: "问风险", prompt: "评估回撤" },
    { title: "拟策略", prompt: "月度调仓" },
  ],
  identity: { mark: { kind: "glyph", value: "柏" }, accent: "wire" },
};

const overlayErrors = (manifest) =>
  validatePackManifest(manifest).filter((e) => String(e.entry ?? e.error).startsWith("i18n."));

test("副轨覆盖合法：promise/outcomes 同索引 title/domain 同长度/tags 同长度 全过", () => {
  const en = {
    ...BASE_V2,
    i18n: {
      en: {
        promise: "One sentence, one pack.",
        domain: ["investing", "risk"],
        audience: ["legal"],
        outcomes: [{ title: "Factor library", detail: "weekly" }, { title: "Minutes" }],
        examples: [{ title: "Ask risk", prompt: "Assess drawdown" }, { title: "Draft", prompt: "Monthly rebalance" }],
        identity: { mark: { value: "W" } },
      },
    },
  };
  assert.deepEqual(overlayErrors(en), []);
});

test("tags 副轨：与 zh 基同长度的英文标签通过；长度不齐拒并说明两边条数", () => {
  const ok = { ...BASE, tags: ["法律", "合同", "审查", "风控"], i18n: { en: { tags: ["Law", "Contract", "Review", "Risk"] } } };
  assert.deepEqual(overlayErrors(ok), []);
  const bad = { ...BASE, tags: ["法律", "合同", "审查", "风控"], i18n: { en: { tags: ["Law", "Contract"] } } };
  const errs = overlayErrors(bad);
  assert.equal(errs.length, 1);
  assert.match(errs[0].error, /2 entries but the zh base declares 4/);
});

test("数组长度不对齐被拒（domain 2 vs 3 / outcomes 条数不齐）并指明 locale+路径+条数", () => {
  const d = { ...BASE_V2, i18n: { en: { domain: ["investing"] } } };
  const errs = overlayErrors(d);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].entry, "i18n.en.domain");
  assert.match(errs[0].error, /1 entries but the zh base declares 2/);
  const o = { ...BASE_V2, i18n: { en: { outcomes: [{ title: "Only one" }] } } };
  assert.match(overlayErrors(o)[0].error, /1 entries but the zh base declares 2/);
});

test("结构字段进叠加块被拒（identity.accent / identity.mark.kind 各点名）", () => {
  const accent = overlayErrors({ ...BASE_V2, i18n: { en: { identity: { accent: "lex" } } } });
  assert.equal(accent.length, 1);
  assert.match(accent[0].error, /structure, not display copy/);
  const kind = overlayErrors({ ...BASE_V2, i18n: { en: { identity: { mark: { kind: "emoji", value: "X" } } } } });
  assert.equal(kind.length, 1);
  assert.match(kind[0].error, /identity\.mark\.kind is structure/);
});

test("叠加块引用未声明实体被拒（promise/mark 基字段缺席即拒）", () => {
  const p = overlayErrors({ ...BASE, i18n: { en: { promise: "No base promise to override." } } });
  assert.equal(p.length, 1);
  assert.match(p[0].error, /does not declare in its zh main track/);
  const m = overlayErrors({ ...BASE, i18n: { en: { identity: { mark: { value: "柏" } } } } });
  assert.equal(m.length, 1);
});

test("副轨的 promise 同样受 60 显示宽上限；detail/prompt 只覆盖基字段声明过的子键", () => {
  assert.equal(overlayErrors({ ...BASE_V2, i18n: { en: { promise: "长".repeat(31) } } }).length, 1);
  // outcomes[1] (纪要) declares NO detail; the invented detail lands THERE.
  const invented = overlayErrors({ ...BASE_V2, i18n: { en: { outcomes: [{ title: "a" }, { title: "b", detail: "invented" }] } } });
  assert.equal(invented.length, 1);
  assert.match(invented[0].error, /zh base entry does not declare/);
});

test("词表外 slug 在副轨同样被拒；未知键仍按白名单拒", () => {
  assert.match(overlayErrors({ ...BASE_V2, i18n: { en: { domain: ["crypto", "risk"] } } })[0].error, /controlled vocabulary/);
  const unk = overlayErrors({ ...BASE_V2, i18n: { en: { colorway: "red" } } });
  assert.match(unk[0].error, /unknown key 'colorway'/);
});

// ── 4.3 读面投影 (v2 fields follow the locale; zh fallback on gaps) ─────────
const { projectManifestForLocale } = await import("../lib/pack-locale.js");

test("en 请求：承诺/标签/领域/你会得到/示例/印章字全走副轨，结构(kind/accent)不动", () => {
  const manifest = {
    ...BASE_V2,
    tags: ["法律", "合同"],
    i18n: {
      en: {
        promise: "One sentence.",
        tags: ["Law", "Contract"],
        domain: ["investing", "risk"],
        audience: ["legal"],
        outcomes: [{ title: "Library", detail: "weekly" }, { title: "Minutes" }],
        examples: [{ title: "Risk", prompt: "Drawdown?" }, { title: "Plan", prompt: "Rebalance." }],
        identity: { mark: { value: "W" } },
      },
    },
  };
  const p = projectManifestForLocale(manifest, "en");
  assert.equal(p.promise, "One sentence.");
  assert.deepEqual(p.tags, ["Law", "Contract"]);
  assert.deepEqual(p.outcomes[0], { title: "Library", detail: "weekly" });
  assert.deepEqual(p.outcomes[1], { title: "Minutes" });
  assert.equal(p.examples[0].prompt, "Drawdown?");
  assert.equal(p.identity.mark.value, "W");
  assert.equal(p.identity.mark.kind, "glyph", "kind 是结构");
  assert.equal(p.identity.accent, "wire", "accent 是结构");
  assert.equal(p.domain.length, 2);
});

test("未覆盖 locale 回落中文主轨（ja 块缺席=逐字节原样）", () => {
  const manifest = { ...BASE_V2, i18n: { en: { promise: "Only english." } } };
  const ja = projectManifestForLocale(manifest, "ja");
  assert.equal(ja.promise, BASE_V2.promise, "ja 回落 zh 承诺");
  // 纯 zh 请求返回同一对象引用——默认路径零拷贝。
  assert.equal(projectManifestForLocale(manifest, "zh"), manifest);
});

test("部分覆盖只动覆盖到的字段；长度不齐的副轨不改主轨（防御）", () => {
  const manifest = {
    ...BASE_V2,
    tags: ["法律", "合同"],
    i18n: { en: { promise: "Covered.", tags: ["only-one-bad-alignment"] } },
  };
  const p = projectManifestForLocale(manifest, "en");
  assert.equal(p.promise, "Covered.");
  assert.deepEqual(p.tags, ["法律", "合同"], "长度不齐→保基轨");
  assert.deepEqual(p.outcomes, BASE_V2.outcomes, "未覆盖字段原样");
});
