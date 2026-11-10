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
      // The REAL dsh write shape: a producer call always carries the content
      // it is writing (openspec: wire-shell-produced-artifacts — a call that
      // names a path without content is a reader and must NOT surface).
      name: "write",
      args: { file_path: FILE_PATH, content: FILE_BYTES },
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

// ── wire-shell-produced-artifacts ─────────────────────────────────────────────
//
// The strip's file set is now derived from which calls PRODUCED files, not
// from any path that appears in a call. Two behaviors follow: a shell call's
// declared outputs surface (the reported case: a conversation-generated .zip
// with no other path to it), and a read-only turn surfaces no strip at all.

test("a shell-produced archive surfaces in the strip and opens the drawer", async ({ page }) => {
  const name = `paas-shell-archive-${Date.now()}.zip`;
  const abs = path.join(BOOT_WORKSPACE, name);
  fs.writeFileSync(abs, Buffer.from("not a real zip"));
  try {
    await gotoChat(page);
    await page.evaluate(
      ([n]) => {
        window.__chatStore.getState().apply({
          type: "session_loaded",
          id: "e2e-shell-archive",
          messages: [
            { role: "user", content: "打包" },
            {
              role: "assistant",
              content: "已打包。",
              blocks: [
                {
                  kind: "tool",
                  id: "t-zip",
                  name: "bash",
                  args: { command: `zip -r ${n} docs/`, description: "Zip the docs" },
                  result: "  adding: docs/a.txt (deflated 12%)",
                  state: "done",
                },
                { kind: "text", text: "已打包。" },
              ],
            },
          ],
        });
      },
      [name],
    );
    // The archive the command declared is the artifact — the docs/a.txt in the
    // command's OUTPUT text is not (it is not even a real path in the workspace).
    const chip = page.getByTestId("turn-artifact-chip");
    await expect(chip).toContainText(name, { timeout: 10_000 });
    // And the chip's file action opens the drawer on the archive itself.
    await chip.getByRole("button", { name: name }).click();
    await expect(page.getByTestId("preview-drawer")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("preview-name")).toHaveText(name);
    await expect(page.getByTestId("preview-fallback-download")).toBeVisible();
  } finally {
    fs.rmSync(abs, { force: true });
  }
});

test("a read-only turn surfaces no strip", async ({ page }) => {
  const name = `paas-readonly-${Date.now()}.md`;
  const abs = path.join(BOOT_WORKSPACE, name);
  fs.writeFileSync(abs, "# here\n");
  try {
    await gotoChat(page);
    await page.evaluate(
      ([n]) => {
        window.__chatStore.getState().apply({
          type: "session_loaded",
          id: "e2e-readonly-turn",
          messages: [
            { role: "user", content: "看看有什么" },
            {
              role: "assistant",
              content: "列了个目录。",
              blocks: [
                {
                  kind: "tool",
                  id: "t-ls",
                  name: "bash",
                  args: { command: "ls -la", description: "List files" },
                  result: `total 8\n-rw-r--r-- 1 u u 100 ${n}`,
                  state: "done",
                },
                { kind: "text", text: "列了个目录。" },
              ],
            },
          ],
        });
      },
      [name],
    );
    // The listing NAMES a file that exists, but naming is not producing: no
    // strip may appear for a turn whose calls wrote nothing.
    await page.waitForTimeout(500);
    await expect(page.getByTestId("turn-artifact-strip")).toHaveCount(0);
  } finally {
    fs.rmSync(abs, { force: true });
  }
});

// ── wire-produced-files-to-outputs ───────────────────────────────────────────
// The rule's production blind spots, pinned at the UI level: a multi-line
// command's archive line must surface (newlines now split segments), and a
// heredoc-built zip must surface instead of the code-text chip the redirect
// regex used to mint from `print("... ->", out)`.

