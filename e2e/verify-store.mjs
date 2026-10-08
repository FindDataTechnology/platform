// Throwaway manual-verification script for task 5.3 (opsx:apply).
// Drives the running :3000 server through the Store tab flows.
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Pin locale to en so badge text is deterministic
await page.addInitScript(() => {
  try { if (!localStorage.getItem("platform.locale")) localStorage.setItem("platform.locale", "en"); } catch {}
});

try {
  await page.goto(BASE + "/extensions");
  await page.getByRole("heading", { name: /extensions/i }).waitFor({ timeout: 15000 });

  // 1. Store tab: >=4 "Ready to use" badges
  await page.getByRole("button", { name: /store/i }).click();
  const cards = page.getByTestId("mcp-market-card");
  const cardCount = await cards.count();
  let readyCount = 0, needsCount = 0;
  for (let i = 0; i < cardCount; i++) {
    const badge = cards.nth(i).getByTestId("mcp-config-badge");
    const text = (await badge.textContent()).trim();
    if (text.toLowerCase().includes("ready")) readyCount++; else needsCount++;
  }
  check(`Store shows ${cardCount} MCP cards, ${readyCount} ready-to-use (>=4)`, cardCount >= 7 && readyCount >= 4, `ready=${readyCount} needs=${needsCount}`);

  // 2. Install `fetch` (zero-config) -> lands in Enabled
  const fetchCard = page.getByTestId("mcp-market-card").filter({ has: page.getByText("Fetch", { exact: false }) }).first();
  await fetchCard.getByRole("button", { name: /install/i }).click();
  await page.getByRole("heading", { name: /add mcp/i }).waitFor({ timeout: 5000 });
  // Zero-config: no fillable fields -> Add enabled immediately
  const addBtn = page.getByRole("button", { name: /^add$/i });
  const addEnabled = await addBtn.isEnabled();
  check("fetch setup form: Add enabled immediately (zero-config)", addEnabled, addEnabled ? "" : "Add was disabled");
  // make name unique
  const nameInput = page.getByLabel(/name/i);
  const uniqueName = `fetch-verify-${Date.now()}`;
  await nameInput.fill(uniqueName);
  await addBtn.click();
  try {
    await page.getByRole("heading", { name: /add mcp/i }).waitFor({ state: "hidden", timeout: 5000 });
  } catch {
    await page.screenshot({ path: "/tmp/dialog-stuck.png" });
    console.log("dialog did not close; url:", page.url());
    throw new Error("dialog did not close after Add");
  }
  const enabledTab = page.getByRole("button", { name: /enabled/i });
  const enabledActive = await enabledTab.evaluate((el) => el.className.includes("border-primary"));
  const newCard = page.getByTestId("mcp-card").filter({ has: page.getByText(new RegExp(uniqueName, "i")) });
  const fetchLanded = await newCard.isVisible({ timeout: 10000 });
  check("fetch install lands in Enabled tab with new card", enabledActive && fetchLanded, `enabledTabActive=${enabledActive} cardVisible=${fetchLanded}`);
  // cleanup
  page.once("dialog", (d) => d.accept());
  await newCard.getByTestId("mcp-delete-btn").click();
  await newCard.waitFor({ state: "hidden", timeout: 5000 });

  // 3. Install `github` -> per-field setup form with GITHUB_PERSONAL_ACCESS_TOKEN + disabled Add until filled
  await page.getByRole("button", { name: /store/i }).click();
  const ghCard = page.getByTestId("mcp-market-card").filter({ has: page.getByText("GitHub", { exact: false }) }).first();
  await ghCard.getByRole("button", { name: /install/i }).click();
  await page.getByRole("heading", { name: /add mcp/i }).waitFor({ timeout: 5000 });

  const tokenField = page.getByLabel("GITHUB_PERSONAL_ACCESS_TOKEN");
  const tokenVisible = await tokenField.isVisible();
  check("github setup form shows GITHUB_PERSONAL_ACCESS_TOKEN field", tokenVisible, tokenVisible ? "" : "env field missing");

  const addBtn2 = page.getByRole("button", { name: /^add$/i });
  const disabledBefore = !(await addBtn2.isEnabled());
  check("github Add disabled before filling", disabledBefore, disabledBefore ? "" : "Add was enabled with empty token");

  // help block (installInstructions) visible
  const helpVisible = await page.getByText(/create a github personal access token/i).isVisible();
  check("github installInstructions shown as help", helpVisible, helpVisible ? "" : "help block missing");

  await tokenField.fill("ghp_test123");
  const enabledAfter = await addBtn2.isEnabled();
  check("github Add enabled after filling token", enabledAfter, enabledAfter ? "" : "Add stayed disabled after fill");

  // Cancel (don't actually install github - needs a real token to function)
  await page.getByRole("button", { name: /cancel/i }).click();
  await page.getByRole("heading", { name: /add mcp/i }).waitFor({ state: "hidden", timeout: 5000 });
} catch (e) {
  check("script completed without error", false, e.message + " | url: " + page.url());
  await page.screenshot({ path: "/tmp/verify-store-fail.png", fullPage: true });
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
