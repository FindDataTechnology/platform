// 破坏性操作确认的语义契约（optimize-paas-module-audit N-16 后半 / spec:
// web-operate-states「破坏性操作主题化确认」）。
//
// The requirement had two halves and only one was guarded: design-lint's
// native-confirm rule is asserted in scripts/test-design-lint.mjs, but the
// DIALOG's own semantics — danger variant, initial focus on the SAFE side, Esc
// equivalent to cancel, and only the confirm button performing the act — had no
// test anywhere (web has no component runner, so this is the only place a real
// ConfirmDialog can be driven).
//
// Driven through the skills surface because it is the shortest real danger
// path: seed a custom skill over the API, delete it from its card, and put the
// dialog through its three promises. Every assertion is locale-independent
// (testids + roles), since the same component serves five locales.

import { test, expect } from "@playwright/test";
import { pinLocaleEn, gotoSkills } from "./helpers.js";

const skill = (name) => `confirm-${name}-${Date.now()}`;

async function seedSkill(page, name) {
  const res = await page.request.post("/api/extensions/skills", {
    data: { name, description: "confirm-dialog fixture", content: "# fixture\n" },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function skillNames(page) {
  const r = await page.request.get("/api/extensions/skills");
  return ((await r.json()).skills ?? []).map((s) => s.name);
}

async function openDelete(page, name) {
  await gotoSkills(page);
  const card = page.locator(`[data-testid="skill-card"][data-skill-name="${name}"]`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: /delete/i }).click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  return { card, dialog };
}

test("danger confirm: the safe side takes initial focus, and Esc is equivalent to cancel", async ({ page }) => {
  await pinLocaleEn(page);
  const name = skill("esc");
  await seedSkill(page, name);

  const { dialog } = await openDelete(page, name);

  // Danger variant is a property of the dialog, not of the call site's copy.
  await expect(dialog).toHaveAttribute("data-variant", "danger");

  // The SAFE side is focused on open. Cancel precedes confirm in DOM order, and
  // ui/dialog focuses its first focusable child — that ordering is the
  // mechanism the spec's "焦点落取消侧" rides on, so assert the focus itself.
  await expect(page.getByTestId("confirm-dialog-cancel")).toBeFocused();

  // Esc cancels: the dialog closes and the skill is untouched.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await skillNames(page)).toContain(name);
});

test("danger confirm: only the confirm button performs the destructive act", async ({ page }) => {
  await pinLocaleEn(page);
  const name = skill("ok");
  await seedSkill(page, name);

  const { card, dialog } = await openDelete(page, name);

  // A cancel click is a no-op for the data, too (not just an Esc convenience).
  await page.getByTestId("confirm-dialog-cancel").click();
  await expect(dialog).toBeHidden();
  expect(await skillNames(page)).toContain(name);

  // Confirm performs it, closes, and the card goes away.
  await openDelete(page, name);
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(page.getByTestId("confirm-dialog")).toBeHidden();
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  expect(await skillNames(page)).not.toContain(name);
});
