// Unit tests for the home-showcase helpers (openspec: redesign-mp-home).
// Same pattern as markdown.test.mjs: node --test importing the .ts source.

import test from "node:test";
import assert from "node:assert/strict";
import { showcaseCards, recentStrip, relativeTime } from "./showcase.ts";

test("showcase: general card pinned first when catalog agents exist", () => {
  const cards = showcaseCards([
    { id: "local", type: "agent-local" },
    { id: "pack-contract-reviewer", type: "agent-remote", mode: "chat", name: "合同审查官", description: "合同风险审查" },
  ]);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].id, "local");
  assert.equal(cards[0].general, true);
  assert.equal(cards[1].name, "合同审查官");
  assert.equal(cards[1].description, "合同风险审查");
});

test("showcase: roster-empty fallback yields NO grid (prompts-only layout)", () => {
  assert.deepEqual(showcaseCards([]), []);
  assert.deepEqual(showcaseCards([{ id: "local", type: "agent-local" }]), []);
});

test("showcase: cards carry verbatim names and blank-safe descriptions", () => {
  const [general, card] = showcaseCards([
    { id: "local", type: "agent-local" },
    { id: "x", type: "agent-remote", mode: "chat" },
  ]);
  assert.ok(general.description.length > 0);
  assert.equal(card.name, "x");
  assert.equal(card.description, "");
});

test("recent strip: newest first, current session excluded, capped at 3", () => {
  const mk = (id, t) => ({ id, title: `s-${id}`, updatedAt: t });
  const now = Date.now();
  const strip = recentStrip(
    [mk("cur", now), mk("a", now - 1), mk("b", now - 2), mk("c", now - 3), mk("d", now - 4)],
    "cur",
  );
  assert.deepEqual(strip.map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual(recentStrip([], null), []);
});

test("relative time buckets and tolerates garbage", () => {
  const now = Date.now();
  assert.equal(relativeTime(now - 10_000), "刚刚");
  assert.equal(relativeTime(now - 5 * 60_000), "5 分钟前");
  assert.equal(relativeTime(now - 3 * 3_600_000), "3 小时前");
  assert.equal(relativeTime(now - 2 * 86_400_000), "2 天前");
  assert.equal(relativeTime(undefined), "");
  assert.equal(relativeTime("not-a-date"), "");
});
