import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { gotoChat, tempDbPath, tempStoreDirs } from "./helpers.js";

// Artifact delivery scenario replay (openspec: add-artifact-delivery, task
// 5.1): the aloadtree incident replayed end-to-end against the chat UI — a
// turn that wrote a file (referenced only in prose, no relative link) and drew
// a chart. Assertions ride the UI chain, never the model's phrasing:
//
//   1. the captured chart carries the persistent library badge; the badge
//      navigates to the resources page
//   2. the turn artifact strip surfaces the unlinked file with a save action
//      even though the text never linked it
//   3. saving flips the chip to already-in-library without a reload
//   4. nothing is persisted: the stored message content is unchanged
//   5. reopening the session re-derives badge and strip identically
//
// No LLM calls: the session (with its tool blocks) and the captured chart are
// seeded straight into the run's SQLite store, the same seeding discipline as
// resources-page.spec.js.

const now = new Date().toISOString();
const BOOT_WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION = "e2e-artifact-delivery";

const CHART_OPTION = {
  title: { text: "产物交付 e2e" },
  xAxis: { type: "category", data: ["一月", "二月"] },
  yAxis: { type: "value" },
  series: [{ type: "line", data: [2, 5] }],
};

const FILE_BYTES = "# 交付验证\n场景重放产物。\n";

// A second fence whose spec is deliberately NOT in the resources table: its
// block must render WITHOUT a badge (uncaptured ≠ broken; no empty placeholder).
const UNCAPTURED_OPTION = {
  title: { text: "未入藏 e2e" },
  xAxis: { type: "category", data: ["a"] },
  yAxis: { type: "value" },
  series: [{ type: "bar", data: [1] }],
};

const canonicalHash = (option) =>
  crypto.createHash("sha256").update(JSON.stringify(option)).digest("hex");

const FENCE = "```echarts\n" + JSON.stringify(CHART_OPTION) + "\n```";
// Deliberately references the file ONLY by absolute path in the tool block —
// the strip must deliver what the prose failed to link.
const CONTENT = `报告已生成，图表如下：\n\n${FENCE}\n\n\`\`\`echarts\n${JSON.stringify(UNCAPTURED_OPTION)}\n\`\`\`\n\n（正文没有挂任何相对路径链接。）`;

const FILE_PATH = path.join(tempStoreDirs().root, "strip-report.md");

function db() {
  return new Database(tempDbPath());
}

