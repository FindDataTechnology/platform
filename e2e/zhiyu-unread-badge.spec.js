import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Zhiyu unread badge (openspec: polish-web-surfaces, zhiyu-room 通知与触达):
// viewing the page clears the lane and the badge drops at once, and the notices
// panel is never empty while the count is non-zero (invites included).
//
// The zhiyu gateway is stubbed at the network layer: the surface's own contract
// (count in, read-all out) is what this guards, not the gateway's storage
// (covered by scripts/test-zhiyu-notify.mjs).

const INVITE_NOTICE = {
  id: "n-invite-1",
  type: "invite",
  roomId: "r1",
  payload: { roomTitle: "Board room", invitedBy: "owner@x" },
  readAt: null,
  createdAt: 1_790_000_000_000,
};

test("an invite-only unread badge is visible, has a matching panel row, and clears on view", async ({
  page,
}) => {
  let unread = 1;
  let readAllCalls = 0;

  await page.route("**/api/zhiyu/notifications**", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.url().includes("/read-all")) {
      readAllCalls += 1;
      unread = 0;
      await route.fulfill({ json: { ok: true, unread: 0 } });
      return;
    }
    await route.fulfill({ json: { notifications: unread ? [INVITE_NOTICE] : [], unread } });
  });
  await page.route("**/api/zhiyu/rooms", (r) => r.fulfill({ json: { rooms: [] } }));
  await page.route("**/api/zhiyu/invites", (r) => r.fulfill({ json: { invites: [] } }));

  await gotoChat(page);

  // The badge reflects the count.
  const badge = page.getByTestId("nav-zhiyu-badge");
  await expect(badge).toBeVisible({ timeout: 10_000 });
  await expect(badge).toHaveText("1");

  // Viewing the page marks the lane read and clears the badge immediately.
  await page.getByTestId("nav-zhiyu").click();
  await expect(page.getByTestId("zhiyu-page")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => readAllCalls, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(badge).toHaveCount(0);

  // A badge can never point at nothing: an invite notice (the type that used to
  // be filtered out of the panel) is present as a visible row.
  const notices = page.getByTestId("zhiyu-notices");
  await expect(notices).toBeVisible();
  await expect(notices).toContainText("Board room");
});
