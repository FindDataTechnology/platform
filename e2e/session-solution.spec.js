import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { pinLocaleEn, tempStoreDirs } from "./helpers.js";

// Session-to-preset sentinel (openspec: add-session-to-preset 2.4): the
// extraction on-ramp. Seeds a session + user messages straight into the
// run's SQLite (the resources-page precedent — the wizard's job is
// extraction, not capture), then walks menu → wizard → save and asserts the
// preset row landed with the picked examples.

const SEED_MSGS = [
  ["user", "帮我把这份季报做成趋势图"],
  ["assistant", "好的，已生成趋势图。"],
  ["user", "再总结三条风险信号"],
  ["assistant", "总结如下…"],
  ["user", "把结论写成一段给管理层的摘要"],
];

function seedSession() {
  const id = crypto.randomUUID();
  const db = new Database(tempStoreDirs().db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, "季度数据分析", now, now);
  SEED_MSGS.forEach(([role, content], i) => {
    db.prepare(
      "INSERT INTO chat_messages (session_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, role, content, i, now);
  });
  db.close();
  return id;
}

async function openMenu(page) {
  await page.getByTestId("chat-header-overflow").click();
  await expect(page.getByTestId("session-menu")).toBeVisible();
}

test("session menu opens the solution wizard prefilled", async ({ page }) => {
  const sessionId = await seedSession();
  await pinLocaleEn(page);
  await page.goto(`/chat/${sessionId}`);
  await expect(page.getByTestId("chat-header")).toBeVisible({ timeout: 15000 });

  await openMenu(page);
  await page.getByTestId("session-save-solution").click();

  const dialog = page.getByTestId("session-solution-dialog");
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await expect(dialog.getByTestId("session-solution-name")).toHaveValue("季度数据分析");
  // First 3 user messages are picked by default; the long third one stays pickable.
  await expect(dialog.getByTestId("session-solution-example-0")).toBeChecked();
  await expect(dialog.getByTestId("session-solution-example-1")).toBeChecked();
  await expect(dialog.getByTestId("session-solution-example-2")).toBeChecked();
});

test("wizard save lands a preset with picked examples; cancel lands nothing", async ({ page }) => {
  const sessionId = await seedSession();
  await pinLocaleEn(page);
  await page.goto(`/chat/${sessionId}`);
  await expect(page.getByTestId("chat-header")).toBeVisible({ timeout: 15000 });

  // Cancel path first: nothing is created.
  await openMenu(page);
  await page.getByTestId("session-save-solution").click();
  const dialog = page.getByTestId("session-solution-dialog");
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await dialog.getByRole("button", { name: /cancel/i }).click();
  await expect(page.getByTestId("session-solution-dialog")).toBeHidden();

  // Save path: fill persona, uncheck one example, save.
  await openMenu(page);
  await page.getByTestId("session-save-solution").click();
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await dialog.getByTestId("session-solution-example-2").click();
  await dialog.getByTestId("session-solution-persona").fill("You are a financial analysis assistant.");
  await dialog.getByTestId("session-solution-save").click();
  await expect(page.getByTestId("session-solution-saved")).toBeVisible({ timeout: 10000 });

  // The preset row exists with exactly the two picked examples.
  const db = new Database(tempStoreDirs().db);
  const rows = db
    .prepare("SELECT persona, examples FROM user_presets WHERE name = ? ORDER BY created_at")
    .all("季度数据分析");
  db.close();
  expect(rows.length).toBeGreaterThan(0);
  const latest = rows[rows.length - 1];
  expect(latest.persona).toContain("financial analysis assistant");
  expect(JSON.parse(latest.examples)).toEqual(["帮我把这份季报做成趋势图", "再总结三条风险信号"]);
});

test("iterate mode writes the session's tuning back, composition untouched", async ({ page }) => {
  const sessionId = await seedSession();
  // A prior solution with its own composition and an old persona.
  const db = new Database(tempStoreDirs().db);
  db.prepare(
    "INSERT INTO user_presets (id, name, persona, skills, mcp_servers, tags, icon, examples, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
  ).run(
    "user.prior-solution",
    "旧方案",
    "旧的角色设定",
    JSON.stringify(["old-skill"]),
    JSON.stringify(["old-server"]),
    "[]",
    JSON.stringify(["旧示例一"]),
    new Date().toISOString(),
    new Date().toISOString(),
  );
  db.close();

  await pinLocaleEn(page);
  await page.goto(`/chat/${sessionId}`);
  await expect(page.getByTestId("chat-header")).toBeVisible({ timeout: 15000 });
  await openMenu(page);
  await page.getByTestId("session-save-solution").click();
  const dialog = page.getByTestId("session-solution-dialog");
  await expect(dialog).toBeVisible({ timeout: 10000 });

  await expect(dialog.getByTestId("session-solution-mode-update")).toBeEnabled({ timeout: 15000 });
  await dialog.getByTestId("session-solution-mode-update").click();
  await dialog.getByTestId("session-solution-target").selectOption("user.prior-solution");
  await expect(dialog.getByTestId("session-solution-boundary")).toBeVisible();
  await dialog.getByTestId("session-solution-example-2").click();
  await dialog.getByTestId("session-solution-persona").fill("Tuned further in this session.");
  await dialog.getByTestId("session-solution-save").click();
  await expect(page.getByTestId("session-solution-saved")).toBeVisible({ timeout: 10000 });

  const after = new Database(tempStoreDirs().db);
  const row = after.prepare("SELECT persona, skills, mcp_servers, examples FROM user_presets WHERE id = ?").get("user.prior-solution");
  after.close();
  expect(row.persona).toBe("Tuned further in this session.");
  expect(JSON.parse(row.skills)).toEqual(["old-skill"]);
  expect(JSON.parse(row.mcp_servers)).toEqual(["old-server"]);
  expect(JSON.parse(row.examples)).toEqual(["帮我把这份季报做成趋势图", "再总结三条风险信号"]);
});
