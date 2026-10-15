import { test, expect } from "@playwright/test";
import { E2E_PORT, gotoChat, pinLocaleEn } from "./helpers.js";

// Library page UI contract (rebuild-knowledge-as-file-library): no query box
// anywhere; per-file and per-collection "Start conversation" actions hand off
// to the chat composer with an @doc:/@collection: token; a row sitting
// non-terminal for too long shows the stuck warning. Rows come from the real
// REST surface (upload + collections via the request fixture) so the page is
// exercised through its actual data path.

const API = `http://127.0.0.1:${E2E_PORT}`;

test.describe("library page", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
  });

  test("no query interface; converse actions hand off to the composer", async ({ page, request }) => {
    const up = await request.post(`${API}/api/documents`, {
      multipart: {
        file: {
          name: "handoff-guide.md",
          mimeType: "text/markdown",
          buffer: Buffer.from("# Handoff Guide\n\nContent for the composer handoff test."),
        },
      },
    });
    const { id: docId } = await up.json();
    const col = await request.post(`${API}/api/collections`, { data: { name: "Handoff Set" } });
    const { id: colId } = await col.json();
    await request.post(`${API}/api/collections/${colId}/documents`, { data: { documentId: docId } });

    await gotoChat(page);
    await page.goto("/knowledge");
    await expect(page.getByTestId("doc-row").filter({ hasText: "handoff-guide.md" })).toBeVisible({
      timeout: 15000,
    });

    // The page-level QA surface is gone entirely.
    await expect(page.getByTestId("doc-query-input")).toHaveCount(0);
    await expect(page.getByTestId("col-query-input")).toHaveCount(0);

    // File-level handoff: composer pre-filled with the @doc: token.
    await page.getByTestId("doc-row").filter({ hasText: "handoff-guide.md" }).getByTestId("doc-converse").click();
    await expect(page).toHaveURL(/\/chat$/);
    const composer = page.locator("textarea").last();
    await expect(composer).toHaveValue(new RegExp(`^@doc:${docId}\\s`));
    // Consume-once: leaving and returning to chat must not re-inject the draft.
    await page.goto("/knowledge");
    await page.goto("/chat");
    await expect(composer).toHaveValue("");

    // Collection-level handoff: @collection: token.
    await page.goto("/knowledge");
    await page.getByTestId("col-item").filter({ hasText: "Handoff Set" }).getByTestId("col-converse").click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(composer).toHaveValue(new RegExp(`^@collection:${colId}\\s`));

    await request.delete(`${API}/api/documents/${docId}`);
    await request.delete(`${API}/api/collections/${colId}`);
  });

  test("a non-terminal row older than the bound shows the stuck warning", async ({ page, request }) => {
    const up = await request.post(`${API}/api/documents`, {
      multipart: {
        file: {
          name: "stuck-real.md",
          mimeType: "text/markdown",
          buffer: Buffer.from("# Real\n\nA real ready row for layout context."),
        },
      },
    });
    const { id: realId } = await up.json();

    await gotoChat(page);
    await page.goto("/knowledge");
    await expect(page.getByTestId("doc-row").filter({ hasText: "stuck-real.md" })).toBeVisible({
      timeout: 15000,
    });

    // With sync ingest the server never emits stuck rows — inject two fake
    // ones through the e2e seam AFTER load() has run (no re-fetch follows).
    await page.evaluate(
      ({ realId: rid }) => {
        window.__documentsStore.setState((s) => ({
          documents: [
            ...s.documents,
            { id: "fresh-fake", name: "fresh.md", type: "markdown", status: "queued", addedAt: new Date().toISOString() },
            { id: "old-fake", name: "old.md", type: "markdown", status: "indexing", addedAt: new Date(Date.now() - 120_000).toISOString() },
          ],
          collections: s.collections,
        }));
        void rid;
      },
      { realId },
    );

    await expect(page.getByTestId("doc-stuck")).toHaveCount(1);
    const stuckRow = page.getByTestId("doc-row").filter({ has: page.getByTestId("doc-stuck") });
    await expect(stuckRow).toHaveAttribute("data-doc-id", "old-fake");
    // Non-ready docs cannot start a conversation; the real ready one can.
    await expect(
      page.getByTestId("doc-row").filter({ hasText: "old.md" }).getByTestId("doc-converse"),
    ).toBeDisabled();
    await expect(
      page.getByTestId("doc-row").filter({ hasText: "stuck-real.md" }).getByTestId("doc-converse"),
    ).toBeEnabled();

    await request.delete(`${API}/api/documents/${realId}`);
  });
});
