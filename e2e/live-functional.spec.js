import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveSmokeEnabled, pinLocaleEn } from "./live-helpers.js";

// @live-functional — REAL functional test against the deployed
// logto-gated production service.
//
// Unlike e2e/chat-chart-rendering.spec.js this cannot use the window.__chatStore
// seam: the production build ships without the e2e seam (VITE_E2E_SEAM), so the
// assistant text cannot be injected. This drives the real path instead —
// Logto sign-in → WebSocket → real LLM turn → chart render — which is the only
// way to prove the shipped image's new features actually work online.
//
// Side effects: spends one LLM turn and writes one chat-history row; the DOCX
// case uploads one document and deletes it again.
// Credentials come from the environment (never from this file):
//   PAAS_TEST_IDENTIFIER, PAAS_TEST_PASSWORD

const IDENTIFIER = process.env.PAAS_TEST_IDENTIFIER || "";
const PASSWORD = process.env.PAAS_TEST_PASSWORD || "";

const FENCE = "```";

// A real DOCX from mammoth's own test data. Its body is the single paragraph
// "Walking on imported air" — short, ASCII, and therefore assertable both in the
// server-side extracted text and in the client-side mammoth HTML.
const DOCX_SRC = path.resolve("web/node_modules/mammoth/test/test-data/single-paragraph.docx");
const DOCX_TEXT = "Walking on imported air";

// Copy the fixture under a per-run name so the row this test creates in the
// shared production library is unambiguous (and safe to delete).
function stagedDocx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paas-word-"));
  const name = `paas-word-${Date.now()}.docx`;
  const file = path.join(dir, name);
  fs.copyFileSync(DOCX_SRC, file);
  return { file, name, dir };
}

async function logIn(page) {
  // The status assertion below is the English string, so pin the locale before
  // the first navigation (addInitScript has to precede goto). Without this the
  // login wait times out on any non-English browser.
  await pinLocaleEn(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const appOrigin = new URL(page.url()).origin;

  // The shell renders a loading state while /api/auth/me resolves, so the SSO
  // link is not there on the first paint — wait for it rather than probing.
  const sso = page.getByTestId("sso-login");
  await sso.waitFor({ state: "visible", timeout: 30_000 });
  await sso.click();

  // Logto sign-in is a sequence of screens — identifier, then password.
  for (const [field, value] of [["identifier", IDENTIFIER], ["password", PASSWORD]]) {
    const input = page.locator(`input[name="${field}"]`).first();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await input.fill(value);
    await page.locator('button[name="submit"]').first().click();
  }

  // After the password step the flow lands either in the app or on Logto's
  // consent screen (first sign-in only) — they are mutually exclusive.
  const status = page.getByTestId("status-text");
  const consent = page.locator('button[name="submit"]').first();
  await Promise.race([
    status.waitFor({ state: "visible", timeout: 60_000 }),
    consent.waitFor({ state: "visible", timeout: 60_000 }),
  ]).catch(() => {});

  // Still on Logto means consent is pending. The button is disabled while the
  // grant submits, so bound the click: an unbounded one auto-waits for the
  // whole test budget once the app navigates out from under it.
  if (new URL(page.url()).origin !== appOrigin) {
    await consent.click({ timeout: 30_000 }).catch(() => {});
  }

  await expect(status).toHaveText("Connected", { timeout: 60_000 });
  console.log("[login] landed on:", page.url());
}

async function sendPrompt(page, text) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
  const turn = page.getByTestId("turn-assistant").last();
  await expect(turn).toBeVisible({ timeout: 60_000 });
  await expect(turn).toHaveAttribute("data-streaming", "false", { timeout: 120_000 });
  return turn;
}

test.describe("live functional @live-functional", () => {
  test.describe.configure({ timeout: 240_000 });
  // Gated like the other live tests: these spend an LLM turn and write to the
  // deployed library, so `test:e2e:live` — documented as non-mutating — must
  // not select them unless LIVE_SMOKE=1 is explicitly set.
  test.skip(
    !liveSmokeEnabled() || !IDENTIFIER || !PASSWORD,
    "set LIVE_SMOKE=1 plus PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD to run the live functional tests",
  );

  test("a real signed-in turn renders an echarts fence as a live chart", async ({ page }) => {
    await logIn(page);

    // Force the ```echarts contract (CLAUDE.md's chart convention) explicitly —
    // the deployed agent has no instruction to prefer it on its own.
    await sendPrompt(
      page,
      [
        "只输出一个 " + FENCE + "echarts 代码块，代码块内容是 ECharts option 的 JSON：",
        '柱状图，xAxis 为 {type:"category",data:["a","b","c"]}，',
        'yAxis 为 {type:"value"}，series 为 [{type:"bar",data:[1,2,3]}]。',
        "不要输出代码块以外的任何文字。",
      ].join(""),
    );

    const chart = page.getByTestId("echart");
    await expect(chart).toBeVisible({ timeout: 30_000 });
    // ECharts paints a canvas into the container once the lazy chunk loads.
    await expect(chart.locator("canvas")).toHaveCount(1, { timeout: 30_000 });
    // The fence was NOT also rendered as a code block.
    await expect(page.locator("pre")).toHaveCount(0);
  });

  test("a real DOCX uploads, extracts text, and previews as Word content", async ({ page }) => {
    await logIn(page);
    const docx = stagedDocx();

    // 1. Server-side ingestion: upload through the Knowledge page and read the
    //    extracted text back. `doc-converse` only enables once the row is ready,
    //    so it is the locale-independent readiness signal.
    await page.goto("/knowledge", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("documents-page")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("ingest-section").locator('input[type="file"]').setInputFiles(docx.file);

    const row = page.getByTestId("doc-row").filter({ hasText: docx.name });
    try {
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(row.getByTestId("doc-converse")).toBeEnabled({ timeout: 60_000 });
      await row.locator("button").first().click();
      await expect(page.getByTestId("doc-content")).toContainText(DOCX_TEXT, { timeout: 30_000 });

      // 2. Client-side rendering: the preview drawer's DOCX branch runs mammoth
      //    in the browser and paints the result into a sandboxed iframe.
      await page.goto("/chat", { waitUntil: "domcontentloaded" });
      await page.getByTestId("preview-local-open").first().click();
      await page.getByTestId("preview-local-input").setInputFiles(docx.file);
      await expect(page.getByTestId("preview-docx")).toBeVisible({ timeout: 30_000 });
      await expect(page.frameLocator('[data-testid="preview-docx"]').locator("body")).toContainText(
        DOCX_TEXT,
        { timeout: 30_000 },
      );
    } finally {
      // Best-effort cleanup: the live library is shared, so a passing run must
      // not leave the fixture behind.
      await page.goto("/knowledge", { waitUntil: "domcontentloaded" }).catch(() => {});
      await row.getByTestId("doc-delete").click({ timeout: 15_000 }).catch(() => {});
      fs.rmSync(docx.dir, { recursive: true, force: true });
    }
  });
});
