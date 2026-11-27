// @live meeting-capture — the meeting lane against production (add-meeting-capture 6.2 的软件侧).
//
// What this proves that the pod-level greps cannot: a REAL logged-in user
// opens a meeting in a real room, joins it (which claims their one stream),
// reads a face that says the ordering is arrival-based, ends it, and is then
// refused at the door. What it deliberately does NOT prove is the audio half —
// two phones, two microphones, two people — which stays manual.
//
// Credentials come from the environment: PAAS_TEST_IDENTIFIER,
// PAAS_TEST_PASSWORD. The test creates ONE room and ends it in teardown.

import { test, expect } from "@playwright/test";
import { LIVE_SERVICE_URL, pinLocaleEn } from "./live-helpers.js";

const IDENTIFIER = process.env.PAAS_TEST_IDENTIFIER || "";
const PASSWORD = process.env.PAAS_TEST_PASSWORD || "";

// Logto 的表单不是每次都在：同一个账号在几秒内从两个全新上下文连登时，
// 点完 SSO 偶发停在空白页（identifier 输入框 30s 不出现）。这不是产品路径，
// 是夹具的脆弱点，所以给它一次重来——重来仍不出现才让用例红。
async function logtoSignIn(page) {
  await page.goto(`${LIVE_SERVICE_URL}/`, { waitUntil: "domcontentloaded" });
  const appOrigin = new URL(page.url()).origin;
  const sso = page.getByTestId("sso-login");
  await sso.waitFor({ state: "visible", timeout: 30_000 });
  await sso.click();
  const identifier = page.locator('input[name="identifier"]').first();
  try {
    await identifier.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    await page.goto(`${LIVE_SERVICE_URL}/`, { waitUntil: "domcontentloaded" });
    await sso.waitFor({ state: "visible", timeout: 30_000 });
    await sso.click();
    await identifier.waitFor({ state: "visible", timeout: 30_000 });
  }
  for (const [field, value] of [["identifier", IDENTIFIER], ["password", PASSWORD]]) {
    const input = page.locator(`input[name="${field}"]`).first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await input.fill(value);
    await page.locator('button[name="submit"]').first().click();
  }
  // Consent screen races the app shell: only one of them appears.
  const status = page.getByTestId("status-text");
  const consent = page.locator('button[name="submit"]').first();
  await Promise.race([
    status.waitFor({ state: "visible", timeout: 60_000 }),
    consent.waitFor({ state: "visible", timeout: 60_000 }),
  ]).catch(() => {});
  if (new URL(page.url()).origin !== appOrigin) {
    await consent.click({ timeout: 30_000 }).catch(() => {});
  }
  await expect(status).toHaveText("Connected", { timeout: 60_000 });
}

