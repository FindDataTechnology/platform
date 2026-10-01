import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { gotoResources, tempStoreDirs } from "./helpers.js";

// The resource library surface (openspec: add-resource-library 7.1-7.4).
//
// Seeding goes straight into the run's SQLite file — the same store the
// webServer writes — because a REAL chart capture needs a real LLM turn, and
// the page's job (list / filter / render / rename / delete / jump) is
// independent of how a row got there. The capture path itself is covered by
// the unit suites (scripts/test-resources-*.mjs).

const CHART_OPTION = {
  title: { text: "E2E Chart" },
  xAxis: { type: "category", data: ["a", "b", "c"] },
  yAxis: { type: "value" },
  series: [{ type: "bar", data: [1, 2, 3] }],
};

const FILE_BYTES = "name,score\nalice,10\nbob,20\n";

function db() {
  return new Database(tempStoreDirs().db);
}

function insertResource(row) {
  const handle = db();
  const now = new Date().toISOString();
  const full = {
    id: crypto.randomUUID(),
    type: "chart",
    title: "Untitled",
    source: "auto",
    session_id: null,
    session_title: null,
    message_id: null,
    payload: null,
    file_path: null,
    file_size: null,
    file_mime: null,
    content_hash: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    seeded: 0,
    ...row,
  };
  handle
    .prepare(
      `INSERT INTO resources (id, type, title, source, session_id, session_title, message_id,
         payload, file_path, file_size, file_mime, content_hash, created_at, updated_at, last_seen_at, seeded)
       VALUES (@id, @type, @title, @source, @session_id, @session_title, @message_id,
         @payload, @file_path, @file_size, @file_mime, @content_hash, @created_at, @updated_at, @last_seen_at, @seeded)`,
    )
    .run(full);
  handle.close();
  return full;
}

// A chart row plus a stored-file row (bytes planted under the resources root,
// which is what makes the download/preview paths real).
function seedLibrary({ withSession = null } = {}) {
  const chart = insertResource({
    type: "chart",
    title: "E2E Chart",
    payload: JSON.stringify(CHART_OPTION),
    session_id: withSession,
    session_title: withSession ? "E2E Session" : "Gone Session",
  });
  const fileId = crypto.randomUUID();
  const dir = path.join(tempStoreDirs().root, "resources-store", "files", fileId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "scores.csv"), FILE_BYTES);
  const file = insertResource({
    id: fileId,
    type: "file",
    title: "scores.csv",
    source: "manual",
    file_path: `${fileId}/scores.csv`,
    file_size: FILE_BYTES.length,
    file_mime: "text/csv",
  });
  return { chart, file };
}

// A workspace file the server can save. The webServer's cwd is the repo root,
// so that IS the workspace root it serves and saves from.
function plantWorkspaceFile(name, body) {
  const file = path.join(process.cwd(), name);
  fs.writeFileSync(file, body);
  return file;
}

test("an empty library explains what will appear", async ({ page }) => {
  await gotoResources(page);
  await expect(page.getByTestId("resources-empty")).toContainText("appear here automatically");
});

test("cards render both kinds; the filter and the search narrow the list", async ({ page }) => {
  const { chart, file } = seedLibrary();
  await gotoResources(page);

  const cards = page.getByTestId("resource-card");
  await expect(cards).toHaveCount(2);
  // The chart renders live through the same component the chat uses.
  await expect(
    page.locator(`[data-resource-id="${chart.id}"]`).getByTestId("echart").locator("canvas"),
  ).toHaveCount(1, { timeout: 20000 });
  // The file card shows its metadata.
  await expect(page.locator(`[data-resource-id="${file.id}"]`)).toContainText("scores.csv");

  await page.getByTestId("resources-filter-chart").click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-resource-type", "chart");

  await page.getByTestId("resources-filter-all").click();
  await page.getByTestId("resources-search").fill("scores");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-resource-type", "file");

  await page.getByTestId("resources-search").fill("no-such-resource-xyz");
  await expect(page.getByTestId("resources-empty")).toContainText("No resources match");
});

test("a file resource opens the stored copy and downloads", async ({ page }) => {
  const { file } = seedLibrary();
  await gotoResources(page);

  await page.locator(`[data-resource-id="${file.id}"]`).getByTestId("resource-open").click();
  await expect(page.getByTestId("preview-drawer")).toBeVisible();
  await expect(page.getByTestId("preview-name")).toHaveText("scores.csv");
  // The stored bytes came back through the resources root and the CSV
  // renderer ran on them.
  await expect(page.getByTestId("preview-csv")).toContainText("alice", { timeout: 10000 });

  const download = page.locator(`[data-resource-id="${file.id}"]`).getByTestId("resource-download");
  await expect(download).toHaveAttribute("href", /root=resources/);
});

test("rename persists; delete removes the card and the row", async ({ page }) => {
  const { chart } = seedLibrary();
  await gotoResources(page);
  const card = page.locator(`[data-resource-id="${chart.id}"]`);

  await card.getByTestId("resource-rename").click();
  await card.getByTestId("resource-rename-input").fill("Renamed by E2E");
  await card.getByTestId("resource-rename-save").click();
  await expect(card.getByTestId("resource-title")).toHaveText("Renamed by E2E");

  await page.reload();
  await expect(page.locator(`[data-resource-id="${chart.id}"]`).getByTestId("resource-title")).toHaveText(
    "Renamed by E2E",
  );

  page.on("dialog", (dialog) => void dialog.accept());
  await page.locator(`[data-resource-id="${chart.id}"]`).getByTestId("resource-delete").click();
  await expect(page.locator(`[data-resource-id="${chart.id}"]`)).toHaveCount(0);

  const handle = db();
  const row = handle.prepare("SELECT id FROM resources WHERE id = ?").get(chart.id);
  handle.close();
  expect(row).toBeUndefined();
});

test("jump-to-source appears only while the conversation exists", async ({ page }) => {
  // Two resources: one whose session is gone, one whose session exists (the
  // session row is seeded BEFORE the page loads, so the client's session list
  // already carries it).
  const now = new Date().toISOString();
  const handle = db();
  handle
    .prepare(
      "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("e2e-resource-session", "E2E Session", now, now);
  handle.close();

  const gone = insertResource({ title: "Old chart", session_id: "e2e-missing-session", session_title: "Gone" });
  const alive = insertResource({
    title: "Live chart",
    session_id: "e2e-resource-session",
    session_title: "E2E Session",
  });
  await gotoResources(page);

  await expect(page.locator(`[data-resource-id="${gone.id}"]`).getByTestId("resource-jump")).toHaveCount(0);
  // The provenance snapshot still shows even when the conversation is gone.
  await expect(page.locator(`[data-resource-id="${gone.id}"]`).getByTestId("resource-provenance")).toHaveText(
    "Gone",
  );
  await expect(page.locator(`[data-resource-id="${alive.id}"]`).getByTestId("resource-jump")).toBeVisible();
});

test("a save elsewhere in the app appears without a reload", async ({ page, request }) => {
  await gotoResources(page);
  const before = await page.getByTestId("resource-card").count();

  const name = `e2e-live-${Date.now()}.txt`;
  const planted = plantWorkspaceFile(name, "live update fixture");
  try {
    const res = await request.post("/api/resources", { data: { path: name } });
    expect(res.ok()).toBeTruthy();
    // No reload: the resources_changed broadcast drives the refetch.
    await expect(page.getByTestId("resource-card")).toHaveCount(before + 1, { timeout: 15000 });
    await expect(page.getByTestId("resources-page")).toContainText(name);
  } finally {
    fs.rmSync(planted, { force: true });
  }
});