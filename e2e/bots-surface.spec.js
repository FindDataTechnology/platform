// Bots surface e2e (redesign-bots-surface): platform tile grid, typed add
// dialog, and the onboarding QR panel states.
//
// Hermetic by construction: the grid/tile tests run against the real server
// with an empty bot table (creating bots is never needed for those), the QR
// panel states are driven by stubbing `/api/bots*` in the browser, and the
// CRUD/masking check uses a wechat-oa bot — the one type whose create/reload
// path makes no network call and starts no polling loop.

import { test, expect } from "@playwright/test";
import { pinLocaleEn, baseURL } from "./helpers.js";

// A fake saved telegram bot for the stubbed-dialog tests. No secret values:
// masking keeps values server-side, so the browser shape never carries one.
const FAKE_BOT = {
  id: "bot-e2e-1",
  type: "telegram",
  name: "E2E Bot",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  configuredCredentials: ["token"],
  webhookUrl: "/api/bots/webhook/bot-e2e-1/secret",
};

const QR_STATES = {
  resolved: {
    strategy: "telegram-me",
    url: "https://t.me/e2e_bot",
    qr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 33 33"><rect width="33" height="33"/></svg>',
    hint: "botsPage.qr.hint.telegram",
  },
  manual: { strategy: "manual", url: null, qr: null, hint: "botsPage.qr.hint.manual" },
  failed: {
    strategy: "manual",
    url: null,
    qr: null,
    hint: "botsPage.qr.hint.manual",
    error: "telegram getMe failed: 401 Unauthorized",
  },
};

// Serve the real type descriptors (source of the credential form) with the
// configured list replaced by one fake bot.
async function stubBotList(page) {
  const res = await page.request.get(`${baseURL}/api/bots`);
  const data = await res.json();
  await page.route("**/api/bots", (route) => route.fulfill({ json: { ...data, bots: [FAKE_BOT] } }));
  // PATCH from the panel's manual-link save; the panel then re-resolves the QR.
  await page.route("**/api/bots/bot-e2e-1", (route) => route.fulfill({ json: FAKE_BOT }));
}

