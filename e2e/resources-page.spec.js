import assert from "node:assert/strict";
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
    // Unified memory & outputs: tier is a plain string and tags a JSON array
    // string — the card reads them differently (task 3.1).
    tier: "draft",
    tags: "[]",
    ...row,
  };
  handle
    .prepare(
      `INSERT INTO resources (id, type, title, source, session_id, session_title, message_id,
         payload, file_path, file_size, file_mime, content_hash, created_at, updated_at, last_seen_at, seeded,
         tier, tags)
       VALUES (@id, @type, @title, @source, @session_id, @session_title, @message_id,
         @payload, @file_path, @file_size, @file_mime, @content_hash, @created_at, @updated_at, @last_seen_at, @seeded,
         @tier, @tags)`,
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
  await expect(page.getByTestId("resources-empty")).toBeVisible();
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

  // Themed danger ConfirmDialog (web-operate-states) instead of a native one.
  await page.locator(`[data-resource-id="${chart.id}"]`).getByTestId("resource-delete").click();
  const confirmDelete = page.getByTestId("confirm-dialog");
  await expect(confirmDelete).toBeVisible();
  await page.getByTestId("confirm-dialog-confirm").click();
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

// ── Filters (openspec: add-resource-filters, tasks 3.2 / 3.3) ────────────────
//
// The landing view, the time presets and the group chips are driven through the
// real page against rows seeded at known ages, so the assertions are about what
// the user sees: which chips start checked, what the counts say, and whether a
// card shows when it was created.

// These cases share the run's SQLite with the rest of the file, so each one
// removes the rows it planted: a leftover PDF would otherwise change the facet
// counts and card totals the neighbouring cases assert on.
// Every case here starts from an EMPTY library: the neighbouring cases in this
// file seed their own rows and assert exact card counts, and the facet counts
// are computed over the whole library, so any leftover row changes what this
// page shows.
test.beforeEach(() => {
  const handle = db();
  handle.prepare("DELETE FROM resources").run();
  handle.close();
});

test.afterEach(() => {
  const handle = db();
  handle.prepare("DELETE FROM resources").run();
  handle.close();
});

function seedAgedLibrary() {
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * 86_400_000).toISOString();
  const rows = {
    chart: insertResource({ type: "chart", title: "Aged Chart", payload: JSON.stringify(CHART_OPTION), created_at: iso(1), updated_at: iso(1), last_seen_at: iso(1) }),
    pdf: insertResource({ type: "file", title: "report.pdf", source: "manual", file_path: "u/report.pdf", file_mime: "application/pdf", created_at: iso(2), updated_at: iso(2), last_seen_at: iso(2) }),
    csv: insertResource({ type: "file", title: "data.csv", source: "manual", file_path: "u/data.csv", file_mime: "text/csv", created_at: iso(3), updated_at: iso(3), last_seen_at: iso(3) }),
    oldPdf: insertResource({ type: "file", title: "archived.pdf", source: "manual", file_path: "u/archived.pdf", file_mime: "application/pdf", created_at: iso(40), updated_at: iso(40), last_seen_at: iso(40) }),
  };
  return rows;
}

test("the landing view pre-checks the common groups and shows facet counts", async ({ page }) => {
  seedAgedLibrary();
  await gotoResources(page);

  // Chart / document / spreadsheet / image start checked; the rest do not.
  for (const g of ["chart", "document", "spreadsheet", "image"]) {
    await expect(page.getByTestId(`resources-group-${g}`)).toHaveAttribute("data-checked", "true");
  }
  for (const g of ["slideshow", "archive"]) {
    await expect(page.getByTestId(`resources-group-${g}`)).toHaveAttribute("data-checked", "false");
  }
  // Counts reflect what is behind each chip, including the unchecked ones.
  await expect(page.getByTestId("resources-group-document")).toHaveAttribute("data-count", "2");
  await expect(page.getByTestId("resources-group-spreadsheet")).toHaveAttribute("data-count", "1");
  await expect(page.getByTestId("resources-group-chart")).toHaveAttribute("data-count", "1");
  await expect(page.getByTestId("resources-group-archive")).toHaveAttribute("data-count", "0");
  // A zero-count chip is disabled (greyed out), not hidden.
  await expect(page.getByTestId("resources-group-archive")).toBeDisabled();
  await expect(page.getByTestId("resources-group-archive")).toBeVisible();

  // The default selection is what the list reflects: no archive, no "other".
  await expect(page.getByTestId("resource-card")).toHaveCount(4);
});

