import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// The room's read path on web (openspec: add-zhiyu-mobile-clients, task 2.2).
//
// The web page used to own its own EventSource + setRows loop. It now drives the
// SAME state machine the mini-program and the app drive, with an SSE transport
// underneath. "Behaviour unchanged" is the claim, so this guards the two
// behaviours that loop implemented by hand and that a state machine is easy to
// get subtly wrong:
//
//   1. the first screen is the TAIL window — a 1000-row room must not replay
//      from row 1 (that was a real regression once);
//   2. "load earlier" prepends an ADJACENT older window and does not rewind the
//      cursor (so the live stream keeps appending at the bottom).
//
// The gateway is stubbed at the network layer, the same way
// zhiyu-unread-badge.spec.js does: what this guards is the page's contract with
// the state machine, not the gateway's storage (that is
// scripts/test-zhiyu-three-client-parity.mjs).

const ROOM_ID = "zy_e2e_room";
const TOTAL = 500;
const PAGE = 200;

/** The room's rows as the gateway would hand them back: system row + chat. */
function allRows() {
  const rows = [{ seq: 1, kind: "system", content: "", meta: { event: "room_created", by: "owner@x" } }];
  for (let seq = 2; seq <= TOTAL; seq += 1) {
    rows.push({ seq, kind: seq % 2 === 0 ? "human" : "agent", content: `第 ${seq} 行`, senderMemberId: null });
  }
  return rows;
}

const ROOM = {
  room: {
    id: ROOM_ID,
    title: "窗口房",
    ownerEmail: "owner@x",
    status: "active",
    replyCap: null,
    dailyBudgetTurns: null,
    billingMode: "billed",
    lastActivityAt: Date.now(),
    createdAt: Date.now(),
  },
  members: [
    { id: "mem_owner", kind: "user", ref: "owner@x", display: "owner@x", presence: "active", state: "active", onBehalfOf: null },
  ],
  myMemberId: "mem_owner",
};

test("the room opens at the tail, and load-earlier prepends the adjacent window", async ({ page }) => {
  const rows = allRows();
  const windows = [];

  // Anything the page does not explicitly need: an empty, well-formed answer.
  await page.route("**/api/zhiyu/**", (r) => r.fulfill({ json: {} }));

  await page.route(`**/api/zhiyu/rooms/${ROOM_ID}`, (r) => r.fulfill({ json: ROOM }));

  await page.route(`**/api/zhiyu/rooms/${ROOM_ID}/messages**`, async (route) => {
    const url = new URL(route.request().url());
    const tail = url.searchParams.get("tail");
    const before = url.searchParams.get("before");
    windows.push({ tail, before });
    if (tail !== null) {
      await route.fulfill({ json: { messages: rows.slice(-Math.min(Number(tail), PAGE)) } });
      return;
    }
    if (before !== null) {
      const older = rows.filter((m) => m.seq < Number(before)).slice(-PAGE);
      await route.fulfill({ json: { messages: older } });
      return;
    }
    await route.fulfill({ json: { messages: [] } });
  });

  // The live stream: a well-formed but empty SSE response. The browser will
  // reconnect (a closed stream is an error to EventSource); an empty answer each
  // time is exactly what "nothing new" looks like.
  await page.route(`**/api/zhiyu/rooms/${ROOM_ID}/events**`, (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 1000\n\n" }),
  );

  await gotoChat(page);
  await page.goto(`/zhiyu/${ROOM_ID}`);

  const stream = page.getByTestId("zhiyu-stream");
  await expect(stream).toBeVisible({ timeout: 15_000 });

  // 1. The tail window is what rendered: the NEWEST rows are there and row 2 is
  //    not (a full replay would put the beginning of the room on screen).
  await expect(page.getByTestId(`zy-msg-${TOTAL}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("zy-msg-2")).toHaveCount(0);
  const firstTailRow = TOTAL - PAGE + 1; // 301
  await expect(page.getByTestId(`zy-msg-${firstTailRow}`)).toBeVisible();
  await expect(page.getByTestId(`zy-msg-${firstTailRow - 1}`)).toHaveCount(0);

  // 2. Load earlier asks for the adjacent window and prepends it.
  await page.getByTestId("zhiyu-load-earlier").click();
  await expect(page.getByTestId(`zy-msg-${firstTailRow - PAGE}`)).toBeVisible({ timeout: 15_000 });
  const beforeCalls = windows.filter((w) => w.before !== null);
  expect(beforeCalls.length).toBeGreaterThan(0);
  expect(Number(beforeCalls[0].before)).toBe(firstTailRow);

  // The newest row is still rendered: paging back does not disturb the tail.
  await expect(page.getByTestId(`zy-msg-${TOTAL}`)).toBeVisible();
});
