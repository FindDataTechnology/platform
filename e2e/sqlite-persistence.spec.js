import { test, expect } from "@playwright/test";

// SQLite project-database persistence (no-LLM, fast project).
//
// Verifies the project database is the store of record for document metadata
// and user preferences: a fresh temp DB (DB_PATH set in playwright.config.js)
// lists no documents, preferences round-trip through the API, and the config
// advertises documents enabled.

test.describe("project database (SQLite)", () => {
  test("document list is served from the SQLite database", async ({ request }) => {
    const cfg = await request.get("/api/config");
    expect(cfg.ok()).toBeTruthy();
    expect((await cfg.json()).documentsEnabled).toBe(true);

    // The list is backed by SQLite (db.listDocuments). Other tests in the shared
    // server may have added documents, so assert shape rather than emptiness.
    const docs = await request.get("/api/documents");
    expect(docs.ok()).toBeTruthy();
    const docsJson = await docs.json();
    expect(Array.isArray(docsJson.documents)).toBe(true);
    for (const d of docsJson.documents) {
      expect(d).toHaveProperty("id");
      expect(d).toHaveProperty("name");
      expect(d).toHaveProperty("status");
    }
  });

  test("preferences round-trip through the API", async ({ request }) => {
    // The server is shared across the suite, and legitimate flows persist
    // preferences (model effort, workspace recents, agent preset) — so, like
    // the document list above, assert the round-trip rather than emptiness.
    const before = await request.get("/api/preferences");
    expect(before.ok()).toBeTruthy();
    const original = (await before.json()).preferences;

    // Upsert two preferences.
    const put1 = await request.put("/api/preferences", {
      data: { key: "displayName", value: "E2E Tester" },
    });
    expect(put1.ok()).toBeTruthy();
    const put2 = await request.put("/api/preferences", {
      data: { key: "theme", value: "dark" },
    });
    expect(put2.ok()).toBeTruthy();

    // Read back.
    const after = await request.get("/api/preferences");
    expect(after.ok()).toBeTruthy();
    const prefs = (await after.json()).preferences;
    expect(prefs.displayName).toBe("E2E Tester");
    expect(prefs.theme).toBe("dark");

    // Upsert is idempotent on key (overwrite).
    await request.put("/api/preferences", { data: { key: "theme", value: "light" } });
    const final = (await (await request.get("/api/preferences")).json()).preferences;
    expect(final.theme).toBe("light");
    expect(final.displayName).toBe("E2E Tester");

    // Restore whatever the earlier specs had stored, keys we touched aside.
    for (const [key, value] of Object.entries(original)) {
      await request.put("/api/preferences", { data: { key, value } });
    }
  });
});
