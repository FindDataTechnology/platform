// @live meeting-room — the audio room page against the deployed entry
// (add-ai-native-meeting 3.2).
//
// What this proves that curl cannot: a real signed-in user opens a meeting, the
// UI offers a way INTO the audio room, and that page actually completes a
// LiveKit signalling handshake through the public edge.
//
// The three failures this test exists to catch, all of which shipped green
// unit tests and a working backend on 2026-11-24:
//   • the deployment's anonymous /api/config (answered by the GATEWAY, not the
//     cell) did not carry `meeting` — so config.meeting was null, the
//     /meetings/:id route was never registered, and the feature was a dead
//     click. A curl of the cell's own /api/config looked fine.
//   • the entry button did not exist at all: the route was reachable only by
//     typing the URL.
//   • /livekit fell through to the SPA handler on one of the two live hostnames
//     and answered 200 with the app shell — which a status-code-only check reads
//     as success. The assertion below is on the PAGE's state, not on HTTP 200.
//
// Credentials come from the environment: PAAS_TEST_IDENTIFIER,
// PAAS_TEST_PASSWORD. Creates ONE room and ends it in teardown.

import { test, expect } from "@playwright/test";
import { LIVE_SERVICE_URL, logtoSignIn, pinLocaleEn } from "./live-helpers.js";

const IDENTIFIER = process.env.PAAS_TEST_IDENTIFIER || "";
const PASSWORD = process.env.PAAS_TEST_PASSWORD || "";

test("a real user enters the audio room and the signalling connects @live", async ({ browser }) => {
  test.skip(!IDENTIFIER || !PASSWORD, "PAAS_TEST_IDENTIFIER/PAAS_TEST_PASSWORD required");
  test.setTimeout(180_000);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await pinLocaleEn(page);
  await logtoSignIn(page, { identifier: IDENTIFIER, password: PASSWORD });

  let roomId = null;
  try {
    await page.goto(`${LIVE_SERVICE_URL}/zhiyu`, { waitUntil: "domcontentloaded" });

    // ── ① the boot config the BROWSER sees must carry meeting ───────────────
    // Deliberately read through the page (a browser fetch, same-origin), not
    // from the cell: the defect this guards was that the two entrypoints
    // disagreed and only the browser's path mattered.
    const cfg = await page.evaluate(async () => {
      const r = await fetch("/api/config", { credentials: "same-origin" });
      return r.json();
    });
    expect(cfg.meeting, `gateway /api/config has no meeting field: ${JSON.stringify(cfg).slice(0, 200)}`).toBeTruthy();
    expect(cfg.meeting.enabled).toBe(true);
    expect(typeof cfg.meeting.livekitUrl).toBe("string");

    // ── ② open + join a meeting, then reach the audio room ──────────────────
    const out = await page.evaluate(async () => {
      const call = async (method, p, body) => {
        const r = await fetch(p, {
          method,
          headers: body === undefined ? {} : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      };
      const room = await call("POST", "/api/zhiyu/rooms", { title: "E2E 语音会议（自动清理）" });
      const roomId = room.body?.room?.id ?? null;
      if (!roomId) return { room, failedAt: "room" };
      const opened = await call("POST", `/api/zhiyu/rooms/${roomId}/meetings`, { title: "E2E 语音会议" });
      const meetingId = opened.body?.meeting?.id ?? null;
      if (!meetingId) return { room, roomId, opened, failedAt: "meeting" };
      const joined = await call("POST", `/api/zhiyu/meetings/${meetingId}/join`, {});
      return { roomId, meetingId, joined };
    });
    roomId = out.roomId ?? null;
    expect(out.failedAt, `failed at ${out.failedAt}: ${JSON.stringify(out).slice(0, 300)}`).toBeUndefined();
    expect(out.joined.status).toBe(200);

    // ── ③ the UI offers a way in (the route existing is not enough) ─────────
    // Before this button the /meetings/:id route was reachable only by typing
    // the URL: every backend piece worked and no user could find the room.
    await page.goto(`${LIVE_SERVICE_URL}/zhiyu/${encodeURIComponent(out.roomId)}`, {
      waitUntil: "domcontentloaded",
    });
    // The panel discovers the open meeting and the caller's own participant row
    // asynchronously on mount (two round-trips). The button only renders once
    // `mine` resolves, so waiting for the panel first is what makes the 30s
    // budget below measure the product rather than a race in this test.
    await page.getByTestId("zhiyu-meeting-panel").waitFor({ state: "visible", timeout: 30_000 });
    const enter = page.getByTestId("zhiyu-meeting-enter-audio");
    await enter.waitFor({ state: "visible", timeout: 45_000 });
    await enter.click();
    await expect(page).toHaveURL(new RegExp(`/meetings/${out.meetingId}`), { timeout: 15_000 });

    // ── ④ the room page completes a LiveKit handshake through the public edge
    const shell = page.getByTestId("meeting-room");
    await shell.waitFor({ state: "visible", timeout: 30_000 });
    // connected = room.connect() resolved. "error" is the honest failure state
    // and is asserted on explicitly so a regression reports its own message
    // instead of timing out as a missing testid.
    await expect(shell).toHaveAttribute("data-state", "connected", { timeout: 45_000 });
    await expect(page.getByTestId("meeting-error")).toHaveCount(0);
    // The roster proves we are actually IN the room, not merely connected to a
    // socket that nobody joined. The identity is the signed-in email (the token
    // route mints it from `auth.user.email`), so read it rather than hardcoding
    // a person: this spec must not break when the test account changes.
    const me = await page.evaluate(async () => {
      const r = await fetch("/api/auth/me", { credentials: "same-origin" });
      const j = await r.json().catch(() => null);
      return String(j?.email || "").toLowerCase();
    });
    if (me) await expect(page.getByTestId(`meeting-peer-${me}`)).toBeVisible({ timeout: 15_000 });
  } finally {
    // Best effort: end the room so the next run starts clean. A meeting left
    // open keeps a stream bound and the seat in a meeting face.
    if (roomId) {
      await page
        .evaluate((id) => fetch(`/api/zhiyu/rooms/${id}/end`, { method: "POST" }), roomId)
        .catch(() => {});
    }
    await ctx.close();
  }
});