test("a real meeting: open → join twice → honest face → ended shuts the door @live", async ({ browser }) => {
  test.skip(!IDENTIFIER || !PASSWORD, "PAAS_TEST_IDENTIFIER/PAAS_TEST_PASSWORD required");
  test.setTimeout(180_000);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await pinLocaleEn(page);
  await logtoSignIn(page);
  await page.goto(`${LIVE_SERVICE_URL}/zhiyu`, { waitUntil: "domcontentloaded" });

  let roomId = null;
  try {
    const out = await page.evaluate(async () => {
      const call = async (method, p, body) => {
        const r = await fetch(p, {
          method,
          headers: body === undefined ? {} : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      };
      const room = await call("POST", "/api/zhiyu/rooms", { title: "E2E 会议录音（自动清理）" });
      const roomId = room.body?.room?.id ?? null;
      if (!roomId) return { room, failedAt: "room" };
      const opened = await call("POST", `/api/zhiyu/rooms/${roomId}/meetings`, { title: "E2E 双人会议" });
      const meetingId = opened.body?.meeting?.id ?? null;
      if (!meetingId) return { room, roomId, opened, failedAt: "meeting" };
      const join1 = await call("POST", `/api/zhiyu/meetings/${meetingId}/join`, {});
      const join2 = await call("POST", `/api/zhiyu/meetings/${meetingId}/join`, {});
      const view = await call("GET", `/api/zhiyu/meetings/${meetingId}`);
      const ended = await call("POST", `/api/zhiyu/meetings/${meetingId}/end`, {});
      const lateJoin = await call("POST", `/api/zhiyu/meetings/${meetingId}/join`, {});
      return { room, roomId, opened, meetingId, join1, join2, view, ended, lateJoin };
    });

    roomId = out.roomId ?? null;

    // ① 开会：会议是 open 的，且带上发起人与房间
    expect(out.failedAt, `failed at ${out.failedAt}: ${JSON.stringify(out).slice(0, 300)}`).toBeUndefined();
    expect(out.opened.status).toBe(201);
    expect(out.opened.body.meeting.status).toBe("open");
    expect(out.opened.body.meeting.roomId).toBe(out.roomId);

    // ② 加入是幂等的：同一个人连加两次只有一路（一人一路是这个能力的核心）
    expect(out.join1.status).toBe(200);
    expect(out.join1.body.created).toBe(true);
    expect(out.join2.status).toBe(200);
    expect(out.join2.body.created).toBe(false);
    expect(out.join2.body.participant.memberRef).toBe(out.join1.body.participant.memberRef);

    // ③ 读面如实：顺序口径必须自报 arrival，四个计数位齐全
    expect(out.view.status).toBe(200);
    expect(out.view.body.orderBasis).toBe("arrival");
    expect(out.view.body.participants.length).toBeGreaterThanOrEqual(1);
    expect(typeof out.view.body.delivered).toBe("number");
    expect(typeof out.view.body.awaitingConfirmation).toBe("number");

    // ④ 结束后门是关的（硬门，不是提示）
    expect(out.ended.status).toBe(200);
    expect(out.ended.body.meeting.status).toBe("ended");
    expect(out.lateJoin.status).toBe(409);
    expect(out.lateJoin.body.code).toBe("meeting_not_open");
  } finally {
    // Teardown ALWAYS: a failed run must not leave a live room behind.
    if (roomId) {
      await page
        .evaluate((id) => fetch(`/api/zhiyu/rooms/${id}/end`, { method: "POST" }), roomId)
        .catch(() => {});
    }
    await ctx.close();
  }
});

// ── The UI half: the panel is wired, not merely present ─────────────────────
// The API test above goes through fetch(). This one clicks the same affordances
// a person does, because "the endpoint answers" and "the button is connected to
// it" are different failures — and the second one only exists on the client.
test("the meeting panel is clickable end to end (open → view → join → end) @live", async ({ browser }) => {
  test.skip(!IDENTIFIER || !PASSWORD, "PAAS_TEST_IDENTIFIER/PAAS_TEST_PASSWORD required");
  test.setTimeout(180_000);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await pinLocaleEn(page);
  await logtoSignIn(page);

  // A room to host the meeting. Created through the API so the test spends its
  // clicks on the panel rather than on three pages of room setup.
  const room = await page.evaluate(async () => {
    const r = await fetch("/api/zhiyu/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "E2E 会议面板（自动清理）" }),
    });
    const j = await r.json().catch(() => null);
    return { status: r.status, id: j?.room?.id ?? null };
  });
  expect(room.status, "room created for the UI test").toBeLessThan(300);
  expect(room.id).toBeTruthy();

  try {
    await page.goto(`${LIVE_SERVICE_URL}/zhiyu/${room.id}`, { waitUntil: "domcontentloaded" });
    const panel = page.getByTestId("zhiyu-meeting-panel");
    await expect(panel, "会议面板挂在房间页上").toBeVisible({ timeout: 30_000 });

    // ① 发起：填标题 → 点开会 → 出现「结束」而不是「发起」
    await page.getByTestId("zhiyu-meeting-title").fill("E2E 双人会议");
    await page.getByTestId("zhiyu-meeting-open").click();
    await expect(page.getByTestId("zhiyu-meeting-join"), "开会后出现「加入」").toBeVisible({ timeout: 20_000 });

    // ② 视图：顺序口径必须自报「按到达」，不是默默省略
    await expect(page.getByTestId("zhiyu-meeting-view")).toBeVisible({ timeout: 20_000 });
    // pinLocaleEn 把界面切成英文，所以断言接受两种语言的同一句话——
    // 要守的是「它自报了顺序口径」，不是「它用中文」。
    await expect(page.getByTestId("zhiyu-meeting-order")).toContainText(/到达|Arrival order/i);

    // ③ 加入：点一次之后，自己的那一行出现在参会名单里
    await page.getByTestId("zhiyu-meeting-join").click();
    await expect(panel.locator('[data-testid^="zhiyu-meeting-participant-"]').first()).toBeVisible({
      timeout: 20_000,
    });

    // ④ 结束：按钮消失，换成「已结束」
    await page.getByTestId("zhiyu-meeting-end").click();
    await expect(page.getByTestId("zhiyu-meeting-ended"), "结束后标为已结束").toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("zhiyu-meeting-join")).toHaveCount(0);
  } finally {
    await page
      .evaluate((id) => fetch(`/api/zhiyu/rooms/${id}/end`, { method: "POST" }), room.id)
      .catch(() => {});
    await ctx.close();
  }
});

