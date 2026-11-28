import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Room voice on web (openspec: add-room-voice-and-catalog, task 4.6).
//
// What this guards is the ROOM's own contract with the speech lane:
//   · every agent message gets a 朗读 control; human rows do not
//   · the auto-read switch is OFF by default
//   · tapping 朗读 synthesises exactly that one message, on demand
//
// The auto-read TIMING (a new row arriving while the switch is on) is pinned by
// source assertion in scripts/test-zhiyu-room-voice-ui.mjs — the repo's standing
// convention for web components (no DOM test runner; e2e anchors the rendered
// surface). Driving it from here would depend on the poll cadence, which is the
// kind of flake this file deliberately avoids.
//
// The gateway is stubbed at the network layer (same posture as
// zhiyu-room-attachment.spec.js). Route counting is the assertion: "no request"
// is proven by a request that never happens, not by a UI flag.

const ROOM_ID = "zy_e2e_voice";

const ROOM = {
  room: { id: ROOM_ID, title: "语音房", ownerEmail: "owner@x", status: "active", replyCap: null, dailyBudgetTurns: null, billingMode: "billed", lastActivityAt: Date.now(), createdAt: Date.now() },
  members: [
    { id: "mem_owner", kind: "user", ref: "owner@x", display: "owner@x", presence: "active", state: "active", onBehalfOf: null },
    { id: "mem_agent", kind: "agent", ref: "packs:a1", display: "值班席", presence: "active", state: "active", onBehalfOf: "owner@x" },
  ],
  myMemberId: "mem_owner",
};

const AGENT_ROW = { seq: 2, kind: "agent", senderMemberId: "mem_agent", content: "这是我的答复。", meta: null, createdAt: Date.now() };
const HUMAN_ROW = { seq: 1, kind: "human", senderMemberId: "mem_owner", content: "你好", meta: null, createdAt: Date.now() };

async function mountRoom(page, { rows = [AGENT_ROW], speechRoutes = null } = {}) {
  await page.route("**/api/zhiyu/**", (r) => r.fulfill({ json: {} }));
  await page.route(`**/api/zhiyu/rooms/${ROOM_ID}`, (r) => r.fulfill({ json: ROOM }));
  await page.route(`**/api/zhiyu/rooms/${ROOM_ID}/messages**`, (r) => r.fulfill({ json: { messages: rows } }));
  await page.route(`**/api/zhiyu/rooms/${ROOM_ID}/events**`, (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 1000\n\n" }),
  );
  // The speech endpoint: count every call so "no synthesis" is provable.
  await page.route(`**/api/zhiyu/rooms/${ROOM_ID}/messages/*/speech`, async (route) => {
    speechRoutes?.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, headers: { "content-type": "audio/mpeg", "x-voice-used": "tencent-tts:101001" }, body: Buffer.from("AUDIO") });
  });

  await gotoChat(page);
  await page.goto(`/zhiyu/${ROOM_ID}`);
  await expect(page.getByTestId("zhiyu-stream")).toBeVisible({ timeout: 15_000 });
}

test("the auto-read switch is OFF by default and the agent row gets a 朗读 control @live", async ({ page }) => {
  const speech = [];
  await mountRoom(page, { speechRoutes: speech });
  await expect(page.getByTestId("zy-speak-2")).toBeVisible();
  await expect(page.getByTestId("zhiyu-voice-toggle")).toHaveAttribute("data-state", "off");
  expect(speech).toHaveLength(0);
});

test("a human row gets NO 朗读 control", async ({ page }) => {
  await mountRoom(page, { rows: [HUMAN_ROW] });
  await expect(page.getByTestId("zy-speak-1")).toHaveCount(0);
});

test("tapping 朗读 synthesises exactly that one message on demand @live", async ({ page }) => {
  const speech = [];
  await mountRoom(page, { speechRoutes: speech });
  await page.getByTestId("zy-speak-2").click();
  await expect.poll(() => speech.length).toBe(1);
  expect(speech[0]).toMatchObject({ mode: "on_demand" });
});