test.describe("bots platform grid", () => {
  test("renders four platform tiles and the empty guidance", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/bots");
    await expect(page.getByTestId("bots-page")).toBeVisible({ timeout: 15000 });

    await expect(page.getByTestId("bot-platform-tile")).toHaveCount(4);
    for (const platform of ["telegram", "feishu", "wecom", "wechat-oa"]) {
      await expect(
        page.locator(`[data-testid="bot-platform-tile"][data-platform="${platform}"]`),
      ).toBeVisible();
    }
    // No bots configured: the grid still renders, the list shows guidance.
    await expect(page.getByTestId("bots-empty")).toBeVisible();
  });

  test("clicking a tile opens the add dialog with that type fixed", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/bots");
    await expect(page.getByTestId("bot-platform-tile")).toHaveCount(4, { timeout: 15000 });

    await page.locator('[data-testid="bot-platform-tile"][data-platform="telegram"]').click();
    await expect(page.getByTestId("bot-type")).toHaveValue("telegram");
    await expect(page.getByTestId("bot-type")).toBeDisabled();
    await expect(page.getByTestId("bot-cred-token")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("bot-type")).toBeHidden();

    // A different tile preselects its own type with its own fields.
    await page.locator('[data-testid="bot-platform-tile"][data-platform="wecom"]').click();
    await expect(page.getByTestId("bot-type")).toHaveValue("wecom");
    await expect(page.getByTestId("bot-cred-corpId")).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

test.describe("bot dialog QR panel", () => {
  test("resolved state: server-rendered SVG, link, copy control, platform steps", async ({ page }) => {
    await pinLocaleEn(page);
    await stubBotList(page);
    await page.route("**/api/bots/bot-e2e-1/qr", (route) => route.fulfill({ json: QR_STATES.resolved }));

    await page.goto("/bots");
    await expect(page.getByTestId("bot-card")).toBeVisible({ timeout: 15000 });
    // The configured card carries its platform's brand icon.
    await expect(page.getByTestId("bot-card-icon").locator("svg")).toBeVisible();

    await page.getByTestId("bot-qr-open").click();
    await expect(page.getByTestId("bot-qr-panel")).toBeVisible();
    await expect(page.getByTestId("bot-qr-img")).toHaveAttribute("src", /data:image\/svg\+xml/);
    await expect(page.getByTestId("bot-qr-url")).toHaveText("https://t.me/e2e_bot");
    await expect(page.getByTestId("bot-qr-copy")).toBeVisible();
    await expect(page.getByTestId("bot-qr-panel")).toContainText("Open this link in Telegram and press Start.");
  });

  test("missing manual link: the panel prompts for the link, saving re-resolves", async ({ page }) => {
    await pinLocaleEn(page);
    await stubBotList(page);
    let qrCalls = 0;
    await page.route("**/api/bots/bot-e2e-1/qr", (route) => {
      qrCalls += 1;
      route.fulfill({ json: qrCalls === 1 ? QR_STATES.manual : QR_STATES.resolved });
    });

    await page.goto("/bots");
    await expect(page.getByTestId("bot-card")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("bot-qr-open").click();

    await expect(page.getByTestId("bot-qr-manual-input")).toBeVisible();
    await expect(page.getByTestId("bot-qr-error")).toHaveCount(0);

    await page.getByTestId("bot-qr-manual-input").fill("https://example.com/entry");
    await page.getByTestId("bot-qr-manual-save").click();

    // The save PATCHed the link and re-resolved into the QR.
    await expect(page.getByTestId("bot-qr-img")).toBeVisible();
  });

  test("upstream failure: the reason shows next to the manual fallback", async ({ page }) => {
    await pinLocaleEn(page);
    await stubBotList(page);
    await page.route("**/api/bots/bot-e2e-1/qr", (route) => route.fulfill({ json: QR_STATES.failed }));

    await page.goto("/bots");
    await expect(page.getByTestId("bot-card")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("bot-qr-open").click();

    await expect(page.getByTestId("bot-qr-error")).toContainText("401 Unauthorized");
    // The dialog stays functional: the fallback input is there for a manual link.
    await expect(page.getByTestId("bot-qr-manual-input")).toBeVisible();
  });
});

test.describe("bots management API", () => {
  test("unknown bot 404s on the QR endpoint", async ({ request }) => {
    const res = await request.get(`${baseURL}/api/bots/does-not-exist/qr`);
    expect(res.status()).toBe(404);
  });

  test("each type advertises its qr capability", async ({ request }) => {
    const data = await (await request.get(`${baseURL}/api/bots`)).json();
    const byType = Object.fromEntries(data.types.map((x) => [x.type, x.qr]));
    expect(byType.telegram.strategy).toBe("telegram-me");
    expect(byType["wechat-oa"].strategy).toBe("wechat-qrcode");
    expect(byType.feishu.strategy).toBe("manual");
    expect(byType.wecom.strategy).toBe("manual");
    expect(byType.feishu.field).toBe("qrUrl");
  });

  test("CRUD and credential masking still hold (wechat-oa: no upstream calls)", async ({ page, request }) => {
    const create = await request.post(`${baseURL}/api/bots`, {
      data: {
        type: "wechat-oa",
        name: "e2e-oa",
        credentials: { appId: "wx-e2e", appSecret: "SECRET-OA-VALUE", token: "TOKEN-OA-VALUE" },
      },
    });
    expect(create.ok()).toBeTruthy();
    const bot = await create.json();
    try {
      expect([...bot.configuredCredentials].sort()).toEqual(["appId", "appSecret", "token"]);
      expect(JSON.stringify(bot)).not.toContain("SECRET-OA-VALUE");
      expect(bot.webhookUrl).toContain("/api/bots/webhook/");

      const list = await (await request.get(`${baseURL}/api/bots`)).json();
      expect(JSON.stringify(list)).not.toContain("SECRET-OA-VALUE");

      // The real card renders with its platform icon, then cleanup restores empty.
      await pinLocaleEn(page);
      await page.goto("/bots");
      await expect(page.getByTestId("bot-card")).toHaveCount(1, { timeout: 15000 });
      await expect(page.getByTestId("bot-card")).toContainText("e2e-oa");
      await expect(page.getByTestId("bot-card-icon").locator("svg")).toBeVisible();
    } finally {
      expect((await request.delete(`${baseURL}/api/bots/${bot.id}`)).ok()).toBeTruthy();
    }
    // The API delete doesn't push to the open page; reload to see the empty list.
    await page.reload();
    await expect(page.getByTestId("bots-empty")).toBeVisible({ timeout: 15000 });
  });
});