// ── The whole point: a second context discovers a meeting it never opened ───
// Before add-meeting-discovery this could not pass: the panel only knew about a
// meeting created in THIS page, so the other context rendered nothing at all.
//
// Note what "second person" can and cannot mean here. The fixture has one
// account, and joining is keyed on the person (`zy_meeting_participants` PK is
// (meeting_id, member_ref)) — so two contexts of the same account are ONE
// person, exactly as designed (D3, "one person, one stream"). What these two
// contexts therefore prove, live and against production:
//   • B, with no local state, discovers the open meeting and gets the
//     NEW-PERSON branch (`participant: null` → 加入 button, not 已加入);
//   • clicking 加入 in B succeeds and that person's stream appears;
//   • A joining afterwards from its own page is idempotent — still one row.
// The genuinely-two-accounts half lives in scripts/test-zhiyu-meeting-store.mjs
// ("1.1 the open-meeting face is truthful"), where two distinct members are
// seeded; a second production account is an ops prerequisite, not a code gap.
test("a second context discovers the open meeting and claims its stream @live", async ({ browser }) => {
  test.skip(!IDENTIFIER || !PASSWORD, "PAAS_TEST_IDENTIFIER/PAAS_TEST_PASSWORD required");
  test.setTimeout(240_000);

  // Context A: open a room and a meeting. Opening a meeting is NOT attending
  // it — the creator claims a stream only by joining, same as everyone else.
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  await pinLocaleEn(a);
  await logtoSignIn(a);
  const setup = await a.evaluate(async () => {
    const call = async (m, p, b) => {
      const r = await fetch(p, { method: m, headers: b ? { "Content-Type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const room = await call("POST", "/api/zhiyu/rooms", { title: "E2E 发现（自动清理）" });
    const roomId = room.body?.room?.id ?? null;
    if (!roomId) return { failedAt: "room" };
    const opened = await call("POST", `/api/zhiyu/rooms/${roomId}/meetings`, { title: "E2E 发现会议" });
    return { roomId, meetingId: opened.body?.meeting?.id ?? null, opened: opened.status };
  });
  expect(setup.failedAt, JSON.stringify(setup)).toBeUndefined();
  expect(setup.opened).toBe(201);

  const ctxB = await browser.newContext();
  try {
    // Context B: different session, no local meeting state. Everything it knows
    // must come from the server.
    const b = await ctxB.newPage();
    await pinLocaleEn(b);
    await logtoSignIn(b);
    await b.goto(`${LIVE_SERVICE_URL}/zhiyu/${setup.roomId}`, { waitUntil: "domcontentloaded" });

    const panel = b.getByTestId("zhiyu-meeting-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    // The discovery itself: B never opened this meeting, yet it sees it running.
    await expect(b.getByTestId("zhiyu-meeting-running"), "第二个人看得到这场会议").toBeVisible({ timeout: 30_000 });
    await expect(b.getByTestId("zhiyu-meeting-view")).toBeVisible({ timeout: 20_000 });

    // New-person branch: this person has NOT joined, so the panel must offer
    // 加入 rather than claim they are already in.
    await expect(b.getByTestId("zhiyu-meeting-join"), "还没加入的人才看得到加入按钮").toBeVisible({ timeout: 20_000 });
    await expect(b.getByTestId("zhiyu-meeting-joined")).toHaveCount(0);

    await b.getByTestId("zhiyu-meeting-join").click();
    await expect(b.getByTestId("zhiyu-meeting-joined"), "加入后显示已加入而非再邀请").toBeVisible({ timeout: 20_000 });

    // B's own stream is now on the read face — one row, owned by this person.
    const afterB = await a.evaluate(async (id) => {
      const r = await fetch(`/api/zhiyu/meetings/${id}`);
      const j = await r.json().catch(() => null);
      return { status: r.status, rows: (j?.participants ?? []).map((p) => p.memberRef) };
    }, setup.meetingId);
    expect(afterB.status).toBe(200);
    expect(afterB.rows.length, "B 加入后正好一路").toBe(1);

    // One person, one stream: A (the same person, other context) joining again
    // must be idempotent — no second row, created === false.
    const aJoin = await a.evaluate(async (id) => {
      const r = await fetch(`/api/zhiyu/meetings/${id}/join`, { method: "POST" });
      const j = await r.json().catch(() => null);
      return { status: r.status, created: j?.created };
    }, setup.meetingId);
    expect(aJoin.status).toBe(200);
    expect(aJoin.created, "同一个人在第二个上下文加入是幂等的").toBe(false);
    const afterA = await a.evaluate(async (id) => {
      const r = await fetch(`/api/zhiyu/meetings/${id}`);
      const j = await r.json().catch(() => null);
      return (j?.participants ?? []).length;
    }, setup.meetingId);
    expect(afterA, "仍然只有一路，不因第二个上下文多出一条").toBe(1);
  } finally {
    await a.evaluate((id) => fetch(`/api/zhiyu/rooms/${id}/end`, { method: "POST" }), setup.roomId).catch(() => {});
    await ctxA.close();
    await ctxB.close();
  }
});