test("a time preset narrows the list and the counts together", async ({ page }) => {
  seedAgedLibrary();
  await gotoResources(page);
  await expect(page.getByTestId("resource-card")).toHaveCount(4);

  await page.getByTestId("resources-time-7d").click();
  // archived.pdf is 40 days old; the other three are inside the window.
  await expect(page.getByTestId("resource-card")).toHaveCount(3);
  await expect(page.getByTestId("resources-group-document")).toHaveAttribute("data-count", "1");

  await page.getByTestId("resources-time-30d").click();
  await expect(page.getByTestId("resource-card")).toHaveCount(3);
  await page.getByTestId("resources-time-all").click();
  await expect(page.getByTestId("resource-card")).toHaveCount(4);
});

test("the group row follows the tab; unchecking a group drops its cards", async ({ page }) => {
  seedAgedLibrary();
  await gotoResources(page);

  // Files tab: the chart chip is gone, the file groups remain.
  await page.getByTestId("resources-filter-file").click();
  await expect(page.getByTestId("resources-group-chart")).toHaveCount(0);
  await expect(page.getByTestId("resources-group-document")).toBeVisible();
  await expect(page.getByTestId("resource-card")).toHaveCount(3);

  // Unchecking documents leaves only the CSV.
  await page.getByTestId("resources-group-document").click();
  await expect(page.getByTestId("resource-card")).toHaveCount(1);
  await expect(page.getByTestId("resource-card").first()).toContainText("data.csv");

  // Charts tab: the group row is absent, the time filter still applies.
  await page.getByTestId("resources-filter-chart").click();
  await expect(page.getByTestId("resources-group-row")).toHaveCount(0);
  await expect(page.getByTestId("resources-time-row")).toBeVisible();
  await expect(page.getByTestId("resource-card")).toHaveCount(1);
});

test("cards show their creation time", async ({ page }) => {
  const rows = seedAgedLibrary();
  await gotoResources(page);
  const stamp = page.locator(`[data-resource-id="${rows.pdf.id}"]`).getByTestId("resource-created-at");
  await expect(stamp).toBeVisible();
  // Short absolute form: MM-DD HH:mm for the current year, never a blank.
  await expect(stamp).toHaveAttribute("data-created-at", rows.pdf.created_at);
  await expect(stamp).toContainText(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  // The full timestamp is available on hover.
  await expect(stamp).toHaveAttribute("title", /.+/);
});

test("the filter rows survive a narrow viewport", async ({ page }) => {
  seedAgedLibrary();
  await page.setViewportSize({ width: 380, height: 720 });
  await gotoResources(page);

  // Both rows stay on screen: the presets scroll horizontally, the chips wrap
  // onto more than one line rather than pushing content out of view.
  await expect(page.getByTestId("resources-time-row")).toBeVisible();
  await expect(page.getByTestId("resources-group-row")).toBeVisible();

  const overflowX = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflowX).toBeLessThanOrEqual(1);

  // A chip on the wrapped row is still clickable at this width.
  await page.getByTestId("resources-group-document").click();
  await expect(page.getByTestId("resource-card")).toHaveCount(2);
});

