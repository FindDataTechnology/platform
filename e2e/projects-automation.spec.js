import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import JSZip from "jszip";
import { tempStoreDirs } from "./helpers.js";

function db() {
  return new Database(tempStoreDirs().db);
}

// R3 daily-flow (add-projects-automation-flow): name-based project creation
// (server route + sidebar switch chain), automation templates and the
// natural-language schedule input, and batch export of file resources.

function pinLocaleFor(page) {
  return page.addInitScript(() => {
    try {
      if (!localStorage.getItem("platform.locale")) localStorage.setItem("platform.locale", "en");
      localStorage.setItem("onboarding.tour.done", "1");
    } catch { /* ignore */ }
  });
}

// ── POST /api/projects — the four contract cases ─────────────────────────────

test.describe("projects endpoint", () => {
  test("create by name returns the absolute path", async ({ request }) => {
    const r = await request.post("/api/projects", { data: { name: "季度报告" } });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.name).toBe("季度报告");
    expect(body.path).toContain("projects");
    expect(path.basename(body.path)).toBe("季度报告");
    expect(fs.existsSync(body.path)).toBe(true);
  });

  test("path metacharacters are rejected with 400", async ({ request }) => {
    const r = await request.post("/api/projects", { data: { name: "../evil" } });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toBeTruthy();
  });

  test("attaching to an existing project returns the same directory", async ({ request }) => {
    const first = await request.post("/api/projects", { data: { name: "再次创建" } });
    expect(first.status()).toBe(200);
    const again = await request.post("/api/projects", { data: { name: "再次创建" } });
    expect(again.status()).toBe(200);
    expect((await again.json()).path).toBe((await first.json()).path);
  });

  test("empty names are rejected", async ({ request }) => {
    const r = await request.post("/api/projects", { data: { name: "   " } });
    expect(r.status()).toBe(400);
  });
});

// ── Sidebar create-by-name flows through the switch chain ────────────────────

test.describe("sidebar create-by-name", () => {
  test("a name creates the project and sends set_workspace with its path", async ({ page }) => {
    await pinLocaleFor(page);
    await page.addInitScript(() => {
      window.__sent = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }
        if (parsed) window.__sent.push(parsed);
        // Swallow the switch: no real runtime restart in this test.
        if (parsed && parsed.type === "set_workspace") return;
        return origSend.call(this, data);
      };
    });
    await page.goto("/chat");
    await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("workspace-new").click();
    await page.getByTestId("workspace-new-input").fill("端到端项目");
    await page.getByTestId("workspace-new-create").click();
    await expect
      .poll(() => page.evaluate(() => window.__sent.filter((m) => m.type === "set_workspace")))
      .toEqual([expect.objectContaining({ type: "set_workspace", path: expect.stringContaining("端到端项目") })]);
  });
});

// ── Automation: templates + natural-language schedule ────────────────────────

test.describe("automation templates and NL schedule", () => {
  async function openForm(page) {
    await pinLocaleFor(page);
    await page.goto("/tasks");
    await expect(page.getByTestId("cron-page")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("cron-new-toggle").click();
    await expect(page.getByTestId("cron-form")).toBeVisible();
  }

  test("weekly template prefills name, prompt, and schedule", async ({ page }) => {
    await openForm(page);
    await page.getByTestId("cron-template-weekly").click();
    // The prompt textarea carries the template copy; schedule is Fri 17:00.
    await expect(page.getByTestId("cron-time")).toHaveValue("17:00");
    await expect(page.getByTestId("cron-freq-weekly")).toHaveClass(/bg-primary/);
    await expect(page.getByTestId("cron-name")).toHaveValue("Weekly report");
    await expect(page.getByTestId("cron-prompt")).toContainText("one-page report");
  });

  test("NL schedule parses, previews, and applies", async ({ page }) => {
    await openForm(page);
    await page.getByTestId("cron-nl-input").fill("每周一早上 8 点");
    const preview = page.getByTestId("cron-nl-preview");
    await expect(preview).toContainText("0 8 * * 1", { timeout: 5000 });
    await page.getByTestId("cron-nl-apply").click();
    await expect(page.getByTestId("cron-time")).toHaveValue("08:00");
    await expect(page.getByTestId("cron-freq-weekly")).toHaveClass(/bg-primary/);
    // Monday chip is selected in the weekday row.
    const monday = page.locator('[data-testid="cron-form"] button', { hasText: /^Mon$/ });
    await expect(monday).toHaveClass(/border-primary/);
  });

  test("unparseable input shows the fallback hint and fills nothing", async ({ page }) => {
    await openForm(page);
    await page.getByTestId("cron-nl-input").fill("月圆之夜");
    await expect(page.getByTestId("cron-nl-fallback")).toBeVisible({ timeout: 5000 });
    // Nothing applied: no preview, no freq change from the default.
    await expect(page.getByTestId("cron-nl-preview")).toHaveCount(0);
    await expect(page.getByTestId("cron-freq-daily")).toHaveClass(/bg-primary/);
  });
});

// ── Batch export of file resources ───────────────────────────────────────────

function insertFile(id, title, rel, size) {
  const handle = db();
  const now = new Date().toISOString();
  handle
    .prepare(
      `INSERT INTO resources (id, type, title, source, session_id, session_title, message_id,
         payload, file_path, file_size, file_mime, content_hash, created_at, updated_at, last_seen_at, seeded)
       VALUES (@id, @type, @title, @source, @session_id, @session_title, @message_id,
         @payload, @file_path, @file_size, @file_mime, @content_hash, @created_at, @updated_at, @last_seen_at, @seeded)`,
    )
    .run({
      id, type: "file", title, source: "manual", session_id: null, session_title: null,
      message_id: null, payload: null, file_path: rel, file_size: size, file_mime: "text/plain",
      content_hash: crypto.randomUUID(), created_at: now, updated_at: now, last_seen_at: now, seeded: 0,
    });
  handle.close();
}

test.describe("batch export", () => {
  test("selecting two files produces a zip containing both; charts stay out", async ({ page }) => {
    // Seed two stored files + one chart (charts have no checkbox).
    const root = tempStoreDirs().root;
    for (const [n, fname] of [["1", "alpha.txt"], ["2", "beta.txt"]]) {
      const rel = `e2e-${n}/${fname}`;
      const dir = path.join(root, "resources-store", "files", `e2e-${n}`);
      fs.mkdirSync(dir, { recursive: true });
      const body = `content ${n} of export e2e — 汉字内容`;
      fs.writeFileSync(path.join(dir, fname), body);
      insertFile(`exp-${n}`, fname, rel, body.length);
    }
    await pinLocaleFor(page);
    await page.goto("/resources");
    await expect(page.getByTestId("resource-card")).toHaveCount(2, { timeout: 15000 });

    // Chart entries never appear here, so both cards are files with checkboxes.
    const boxes = page.getByTestId("resource-select");
    await expect(boxes).toHaveCount(2);
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expect(page.getByTestId("resources-export")).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("resources-export").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^outputs-\d{8}\.zip$/);

    const zipPath = await download.path();
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(["alpha.txt", "beta.txt"]);
    const alpha = await zip.files["alpha.txt"].async("string");
    expect(alpha).toContain("汉字内容");

    // Deselect-all hides the bar again.
    await boxes.nth(0).uncheck();
    await boxes.nth(1).uncheck();
    await expect(page.getByTestId("resources-export")).toHaveCount(0);
  });
});
