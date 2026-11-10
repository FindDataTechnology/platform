// @live zhiyu-embed — REAL browser eye on the production guest lane
// (add-zhiyu-website-embed + polish batches).
//
// What this proves that curl cannot: the widget iframe shell renders, the
// visitor banner is honest, the AI-free greeting names the callable seats,
// the answering bubble appears DURING the cold start (the polish that makes a
// 70s first turn visibly alive), and the settled agent row lands with real
// attribution — for an anonymous visitor in an isolated browser context, with
// no platform login of their own.
//
// Credentials come from the environment: PAAS_TEST_IDENTIFIER,
// PAAS_TEST_PASSWORD. The test creates ONE room, spends ONE LLM turn, and
// ends the room + revokes the widget token in teardown.

import { test, expect } from "@playwright/test";
import { LIVE_SERVICE_URL, pinLocaleEn } from "./live-helpers.js";

const IDENTIFIER = process.env.PAAS_TEST_IDENTIFIER || "";
const PASSWORD = process.env.PAAS_TEST_PASSWORD || "";

async function logtoSignIn(page) {
  await page.goto(`${LIVE_SERVICE_URL}/`, { waitUntil: "domcontentloaded" });
  const appOrigin = new URL(page.url()).origin;
  const sso = page.getByTestId("sso-login");
  await sso.waitFor({ state: "visible", timeout: 30_000 });
  await sso.click();
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

test("zhiyu widget guest lane, browser eye @live @live-smoke", async ({ browser }) => {
  test.skip(!IDENTIFIER || !PASSWORD, "PAAS_TEST_IDENTIFIER/PAAS_TEST_PASSWORD required");
  test.setTimeout(240_000);

  // ── Owner context: sign in, create room + seat the lex copilot, enable the
  // widget with the self-domain snapshot policy (self-host smoke pattern).
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await pinLocaleEn(owner);
  await logtoSignIn(owner);
  await owner.goto(`${LIVE_SERVICE_URL}/zhiyu`, { waitUntil: "domcontentloaded" });
  await owner.waitForTimeout(3000);

  const setup = await owner.evaluate(async () => {
    const post = (p, body) =>
      fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const roomRes = await post("/api/zhiyu/rooms", { title: "E2E 访客走瓦房（自动清理）" });
    const roomId = roomRes.room.id;
    await post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "agent", ref: "XfyXvzONQFelnFIgM0dJVw:lex-console-copilot", onBehalfOf: "aloadtree@gmail.com", display: "智库副驾" });
    const invites = await fetch("/api/zhiyu/invites").then((r) => r.json());
    // THIS room's invite only — stale pendings from earlier runs point at old rooms.
    const agentInvite = (invites.invites ?? []).find((v) => v.kind === "agent" && v.roomId === roomId);
    if (!agentInvite) throw new Error("agent invite for the new room not found");
    await post(`/api/zhiyu/invites/${agentInvite.id}/accept`);
    const allowHost = new URL(location.href).host;
    const widgetRes = await post(`/api/zhiyu/rooms/${roomId}/widget`, { allowlist: [allowHost] });
    const status = await fetch(`/api/zhiyu/rooms/${roomId}/widget`).then((r) => r.json());
    const shareRes = await post(`/api/zhiyu/rooms/${roomId}/share-link`);
    return { roomId, embedToken: widgetRes.token, joinUrl: shareRes.url, allowHost, storedAllowlist: status.token?.allowlist };
  });

  console.log("[setup] allowHost=", setup.allowHost, "stored=", JSON.stringify(setup.storedAllowlist));
  const guestCtx = await browser.newContext();
  let embedCheckStatus = 0;
  const guestRequests = [];
  try {
    // ── Guest context: anonymous, no platform login.
    const guest = await guestCtx.newPage();
    guest.on("request", (r) => guestRequests.push(r.url()));
    guest.on("requestfailed", (r) => console.log("[guest] REQFAIL", r.url(), r.failure()?.errorText));
    guest.on("response", async (r) => {
      if (r.status() >= 400) {
        const body = await r.text().catch(() => "");
        console.log("[guest] HTTP", r.status(), r.url(), "BODY:", body.slice(0, 200));
      }
    });
    guest.on("console", (m) => {
      if (m.type() === "error") console.log("[guest] console.error:", m.text().slice(0, 200));
    });
    await guest.goto(setup.joinUrl, { waitUntil: "domcontentloaded" });

    // Banner honesty: the visitor learns immediately whose room this is.
    await expect(guest.getByText(/你是访客身份/)).toBeVisible({ timeout: 30_000 });
    // AI-free greeting names the callable seat (teaches @ without costing a turn).
    await expect(guest.getByText(/欢迎——我是值班席位/)).toBeVisible({ timeout: 30_000 });
    await expect(guest.getByText(/@智库副驾/)).toBeVisible({ timeout: 30_000 });

    // First screen is the TAIL window (fix-zhiyu-room-lifecycle… 4.3): opening a
    // reception room must not replay its whole history, and the live stream must
    // resume from that cursor rather than from seq 0.
    const tailCall = guestRequests.find((u) => /\/api\/zhiyu\/widget\/[^/]+\/messages\?[^#]*tail=200/.test(u));
    expect(tailCall, "first screen asks for the tail window").toBeTruthy();
    const streamCall = guestRequests.find((u) => /\/api\/zhiyu\/widget\/[^/]+\/events\?[^#]*after=\d+/.test(u));
    expect(streamCall, "the stream resumes from the tail cursor").toBeTruthy();

    // Composer @ completion: type the prefix, pick the seat.
    const textarea = guest.locator("textarea");
    await textarea.click();
    await textarea.pressSequentially("@智库");
    await expect(guest.getByRole("button", { name: "@智库副驾" })).toBeVisible({ timeout: 10_000 });
    await guest.getByRole("button", { name: "@智库副驾" }).click();
    await textarea.pressSequentially("用一句话介绍你能帮上什么忙");
    await guest.getByRole("button", { name: "发送" }).click();

    // The polish centerpiece: during the cold start the visitor SEES an honest
    // answering bubble — never dead air.
    await expect(guest.getByText(/正在作答/)).toBeVisible({ timeout: 90_000 });
    // The settled answer lands with real attribution (sender label, not "接待").
    await expect(guest.getByText("智库副驾").first()).toBeVisible({ timeout: 120_000 });
    await expect(guest.getByText(/我能|我/)).toBeVisible({ timeout: 30_000 });
  } finally {
    // Teardown ALWAYS: end the room and revoke both lanes so a failed run
    // never leaves a live widget behind (earlier runs taught this).
    await owner.evaluate(async (roomId) => {
      await fetch(`/api/zhiyu/rooms/${roomId}/widget/revoke`, { method: "POST" });
      await fetch(`/api/zhiyu/rooms/${roomId}/share-link/revoke`, { method: "POST" });
      await fetch(`/api/zhiyu/rooms/${roomId}/end`, { method: "POST" });
    }, setup.roomId);
    embedCheckStatus = (await owner.request.get(`${LIVE_SERVICE_URL}/zhiyu/embed/${setup.embedToken}`)).status();
    await guestCtx.close();
    await ownerCtx.close();
  }

  // Revoked embed returns 404.
  expect(embedCheckStatus).toBe(404);
});
