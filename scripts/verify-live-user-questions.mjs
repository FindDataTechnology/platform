// fd-prod acceptance smoke for add-user-questions (2026-10-02).
// Logs in through Logto (same credential source as verify-live-llm-route),
// then drives one REAL ask_user_question round on the deployed web chat:
// prompt → the interactive card appears (data-pending=true) → answer via the
// card → the card collapses to its summary → the turn completes. Asserts
// along the way that no NO_PROVIDER error block appears.
//
//   node scripts/verify-live-user-questions.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.env.PLATFORM_URL || "https://platform.finddatatech.cloud";

function dotenv(key) {
  const m = readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

const EMAIL = dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = dotenv("PAAS_TEST_PASSWORD");
if (!EMAIL || !PASSWORD) throw new Error("PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD not set in .env");

async function fillLogtoForm(page, timeoutMs = 30_000) {
  const identifier = page.locator('input[name="identifier"]');
  await identifier.waitFor({ state: "visible", timeout: timeoutMs });
  await identifier.fill(EMAIL);
  // Two-step Logto: the identifier step submits, the password field renders
  // on the following step.
  await page.getByRole("button", { name: "登录" }).click();
  const password = page.locator('input[name="password"]');
  await password.waitFor({ state: "visible", timeout: timeoutMs });
  await password.fill(PASSWORD);
  await password.press("Enter");
}

const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await fillLogtoForm(page);
  await page.waitForURL(/\/chat|\/settings/, { timeout: 60_000 });
  console.log("[smoke] logged in →", page.url());

  await page.goto(`${PLATFORM}/chat`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("composer-input").waitFor({ state: "visible", timeout: 30_000 });
  // Fresh session for a clean assertion (best-effort: a failure here just
  // means the round runs in the current session).
  await page.getByTestId("new-session").click().catch(() => {});
  await page.waitForTimeout(2_000);

  await page.getByTestId("composer-input").fill(
    "调用 ask_user_question 工具问我：继续吗？选项：继续、停止。除此之外什么都不要做。",
  );
  await page.getByTestId("composer-send").click();
  console.log("[smoke] prompt sent; waiting for the question card…");

  const card = page.getByTestId("question-card");
  await card.waitFor({ state: "visible", timeout: 90_000 });
  await card.locator('[data-testid="question-option"]', { hasText: "继续" }).click();
  // Wait for the submit to ENABLE (React re-render) before clicking — a
  // bare click races the state update and lands on a disabled button.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="question-submit"]')?.disabled === false,
    null,
    { timeout: 15_000 },
  );
  await card.locator('[data-testid="question-submit"]').click();
  console.log("[smoke] answered 继续 through the card");

  // Resolution: the ask's tool_end folds the group and unmounts the card
  // (platform fold-away idiom). Waiting for EITHER the unmount or the
  // static summary is the resolution signal.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="question-card"]');
      return el === null || el.getAttribute("data-pending") === "false";
    },
    null,
    { timeout: 90_000 },
  );
  console.log("[smoke] ask resolved ✓");

  // The turn completes: the stop button yields back to send.
  await page.getByTestId("composer-send").waitFor({ state: "visible", timeout: 120_000 });

  // Reopen the (now folded) activity group and verify the static summary.
  await page.getByTestId("activity-group").first().click();
  const summaryText = (await card.textContent().catch(() => "")) || "";
  if (!summaryText.includes("继续")) throw new Error(`summary missing the answer: ${summaryText}`);
  console.log("[smoke] summary shows the answer ✓");

  // No NO_PROVIDER error anywhere in the transcript.
  const bodyText = (await page.locator("body").textContent()) || "";
  if (/no user-questions provider/i.test(bodyText)) throw new Error("NO_PROVIDER error still present!");
  console.log("[smoke] no NO_PROVIDER error ✓");
  console.log("[smoke] PASS — fd-prod ask round verified end to end");
} catch (err) {
  console.error("[smoke] FAIL:", err.message);
  await page.screenshot({ path: path.join(ROOT, "test-results", "verify-live-user-questions.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
