// zhiyu site gates (add-zhiyu-site-roadmap): the homepage may only state
// shippable facts, and every unshipped direction lives on roadmap.html behind
// an explicit "not shipped" banner. These are copy-discipline gates, so they
// check the shipped bytes — not a runtime.
//
// Run: node --test scripts/test-zhiyu-site.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site-zhiyu");
const read = (f) => fs.readFileSync(path.join(site, f), "utf8");

const home = () => read("index.html");
const roadmap = () => read("roadmap.html");

// Capability NAMES that have no production evidence. Generic words like 会议/群聊
// are deliberately absent: the homepage legitimately talks about rooms and IM
// bridges that DO ship. This list only grows by an explicit, reviewable edit.
const UNSHIPPED_CAPABILITY_WORDS = [
  "视频会议",
  "Slack",
  "Zoom",
  "腾讯会议",
  "飞书会议",
  "钉钉",
  "Discord",
];

const STATUS_VALUES = ["shipped", "in-flight", "direction"];

test("homepage still carries the all-shipped covenant sentence", () => {
  assert.ok(home().includes("以上全部在产。不是路线图。"), "covenant sentence present on index.html");
});

test("homepage never names a capability that has not shipped", () => {
  const text = home();
  const hits = UNSHIPPED_CAPABILITY_WORDS.filter((w) => text.includes(w));
  assert.deepEqual(hits, [], `index.html must not name unshipped capabilities (hit: ${hits.join(", ")})`);
});

test("roadmap page exists and opens with the not-shipped banner", () => {
  assert.ok(fs.existsSync(path.join(site, "roadmap.html")), "roadmap.html exists");
  const head = roadmap().slice(0, 4000);
  assert.ok(head.includes("以下为方向，非在产。"), "not-shipped banner sits in the first screen");
});

test("roadmap status markers stay inside the three-value enum", () => {
  const found = [...roadmap().matchAll(/data-status="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(found.length > 0, "roadmap page carries status markers");
  const bad = [...new Set(found)].filter((v) => !STATUS_VALUES.includes(v));
  assert.deepEqual(bad, [], `data-status values outside {${STATUS_VALUES.join(", ")}}: ${bad.join(", ")}`);
});

test("roadmap covers both declared directions", () => {
  const text = roadmap();
  const found = [...text.matchAll(/data-direction="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(found.sort(), ["remote-meeting", "social-im"], "both directions present, nothing else");
});

test("'shipped' markers point at an anchor that really exists on the homepage", () => {
  const text = roadmap();
  // only anchors used as evidence links back into the homepage
  const anchors = [...text.matchAll(/href="index\.html#([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(anchors.length > 0, "at least one shipped direction cites a homepage section");
  const homeText = home();
  for (const id of anchors) {
    assert.ok(homeText.includes(`id="${id}"`), `index.html carries section #${id} cited by the roadmap`);
  }
});

test("'in-flight' markers name work that really exists in the repo", () => {
  // The evidence is checked HERE, never printed on the page: a visitor must not
  // have to read our process vocabulary to trust the label.
  const cards = [...roadmap().matchAll(/<article[^>]*>[\s\S]*?<\/article>/g)].map((m) => m[0]);
  let checked = 0;
  for (const card of cards) {
    const marker = /data-status="in-flight"[^>]*data-work="([^"]+)"/.exec(card)
      ?? /data-work="([^"]+)"[^>]*data-status="in-flight"/.exec(card);
    if (!marker) continue;
    checked += 1;
    assert.ok(
      fs.existsSync(path.join(root, "openspec", "changes", marker[1])),
      `in-flight work "${marker[1]}" has a change directory in the repo`,
    );
  }
  assert.ok(checked > 0, "at least one direction is honestly marked in-flight");
});

test("roadmap copy carries no internal process vocabulary", () => {
  const text = roadmap().replace(/<head>[\s\S]*?<\/head>/g, "");
  const banned = [/openspec/i, /\bchange\b/i, /\bspec\b/i, /\bticket\b/i, /分支名/, /仓库/, /NodePort/, /cheap-\d/];
  const hits = banned.filter((re) => re.test(text)).map(String);
  assert.deepEqual(hits, [], `roadmap is a public face; internal words must not leak: ${hits.join(" | ")}`);
});

test("roadmap makes no date or delivery promise", () => {
  const text = roadmap()
    .replace(/<!--[\s\S]*?-->/g, "") // comments are not copy
    .replace(/<head>[\s\S]*?<\/head>/g, ""); // meta/og description is not visible copy
  const patterns = [
    /20\d\d\s*[-年/.]\s*\d{1,2}/, // 2026-12, 2026年12
    /\bQ[1-4]\b/,
    /本(月|季度)/,
    /下(月|季度|周)/,
    /预计.{0,6}(上线|发布|推出)/,
    /即将(上线|推出|发布)/,
    /敬请期待/,
    /coming soon/i,
  ];
  const hits = patterns.filter((re) => re.test(text)).map(String);
  assert.deepEqual(hits, [], `roadmap must not promise dates/arrival: ${hits.join(" | ")}`);
});

test("gate can actually go red (negative self-check)", () => {
  // Proves the forbidden-word gate is not vacuous: the same predicate that
  // guards index.html rejects a string carrying an unshipped capability name.
  const planted = home() + "我们即将支持视频会议。";
  const hits = UNSHIPPED_CAPABILITY_WORDS.filter((w) => planted.includes(w));
  assert.deepEqual(hits, ["视频会议"], "planted word must trip the gate");
});
