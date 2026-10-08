import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { gotoChat, tempDbPath } from "./helpers.js";

// Session open performance (openspec: perf-session-open): the optimistic
// switch (skeleton, stale-load guard, error restore), the client session
// cache (instant re-entry), render windowing (load-earlier, outline
// expansion), and the preview drawer's busy states. No LLM calls: sessions
// are seeded straight into the throwaway SQLite store, turn-level UI is
// driven through the e2e `window.__chatStore` seam, and the WS is
// route-intercepted where a held `session_loaded` is the only way to observe
// the pre-load state deterministically.

const now = new Date().toISOString();

// Seed a session with alternating user/assistant messages directly into the
// run's SQLite chat store. The server reads live from the DB on every
// list/get, so the next connect (page reload) sees the rows. The workspace
// stamp matches the boot workspace so the rows land in the sidebar group
// that auto-expands (the current workspace's), not under collapsed Ungrouped.
const BOOT_WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function seedSession(id, title, pairs) {
  const db = new Database(tempDbPath());
  try {
    db.prepare(
      `INSERT OR REPLACE INTO chat_sessions (id, title, created_at, updated_at, workspace) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, title, now, now, BOOT_WORKSPACE);
    const insert = db.prepare(
      `INSERT INTO chat_messages (session_id, role, content, seq, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    let seq = 0;
    for (const [role, content] of pairs) {
      insert.run(id, role, content, ++seq, now);
    }
  } finally {
    db.close();
  }
}

// Transparent WS proxy with the ability to HOLD server frames: a
// `session_loaded` for a held id is swallowed (and replayed on release), so
// the client's post-click state — skeleton or cached transcript — can be
// asserted without racing the local server's sub-frame responses.
async function interceptWs(page) {
  const holds = new Map(); // session id -> frames still to swallow
  const held = []; // swallowed frames awaiting release
  // After release, stop holding entirely: the assertions between click and
  // release can complete faster than the server's session_loaded round-trip,
  // so a late frame must not get trapped behind an already-spent release.
  let passthrough = false;
  let server = null;
  let client = null; // page-side route of the CURRENT connection (reconnects replace it)
  await page.routeWebSocket(/.*/, (ws) => {
    client = ws;
    server = ws.connectToServer();
    ws.onMessage((data) => server?.send(data));
    // Server → page: symmetric onMessage on the server-side route; forwarding
    // to the page is explicit (ws.send) once this handler exists.
    server.onMessage((data) => {
      let msg = null;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        /* control frames won't parse; forward below */
      }
      const remaining = holds.get(msg?.id);
      if (!passthrough && msg?.type === "session_loaded" && remaining > 0) {
        holds.set(msg.id, remaining - 1);
        held.push(data);
        return;
      }
      client?.send(data);
    });
  });
  return {
    holdLoadsFor: (id, count = 1) => holds.set(id, count),
    release: () => {
      passthrough = true;
      for (const frame of held.splice(0)) client?.send(frame);
    },
  };
}

const storeState = (page) =>
  page.evaluate(() => {
    const s = window.__chatStore.getState();
    return {
      current: s.currentSessionId,
      pending: s.pendingSession,
      turnCount: s.turns.length,
      cached: [...s.sessionCache.keys()],
    };
  });

// Open a seeded session and wait for its transcript. A dsh child restart left
// over from an earlier spec can refuse the first switch ("Agent is still
// initializing" → the store restores); a re-click retries once the runtime is
// back — the same recovery a user performs.
async function openSessionAndWaitText(page, id, text) {
  for (let attempt = 0; ; attempt++) {
    await page.locator(`[data-testid="session-row"][data-session-id="${id}"]`).click();
    try {
      await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 15_000 });
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
}

test.describe("optimistic session switch", () => {
  test("clicking a sidebar row shows the skeleton immediately and resolves into the session", async ({
    page,
  }) => {
    seedSession("e2e-perf-a", "Perf A", [
      ["user", "alpha one"],
      ["assistant", "answer to alpha one"],
    ]);
    seedSession("e2e-perf-b", "Perf B", [
      ["user", "beta one"],
      ["assistant", "answer to beta one"],
    ]);
    const ws = await interceptWs(page);
    await gotoChat(page);

    // Open A normally — it becomes the displayed transcript.
    await openSessionAndWaitText(page, "e2e-perf-a", "alpha one");

    // Switch to B with its load held: the click itself must have moved the
    // view — skeleton for B, A's transcript gone, pending armed in the store.
    ws.holdLoadsFor("e2e-perf-b");
    await page.locator('[data-testid="session-row"][data-session-id="e2e-perf-b"]').click();
    await expect(page.getByTestId("session-pending-skeleton")).toBeVisible();
    await expect(page.getByText("alpha one", { exact: true })).toHaveCount(0);
    expect(await storeState(page)).toMatchObject({
      current: "e2e-perf-b",
      pending: "e2e-perf-b",
      turnCount: 0,
    });

    // Release the held load: the skeleton resolves into B's transcript.
    ws.release();
    await expect(page.getByText("beta one", { exact: true })).toBeVisible({ timeout: 5000 });
    expect(await storeState(page)).toMatchObject({ current: "e2e-perf-b", pending: null });
  });

  test("a switch to an unknown session errors and restores the previous view", async ({ page }) => {
    seedSession("e2e-perf-c", "Perf C", [
      ["user", "gamma one"],
      ["assistant", "answer to gamma one"],
    ]);
    await gotoChat(page);

    await openSessionAndWaitText(page, "e2e-perf-c", "gamma one");

    // A deep link to a session that does not exist — driven as an in-app URL
    // change (pushState + popstate), not page.goto: a full reload would reset
    // the store and the restore-under-test along with it. The deep-link
    // effect sends the switch, the server refuses, the store restores C.
    await page.evaluate(() => {
      window.history.pushState({}, "", "/chat/e2e-perf-missing");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect
      .poll(async () => (await storeState(page)).pending, { timeout: 5000 })
      .toBe(null);
    expect(await storeState(page)).toMatchObject({ current: "e2e-perf-c" });
    await expect(page.getByText("gamma one", { exact: true })).toBeVisible();
    await expect(page.getByTestId("toast").first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe("client session cache", () => {
  test("A→B→A renders A instantly from cache while the refresh is still in flight", async ({
    page,
  }) => {
    seedSession("e2e-perf-a", "Perf A", [
      ["user", "alpha one"],
      ["assistant", "answer to alpha one"],
    ]);
    seedSession("e2e-perf-b", "Perf B", [
      ["user", "beta one"],
      ["assistant", "answer to beta one"],
    ]);
    const ws = await interceptWs(page);
    await gotoChat(page);

    // Visit A, then B — both land in the cache.
    await openSessionAndWaitText(page, "e2e-perf-a", "alpha one");
    await openSessionAndWaitText(page, "e2e-perf-b", "beta one");
    expect(await storeState(page)).toMatchObject({ cached: expect.arrayContaining(["e2e-perf-a", "e2e-perf-b"]) });

    // Re-enter A with its refresh load HELD: the cached transcript renders
    // with zero server delivery, and the refresh stays armed.
    ws.holdLoadsFor("e2e-perf-a");
    await page.locator('[data-testid="session-row"][data-session-id="e2e-perf-a"]').click();
    await expect(page.getByText("alpha one", { exact: true })).toBeVisible();
    await expect(page.getByText("beta one", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("session-pending-skeleton")).toHaveCount(0);
    expect(await storeState(page)).toMatchObject({ current: "e2e-perf-a", pending: "e2e-perf-a" });

    // The refresh lands (releases the held frame) and reconciles in place.
    ws.release();
    await expect
      .poll(async () => (await storeState(page)).pending, { timeout: 5000 })
      .toBe(null);
    await expect(page.getByText("alpha one", { exact: true })).toBeVisible();
  });
});

test.describe("render windowing", () => {
  const inject = (page, messages) =>
    page.evaluate((msgs) => {
      const apply = window.__chatStore.getState().apply;
      for (const m of msgs) apply(m);
    }, messages);

  // 80 answered pairs = 160 turns: windowing must show only the last 50
  // entries (25 pairs) with the rest behind load-earlier.
  function longConversationMessages(pairs) {
    const msgs = [];
    for (let i = 0; i < pairs; i++) {
      const q = `prompt-${String(i).padStart(3, "0")}`;
      msgs.push({ type: "user", text: q });
      msgs.push({ type: "agent_start" });
      msgs.push({ type: "text", delta: `answer ${q}` });
      msgs.push({ type: "done" });
    }
    return msgs;
  }

  test("only the last 50 turns mount; load-earlier prepends with scroll anchored", async ({
    page,
  }) => {
    await gotoChat(page);
    await inject(page, longConversationMessages(80));

    // The tail pair renders; everything above the window does not.
    await expect(page.getByText("prompt-079", { exact: true })).toBeVisible();
    await expect(page.getByText("prompt-055", { exact: true })).toBeVisible();
    await expect(page.getByText("prompt-054", { exact: true })).toHaveCount(0);
    const earlier = page.getByTestId("load-earlier");
    await expect(earlier).toBeVisible();
    await expect(earlier).toContainText("110");

    // Scroll anchor: scrollTop must grow by exactly the prepended height —
    // the content the user was looking at stays at its viewport position.
    // (Playwright's click scrolls the button into view first, so pin the log
    // at the top and compare the geometry the anchor preserves.)
    const log = page.getByTestId("chat-log");
    await log.evaluate((el) => {
      el.scrollTop = 0;
    });
    const before = await log.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }));
    await earlier.click();
    await expect(page.getByText("prompt-030", { exact: true })).toBeVisible();
    await expect(page.getByText("prompt-029", { exact: true })).toHaveCount(0);
    await expect(earlier).toContainText("60");
    const after = await log.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }));
    const prepended = after.height - before.height;
    expect(prepended).toBeGreaterThan(500);
    expect(Math.abs(after.top - (before.top + prepended))).toBeLessThan(4);

    // Further batches reach the head of the conversation: 160 entries need
    // three expansions (50 → 100 → 150 → all). At 150, the five OLDEST pairs
    // (user entries 0–9) are still hidden.
    await earlier.click();
    await expect(page.getByText("prompt-005", { exact: true })).toBeVisible();
    await expect(page.getByText("prompt-004", { exact: true })).toHaveCount(0);
    await earlier.click();
    await expect(page.getByText("prompt-000", { exact: true })).toBeVisible();
  });

  test("an outline jump to a windowed-out turn expands the window", async ({ page }) => {
    await gotoChat(page);
    await inject(page, longConversationMessages(80));

    // The outline reads the complete list — the first entry is turn 0, which
    // is not mounted. Jumping to it must expand the window and flash it.
    await page.getByTestId("chat-outline-edge").hover();
    const first = page.getByTestId("chat-outline-entry").first();
    await expect(first).toContainText("prompt-000");
    const targetId = await first.getAttribute("data-turn-id");
    await first.click();
    const anchor = page.locator(`#turn-${targetId}`);
    await expect(anchor).toBeVisible();
    await expect(anchor).toHaveClass(/outline-jump-flash/);
  });

  test("a long session loaded from the server opens windowed", async ({ page }) => {
    // 120 user-only messages: the real session_loaded path (SQLite → WS →
    // store → render) with a 120-turn transcript.
    const pairs = [];
    for (let i = 0; i < 120; i++) pairs.push(["user", `prompt-${String(i).padStart(3, "0")}`]);
    seedSession("e2e-perf-long", "Perf Long", pairs);
    await gotoChat(page);

    await openSessionAndWaitText(page, "e2e-perf-long", "prompt-119");
    await expect(page.getByText("prompt-070", { exact: true })).toBeVisible();
    await expect(page.getByText("prompt-069", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("load-earlier")).toContainText("70");

    // The transcript opens scrolled to the bottom (spec: long-session open).
    const atBottom = await page.getByTestId("chat-log").evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80,
    );
    expect(atBottom).toBe(true);
  });
});

// A 1x1 transparent PNG — the image renderer's busy state test needs a real
// decodable image served slowly.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("preview drawer busy states", () => {
  // The drawer is opened through the workspace path the production surfaces
  // use for produced files: a markdown link in an assistant turn. The e2e
  // server's workspace is the repo root, so the fixture files are written
  // there (and removed after) — no upload round-trip, no document ingestion.
  async function workspaceFileAndLink(page, name, bytes) {
    const abs = path.join(BOOT_WORKSPACE, name);
    fs.writeFileSync(abs, bytes);
    await page.evaluate(
      ([n]) => {
        const apply = window.__chatStore.getState().apply;
        apply({ type: "user", text: `show me ${n}` });
        apply({ type: "agent_start" });
        apply({ type: "text", delta: `[open ${n}](${n})` });
        apply({ type: "done" });
      },
      [name],
    );
    const link = page.getByRole("link", { name: `open ${name}` });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByTestId("preview-drawer")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("preview-name")).toHaveText(name);
    return () => fs.rmSync(abs, { force: true });
  }

  test("a slow image preview shows the busy indicator, then the image", async ({ page }) => {
    await gotoChat(page);
    // Delay every /api/files response by 2s — the drawer's image fetch
    // included, which is exactly the slow/large file case. Generous on
    // purpose: under a full-suite load the assertion round-trips alone can
    // eat hundreds of milliseconds.
    await page.route("**/api/files*", async (route) => {
      await page.waitForTimeout(2000);
      await route.continue();
    });
    const name = `paas-slow-${Date.now()}.png`;
    const cleanup = await workspaceFileAndLink(page, name, PNG_BYTES);

    try {
      await expect(page.getByTestId("preview-loading")).toBeVisible({ timeout: 3000 });
      await expect(page.getByTestId("preview-image")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("preview-loading")).toHaveCount(0);
    } finally {
      cleanup();
    }
  });

  test("a download completes via the fetched blob path", async ({ page }) => {
    await gotoChat(page);
    const name = `paas-dl-${Date.now()}.png`;
    const cleanup = await workspaceFileAndLink(page, name, PNG_BYTES);

    try {
      const download = page.waitForEvent("download");
      await page.getByTestId("preview-download").click();
      const dl = await download;
      expect(dl.suggestedFilename()).toBe(name);
    } finally {
      cleanup();
    }
  });

  test("a download whose fetch fails still downloads via the plain-anchor fallback", async ({
    page,
  }) => {
    await gotoChat(page);
    // A kind with no renderer (DownloadOnly terminal state), reached via the
    // raw file-route href — linkRef's previewable-extension rule doesn't gate
    // route refs, so the drawer still opens for it.
    const name = `paas-fallback-${Date.now()}.zip`;
    const abs = path.join(BOOT_WORKSPACE, name);
    fs.writeFileSync(abs, Buffer.from("not a real zip"));
    await page.evaluate(
      ([n]) => {
        const apply = window.__chatStore.getState().apply;
        apply({ type: "user", text: `hand me ${n}` });
        apply({ type: "agent_start" });
        apply({ type: "text", delta: `[get ${n}](/api/files?root=workspace&path=${n})` });
        apply({ type: "done" });
      },
      [name],
    );
    const link = page.getByRole("link", { name: `get ${name}` });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByTestId("preview-drawer")).toBeVisible({ timeout: 10_000 });

    // Abort the FIRST /api/files request (the fetched download), let the
    // fallback anchor's own request through.
    let requests = 0;
    await page.route("**/api/files*", async (route) => {
      if (requests++ === 0) await route.abort();
      else await route.fallback();
    });

    try {
      const download = page.waitForEvent("download");
      await page.getByTestId("preview-fallback-download").click();
      const dl = await download;
      expect(dl.suggestedFilename()).toBe(name);
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });
});