test("an archive on a later line of a multi-line command surfaces in the strip", async ({ page }) => {
  const name = `paas-multiline-${Date.now()}.tar.gz`;
  const abs = path.join(BOOT_WORKSPACE, name);
  fs.writeFileSync(abs, Buffer.from("not a real tar"));
  try {
    await gotoChat(page);
    await page.evaluate(
      ([n]) => {
        window.__chatStore.getState().apply({
          type: "session_loaded",
          id: "e2e-multiline-archive",
          messages: [
            { role: "user", content: "打包" },
            {
              role: "assistant",
              content: "已打包。",
              blocks: [
                {
                  kind: "tool",
                  id: "t-tar",
                  name: "bash",
                  args: {
                    command: `find . | sort > /tmp/doclist.txt\ntar -czf ${n} -T /tmp/doclist.txt`,
                    description: "Bundle docs",
                  },
                  result: "ok",
                  state: "done",
                },
                { kind: "text", text: "已打包。" },
              ],
            },
          ],
        });
      },
      [name],
    );
    const chip = page.getByTestId("turn-artifact-chip");
    await expect(chip).toContainText(name, { timeout: 10_000 });
    // The /tmp redirect target is a candidate but not an existing workspace
    // file, so only the archive chip shows.
    await expect(chip).not.toContainText("doclist.txt");
  } finally {
    fs.rmSync(abs, { force: true });
  }
});

test("a heredoc-built zip surfaces and no code-text chip appears", async ({ page }) => {
  const name = `paas-heredoc-${Date.now()}.zip`;
  const abs = path.join(BOOT_WORKSPACE, name);
  fs.writeFileSync(abs, Buffer.from("PK\x03\x04 not real"));
  try {
    await gotoChat(page);
    await page.evaluate(
      ([n]) => {
        window.__chatStore.getState().apply({
          type: "session_loaded",
          id: "e2e-heredoc-zip",
          messages: [
            { role: "user", content: "python 打包" },
            {
              role: "assistant",
              content: "已打包。",
              blocks: [
                {
                  kind: "tool",
                  id: "t-py",
                  name: "bash",
                  args: {
                    command: `python3 - <<'EOF'\nout = "${n}"\nprint("Zipped files ->", out)\nEOF`,
                    description: "Zip via python",
                  },
                  result: "Zipped 2 files",
                  state: "done",
                },
                { kind: "text", text: "已打包。" },
              ],
            },
          ],
        });
      },
      [name],
    );
    const chip = page.getByTestId("turn-artifact-chip");
    await expect(chip).toContainText(name, { timeout: 10_000 });
    // The old bug: `->` in the print minted a chip of Python source text.
    await expect(page.getByTestId("turn-artifact-strip")).not.toContainText("Zipped files");
  } finally {
    fs.rmSync(abs, { force: true });
  }
});

test("a single-line python -c body with semicolons surfaces its zip", async ({ page }) => {
  // Production shape (cell 1da519d4c1c0bf89, 2026-10-15): the agent packed with
  // one `python3 -c "import zipfile;z=…('out.zip','w');…"` line. The quoted
  // body's semicolons used to split the command, stranding the archive in a
  // verb-less fragment — the zip never reached the strip or Outputs.
  const name = `paas-pyc-${Date.now()}.zip`;
  const abs = path.join(BOOT_WORKSPACE, name);
  fs.writeFileSync(abs, Buffer.from("PK\x03\x04 not real"));
  try {
    await gotoChat(page);
    await page.evaluate(
      ([n]) => {
        window.__chatStore.getState().apply({
          type: "session_loaded",
          id: "e2e-pyc-zip",
          messages: [
            { role: "user", content: "打包成 zip" },
            {
              kind: "assistant",
              content: "已完成。",
              blocks: [
                {
                  kind: "tool",
                  id: "t-pyc",
                  name: "bash",
                  args: {
                    command: `python3 -c "import zipfile;z=zipfile.ZipFile('${n}','w');z.writestr('hello.txt','hi');z.close()"`,
                    description: "Create zip file",
                  },
                  result: null,
                  state: "done",
                },
                { kind: "text", text: "已完成。" },
              ],
            },
          ],
        });
      },
      [name],
    );
    const chip = page.getByTestId("turn-artifact-chip");
    await expect(chip).toContainText(name, { timeout: 10_000 });
    // The body's other quoted tokens must not mint extra chips.
    await expect(page.getByTestId("turn-artifact-strip")).not.toContainText("zipfile");
  } finally {
    fs.rmSync(abs, { force: true });
  }
});