// The tier badge must read the row's own tier (add-unified-memory-and-outputs
// task 3.1). The card used to parse the tier column as a JSON array — every
// graded output then read "Draft" and "Unpin" never appeared.
test("a graded output shows its own tier badge and the unpin gesture", async ({ page }) => {
  const canonical = insertResource({
    type: "file",
    title: "graded.md",
    source: "manual",
    file_path: `${crypto.randomUUID()}/graded.md`,
    tier: "canonical",
    tags: JSON.stringify(["行业政策"]),
  });
  const draft = insertResource({
    type: "file",
    title: "plain.md",
    source: "manual",
    file_path: `${crypto.randomUUID()}/plain.md`,
  });
  await gotoResources(page);

  const canonicalCard = page.locator(`[data-resource-id="${canonical.id}"]`);
  await expect(canonicalCard.getByTestId("resource-tier-canonical")).toBeVisible();
  await expect(canonicalCard.getByTestId("resource-tier-draft")).toHaveCount(0);
  await expect(canonicalCard.getByTestId("resource-tier-toggle")).toHaveText(/Unpin/i);
  // Its tag chip shows the tag the row carries.
  await expect(canonicalCard.getByTestId("resource-tag-行业政策")).toBeVisible();

  // An untouched row still reads Draft and offers the pin gesture.
  const draftCard = page.locator(`[data-resource-id="${draft.id}"]`);
  await expect(draftCard.getByTestId("resource-tier-draft")).toBeVisible();
  await expect(draftCard.getByTestId("resource-tier-toggle")).toHaveText(/Pin as canonical/i);

  // The tier row filters by the same value.
  await page.getByTestId("resources-tier-canonical").click();
  await expect(page.getByTestId("resource-card")).toHaveCount(1);
  await expect(page.getByTestId("resource-card").first()).toContainText("graded.md");
});

// The tag gesture edits IN PLACE (add-unified-memory-and-outputs 3.2 follow-up:
// window.prompt blocked the page and could not be styled or cancelled with Esc).
test("the tag gesture edits in place and saves the parsed set", async ({ page }) => {
  const row = insertResource({ type: "file", title: "tagged.md", source: "manual", file_path: `${crypto.randomUUID()}/tagged.md`, tags: JSON.stringify(["旧标签"]) });
  await gotoResources(page);
  const card = page.locator(`[data-resource-id="${row.id}"]`);
  await expect(card.getByTestId("resource-tag-旧标签")).toBeVisible();

  await card.getByTestId("resource-tag-edit").click();
  const input = card.getByTestId("resource-tag-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("旧标签");

  // Esc closes without saving.
  await input.press("Escape");
  await expect(card.getByTestId("resource-tag-input")).toHaveCount(0);
  await expect(card.getByTestId("resource-tag-旧标签")).toBeVisible();

  // Enter saves: the client POSTs the parsed set (both , and ， split, capped
  // at five) and the chip row re-renders from the row it gets back. The route's
  // own write-to-fd-memory-then-mirror contract is covered by
  // scripts/test-resource-memory-gestures.mjs; here the write master is faked so
  // the CLIENT's payload and re-render are the thing under test.
  const posted = [];
  await page.route("**/api/resources/*/tags", async (route) => {
    posted.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ resource: { ...row, tags: JSON.stringify(["行业政策", "跨境电商"]) } }),
    });
  });
  await card.getByTestId("resource-tag-edit").click();
  await card.getByTestId("resource-tag-input").fill("行业政策，跨境电商");
  await card.getByTestId("resource-tag-input").press("Enter");
  await expect(card.getByTestId("resource-tag-input")).toHaveCount(0);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].tags, ["行业政策", "跨境电商"]);
  await expect(card.getByTestId("resource-tag-行业政策")).toBeVisible();
  await expect(card.getByTestId("resource-tag-跨境电商")).toBeVisible();
  await expect(card.getByTestId("resource-tag-旧标签")).toHaveCount(0);
});

// A deployment without a memory service: the first refused gesture greys all
// three with the degraded sentence (task 2.2's "灰态走降级句"), instead of
// throwing an error toast on every click.
test("a 503 from the memory gesture greys the gestures with the reason", async ({ page }) => {
  const row = insertResource({ type: "file", title: "nomemory.md", source: "manual", file_path: `${crypto.randomUUID()}/nomemory.md` });
  await page.route("**/api/resources/*/memory-remember", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "memory unavailable", code: "memory_unavailable" }) }),
  );
  await gotoResources(page);
  const card = page.locator(`[data-resource-id="${row.id}"]`);
  const remember = card.getByTestId("resource-remember");
  await expect(remember).toBeEnabled();

  await remember.click();
  await expect(remember).toBeDisabled();
  await expect(card.getByTestId("resource-tier-toggle")).toBeDisabled();
  await expect(card.getByTestId("resource-tag-edit")).toBeDisabled();
  await expect(remember).toHaveAttribute("title", /memory service/i);
});