test.beforeAll(async () => {
  fs.mkdirSync(tempStoreDirs().root, { recursive: true });
  fs.writeFileSync(FILE_PATH, FILE_BYTES);

  // Listen-first boot: the server answers /api/ready while migrations are
  // still applying. Seeding must wait for the schema (both tables) or the
  // INSERT races the migration chain and silently loses.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const probe = db();
      const n = probe
        .prepare(
          `SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN ('chat_sessions', 'chat_messages', 'resources')`,
        )
        .get();
      probe.close();
      if (n.c === 3) break;
    } catch {
      /* db file not there yet */
    }
    if (Date.now() > deadline) throw new Error("schema never became ready");
    await new Promise((r) => setTimeout(r, 250));
  }

  const blocks = [
    { kind: "text", text: CONTENT },
    {
      kind: "tool",
      id: "t-strip",
      name: "write_file",
      args: { path: FILE_PATH },
      result: "written",
      state: "done",
    },
  ];

  const handle = db();
  try {
    handle
      .prepare(
        `INSERT OR REPLACE INTO chat_sessions (id, title, created_at, updated_at, workspace)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(SESSION, "产物交付场景", now, now, BOOT_WORKSPACE);
    const insert = handle.prepare(
      `INSERT INTO chat_messages (session_id, role, content, seq, created_at, blocks)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(SESSION, "user", "给我建一个文档和图表", 1, now, null);
    insert.run(SESSION, "assistant", CONTENT, 2, now, JSON.stringify(blocks));
    handle
      .prepare(
        `INSERT OR REPLACE INTO resources (id, type, title, source, session_id, payload, content_hash,
           created_at, updated_at, last_seen_at)
         VALUES (?, 'chart', ?, 'auto', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "e2e-artifact-chart",
        "产物交付 e2e",
        SESSION,
        JSON.stringify(CHART_OPTION),
        canonicalHash(CHART_OPTION),
        now,
        now,
        now,
      );
  } finally {
    handle.close();
  }
});

// Open the seeded session and wait for its transcript. A dsh child restart
// can refuse the first switch ("Agent is still initializing" → the store
// restores); a re-click retries once the runtime is back — the house pattern
// from session-open.spec.js.
async function openSession(page) {
  await gotoChat(page);
  const row = page.locator(`[data-testid="session-row"][data-session-id="${SESSION}"]`);
  for (let attempt = 0; ; attempt++) {
    await row.click({ timeout: 15_000 });
    try {
      await expect(page.getByText("给我建一个文档和图表", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}

// The welcome trap (D6, surfaced while debugging the replay above): after a
// FULL reload on /chat/ without the URL id, the server reports the seeded
// session as current, the client starts on an empty welcome view, and the
// deep-link effect no-ops (same id) — the sidebar row click must still
// deliver the transcript. Regression-named so a future refactor that drops
// the empty-view resend fails HERE first, not somewhere downstream.
//
// Self-sufficient (any order): the opening switch is what puts the seeded
// session in the live slot; the reload then lands in the trap state.
test("welcome trap: clicking the current session's row recovers an empty view", async ({
  page,
}) => {
  await openSession(page); // switch → the live agent now runs the seeded session
  await gotoChat(page); // full reload, no URL id → trap state
  await expect(page.getByText("How can I help today?")).toBeVisible();
  await page.locator(`[data-testid="session-row"][data-session-id="${SESSION}"]`).click();
  await expect(page.getByText("给我建一个文档和图表", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
});

test("chart badge, artifact strip, save flip, retroactive re-render, nothing persisted", async ({
  page,
}) => {
  // 1. Open the seeded historical session: chart renders WITH the badge.
  await openSession(page);
  // Two charts render: the captured one carries the badge, the uncaptured
  // one renders clean — exactly one badge in the transcript.
  await expect(page.getByTestId("echart")).toHaveCount(2, { timeout: 20_000 });
  const badge = page.getByTestId("chart-library-badge");
  await expect(badge).toHaveCount(1);
  await expect(badge).toBeVisible();

  // 2. The badge navigates to the resources page, where the chart lives.
  await badge.click();
  await expect(page).toHaveURL(/\/resources/);
  await expect(page.getByText("产物交付 e2e").first()).toBeVisible();

  // 3. Reopen the session: the strip delivers the file the prose never linked.
  await openSession(page);
  const strip = page.getByTestId("turn-artifact-strip");
  await expect(strip).toBeVisible();
  const chip = page.getByTestId("turn-artifact-chip");
  await expect(chip).toContainText("strip-report.md");
  await expect(page.getByTestId("turn-artifact-save")).toBeVisible();
  await expect(page.getByTestId("turn-artifact-saved")).toHaveCount(0);

  // 4. Save flips the chip in place — no reload.
  await page.getByTestId("turn-artifact-save").click();
  await expect(page.getByTestId("turn-artifact-saved")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("turn-artifact-save")).toHaveCount(0);

  // 5. The library now holds the file; the stored message is untouched.
  {
    const handle = db();
    try {
      const fileRow = handle
        .prepare(`SELECT file_path FROM resources WHERE type = 'file' AND title = ?`)
        .get("strip-report.md");
      expect(fileRow?.file_path).toBeTruthy();
      const stored = handle
        .prepare(`SELECT content FROM chat_messages WHERE session_id = ? AND role = 'assistant'`)
        .get(SESSION);
      expect(stored.content).toBe(CONTENT); // no strip markup, fence intact
      expect(stored.content).not.toContain("turn-artifact");
    } finally {
      handle.close();
    }
  }

  // 6. Another reopen re-derives badge AND strip, chip already in-library.
  await openSession(page);
  await expect(page.getByTestId("chart-library-badge")).toBeVisible();
  await expect(page.getByTestId("turn-artifact-strip")).toBeVisible();
  await expect(page.getByTestId("turn-artifact-saved")).toBeVisible();
  await expect(page.getByTestId("turn-artifact-save")).toHaveCount(0);
});
