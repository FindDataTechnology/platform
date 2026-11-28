#!/usr/bin/env node
// ── 萬星词元 usage attribution (run-card-bridge 3.3) ────────────────────────
//
// USD comes from sub2api's actual_cost, attributed by card execution window.
// Overlap is unknown, never a double count. Run: node --test scripts/test-sub2api-usage.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attributeUsage,
  cardWindow,
  readUsageWindow,
  usageEndpoint,
} from "../server/sub2api-usage.js";

const card = (id, times) => ({ id, history: times.map((time) => ({ time })), flow: {} });

test("endpoint is derived from the LLM origin", () => {
  assert.equal(usageEndpoint("https://token.example.com/v1"), "https://token.example.com/api/v1/usage");
});

test("a card window spans its history times", () => {
  const w = cardWindow(card("a", ["2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z"]));
  assert.equal(w.start, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(w.end, Date.parse("2026-01-01T00:05:00.000Z"));
});

test("rows are attributed to the one card whose window contains them", () => {
  const cards = [
    card("a", ["2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z"]),
    card("b", ["2026-01-01T00:10:00.000Z", "2026-01-01T00:11:00.000Z"]),
  ];
  const rows = [
    { created_at: "2026-01-01T00:00:30.000Z", actual_cost: 0.1 },
    { created_at: "2026-01-01T00:10:30.000Z", actual_cost: 0.2 },
    { created_at: "2026-01-01T02:00:00.000Z", actual_cost: 9 },
  ];
  const got = attributeUsage(rows, cards);
  assert.equal(got.get("a").usd, 0.1);
  assert.equal(got.get("b").usd, 0.2);
  assert.equal(got.size, 2);
});

test("an overlapping row is ambiguous and not attributed", () => {
  const cards = [
    card("a", ["2026-01-01T00:00:00.000Z", "2026-01-01T00:10:00.000Z"]),
    card("b", ["2026-01-01T00:05:00.000Z", "2026-01-01T00:20:00.000Z"]),
  ];
  const got = attributeUsage([{ created_at: "2026-01-01T00:07:00.000Z", actual_cost: 0.3 }], cards);
  assert.equal(got.get("a").ambiguous, true);
  assert.equal(got.get("a").usd, 0);
  assert.equal(got.get("b").ambiguous, true);
});

test("readUsageWindow authenticates, pages, and filters to the exact window", async () => {
  let seenUrl = null;
  let seenAuth = null;
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenAuth = init.headers.authorization;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          items: [
            { created_at: "2026-01-01T00:00:30.000Z", actual_cost: 0.1 },
            { created_at: "2026-01-01T01:00:00.000Z", actual_cost: 0.2 },
          ],
          pages: 1,
        };
      },
    };
  };
  const rows = await readUsageWindow({
    start: Date.parse("2026-01-01T00:00:00.000Z"),
    end: Date.parse("2026-01-01T00:01:00.000Z"),
    env: { LLM_BASE_URL: "https://token.example.com/v1", LLM_API_KEY: "sk-test" },
    fetchImpl,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actual_cost, 0.1);
  assert.equal(seenAuth, "Bearer sk-test");
  assert.match(seenUrl, /\/api\/v1\/usage\?/);
  assert.match(seenUrl, /start_date=2026-01-01/);
});

test("a non-200 usage read throws (caller then reports unknown)", async () => {
  await assert.rejects(
    () => readUsageWindow({
      start: 0,
      end: 1000,
      env: { LLM_BASE_URL: "https://token.example.com/v1", LLM_API_KEY: "sk" },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    }),
    /503/,
  );
});
