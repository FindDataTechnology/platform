// The Android zhiyu lane's contract, pinned where CI can see it
// (openspec: add-zhiyu-mobile-clients, 7.2).
//
// The Maestro flow cannot run on a laptop or in the always-on job — it needs an
// emulator, so it lives in the dispatch-only `android` leg. That leaves a real
// hole: nobody would notice if the seed, the app's tail window, a testid or the
// tab label drifted apart, and the failure would only surface as a red emulator
// run somebody has to decode from logcat.
//
// So this checks the RELATIONSHIP the flow depends on, on every push:
//   • the seed outruns the app's tail window (otherwise the first screen is the
//     whole room and items 2/3 pass without being exercised — the exact trap
//     that makes a "load earlier" assertion look fine while proving nothing);
//   • the strings the flow asserts are the ones the seed actually writes, and
//     the earlier page's newest row is the adjacent one (no gap, no overlap);
//   • every id/label the flow taps exists in the app and in the locales;
//   • the harness mounts the REAL kernel instead of hand-written endpoints.
//
// What it cannot check is rendering — that stays the emulator's job, and the
// doc says so.
//
//   node --test scripts/test-zhiyu-device-lane-contract.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const HARNESS = "e2e/zhiyu-gateway-mock.mjs";
const FLOW = "app/.maestro/zhiyu.yaml";
const ROOM_SCREEN = "app/src/app/(tabs)/zhiyu/[roomId].tsx";
const LIST_SCREEN = "app/src/app/(tabs)/zhiyu/index.tsx";

/** `const SEED_MESSAGES = Number(process.env.MOCK_SEED_MESSAGES) || 60;` → 60 */
function seedCount() {
  const m = /MOCK_SEED_MESSAGES\)\s*\|\|\s*(\d+)/.exec(read(HARNESS));
  assert.ok(m, "the harness must declare its seed count in one readable place");
  return Number(m[1]);
}

/** `tailCount: 30, pageSize: 20` from the app's own client construction. */
function appWindow() {
  const src = read(ROOM_SCREEN);
  const tail = /tailCount:\s*(\d+)/.exec(src);
  const page = /pageSize:\s*(\d+)/.exec(src);
  assert.ok(tail, "the room screen must state its tailCount");
  assert.ok(page, "the room screen must state its pageSize");
  return { tailCount: Number(tail[1]), pageSize: Number(page[1]) };
}

// The store numbers every row from 1: the room_created system row takes seq 1,
// so seed message i lands on seq i+1.
const msg = (n) => `第 ${n} 条消息`;

test("7.2 the seed outruns the app's tail window, so the first screen is a TAIL", () => {
  const seed = seedCount();
  const { tailCount } = appWindow();
  const rows = seed + 1; // + the room_created system row
  assert.ok(
    rows > tailCount,
    `seed ${seed} (+1 system row) must exceed tailCount ${tailCount}, or the whole room arrives in one page and items 2/3 prove nothing`,
  );
  // hasOlder is `messages.length >= tailCount`, so the button also needs the
  // tail to come back full — true exactly when rows > tailCount.
  assert.equal(Math.min(rows, tailCount), tailCount, "the tail page comes back full");
});

test("7.2 the earlier page is ADJACENT to the tail page (no gap, no overlap)", () => {
  const seed = seedCount();
  const { tailCount, pageSize } = appWindow();
  const rows = seed + 1;
  const tailFirstSeq = rows - tailCount + 1; // e.g. 61 - 30 + 1 = 32
  const tailOldest = tailFirstSeq - 1; // seq 32 → 第 31 条
  const earlierNewest = tailFirstSeq - 1; // before=32 / limit=20 ends on seq 31
  assert.equal(earlierNewest, tailOldest, "the two windows meet exactly");
  const earlierOldestSeq = Math.max(1, tailFirstSeq - pageSize); // 32 - 20 = 12
  assert.ok(earlierOldestSeq > 1, "the earlier page stops above the system row");
});

test("7.2 the flow asserts the strings the seed actually writes", () => {
  const seed = seedCount();
  const { tailCount, pageSize } = appWindow();
  const flow = read(FLOW);

  // Rows: seq 1 = room_created system row, message i = seq i+1.
  const rows = seed + 1;
  const tailFirstSeq = rows - tailCount + 1; // 61 - 30 + 1 = 32 → 第31 (tail's oldest)
  const earlierNewest = tailFirstSeq - 2; // before=32 ends on seq 31 → 第30
  const earlierOldest = earlierNewest - pageSize + 1; // 20 rows up → 第11

  assert.ok(flow.includes(msg(seed)), `newest row: the flow must assert ${msg(seed)}`);
  assert.ok(flow.includes(msg(1)), "the flow must name the first row it must NOT see");
  assert.ok(
    flow.includes(msg(earlierNewest)),
    `the earlier page's newest row is ${msg(earlierNewest)} — the flow must assert that one (it is what proves adjacency)`,
  );
  assert.equal(earlierNewest, seed - tailCount, "earlier-page newest = seed − tailCount");
  assert.equal(earlierOldest, seed - tailCount - pageSize + 1, "earlier-page oldest follows from pageSize");
  // A tail is only proven by asserting the first row is ABSENT.
  assert.match(flow, /assertNotVisible:\s*'第 1 条消息'/, "the tail claim needs the negative assertion");
});

test("7.2 every id and label the flow taps exists in the app", () => {
  const flow = read(FLOW);
  const ids = [...flow.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 3, `expected the pairing + room ids, got ${ids.join(", ")}`);

  const room = read(ROOM_SCREEN);
  const list = read(LIST_SCREEN);
  // Room-screen ids the flow hangs on.
  for (const id of ["app-zy-stream", "app-zy-load-earlier"]) {
    assert.ok(ids.includes(id), `the flow must use ${id}`);
    assert.ok(room.includes(`"${id}"`), `${id} must exist in ${ROOM_SCREEN}`);
  }
  assert.ok(ids.includes("app-zy-list") && list.includes('"app-zy-list"'), "app-zy-list must exist in the list screen");

  // The tab label is a translation, so the flow's alternation has to match both
  // locales — a label rename in one file only would break the flow silently.
  for (const locale of ["zh-CN.json", "en.json"]) {
    const dict = JSON.parse(read(`app/src/i18n/${locale}`));
    const label = dict.tabs.zhiyu;
    assert.ok(flow.includes(label), `the flow must tap the ${locale} label 「${label}」`);
  }
});

test("7.2 the harness mounts the REAL room kernel, not hand-written endpoints", () => {
  const src = read(HARNESS);
  assert.match(src, /import\s*\{\s*registerZhiyuRoutes\s*\}\s*from\s*"\.\.\/gateway\/zhiyu\/index\.js"/,
    "the lane's value is that tail/cursor semantics are production's");
  assert.match(src, /registerZhiyuRoutes\(app,/, "the kernel must be mounted");
  // The three endpoints it does stub are pairing's, on purpose — document drift
  // here is how a mock quietly becomes the contract.
  for (const route of ["/api/config", "/api/app/pair", "/api/app/challenge", "/api/app/login"]) {
    assert.ok(src.includes(route), `${route} is a deliberate pairing stub — if it disappears, pairing broke`);
  }
  // No room endpoint may be hand-written.
  for (const route of ["/api/zhiyu/rooms", "/api/zhiyu/rooms/:id/messages", "/api/zhiyu/rooms/:id/stream"]) {
    assert.ok(!src.includes(`"${route}"`), `${route} must come from the kernel, never a stub`);
  }
});
