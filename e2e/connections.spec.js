// connections.spec.js — settings-connect-center acceptance: the aggregated
// /api/connections projection, the connections section surface, and the
// retired websearch deep link resolving into it.

import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { pinLocaleEn, tempDbPath } from "./helpers.js";

test.describe("GET /api/connections", () => {
  test("projects every connection with state only — no credential material", async ({ request }) => {
    const res = await request.get("/api/connections");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.connections)).toBeTruthy();

    const ids = body.connections.map((c) => c.id);
    // One entry per connect card / line row, plus search.
    for (const id of [
      "registry",
      "facet-market",
      "connector",
      "line-wire-customer",
      "line-lex",
      "ciyuan-account",
      "paper-trading",
      "search",
    ]) {
      expect(ids).toContain(id);
    }

    // Fresh hermetic store: nothing connected yet. Whitelist projection: the
    // four state fields only (search additionally carries userKey/shared; the
    // connector entry carries the binding projection added by
    // add-connector-bindings 6.1 — still states only, no credential material).
    for (const c of body.connections) {
      expect(["connected", "stale", "disconnected", "not-configured"]).toContain(c.state);
      if (c.id === "connector") {
        expect(Object.keys(c).sort()).toEqual(["bindingSummary", "bindings", "id", "name", "reason", "state"]);
      } else if (c.id !== "search") {
        expect(Object.keys(c).sort()).toEqual(["id", "name", "reason", "state"]);
      }
    }
    // No credential material anywhere in the payload, at any nesting.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/sk-|fdt_|oct_|Bearer\s|eyJ[A-Za-z0-9_-]{10,}/);
  });
});

test.describe("connections section", () => {
  test("renders glossary and every connect card; panel deep link highlights", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/connections");
    await expect(page.getByTestId("settings-section-connections")).toBeVisible();

    // Brand quick-reference: collapsed by default, expands in place.
    const glossary = page.getByTestId("connections-glossary");
    await expect(glossary).toBeVisible();
    await expect(glossary.getByTestId("connections-glossary").locator("dl")).toBeHidden();
    await glossary.locator("summary").click();
    await expect(glossary.locator("dl")).toBeVisible();

    // The connect cards moved here from the extensions market tab.
    await expect(page.getByTestId("registry-connect-panel")).toBeVisible();
    await expect(page.getByTestId("search-service-card")).toBeVisible();

    // Panel deep link scrolls to and marks the search card.
    await page.goto("/settings/connections?panel=search");
    await expect(page.getByTestId("search-service-card")).toBeVisible();
    const anchor = page.locator("[data-panel='search']");
    await expect(anchor).toHaveAttribute("data-panel-active", "true");

    // Unknown panel degrades gracefully.
    await page.goto("/settings/connections?panel=nonsense");
    await expect(page.getByTestId("settings-section-connections")).toBeVisible();
    await expect(page.locator("[data-panel-active='true']")).toHaveCount(0);
  });

  test("the scope pointer's panel id lands on the connector card", async ({ page }) => {
    // chat-connect-guidance 6.3 points scope gaps at `connector-bindings`
    // (credential-refs' panel map) while the card's own anchor is `connector`.
    // Both must resolve, or the "grant this" CTA opens the page and highlights
    // nothing.
    await pinLocaleEn(page);
    await page.goto("/settings/connections?panel=connector-bindings");
    await expect(page.getByTestId("connector-connect-panel")).toBeVisible();
    await expect(page.locator("[data-panel='connector']")).toHaveAttribute("data-panel-active", "true");
  });

  test("retired /settings/websearch redirects to the connections search panel", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/websearch");
    await expect(page).toHaveURL(/\/settings\/connections\?panel=search$/);
    await expect(page.getByTestId("search-service-card")).toBeVisible();
    // The BYOK zone moved verbatim (same testids as the former section).
    await expect(page.getByTestId("websearch-byok")).toBeVisible();
  });

  test("market tab is a pure shelf — no connect cards", async ({ page }) => {
    await pinLocaleEn(page);
    // unify-material-market: the tools shelf is the market's 工具 tab now, and
    // /settings/mcp redirects there (the modal never opens for it).
    await page.goto("/agents?tab=tools&sub=market");
    await expect(page.getByTestId("agent-market-tab-tools")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("mcp-market-section")).toBeVisible();
    await expect(page.getByTestId("registry-connect-panel")).toHaveCount(0);
    await expect(page.getByTestId("connector-connect-panel")).toHaveCount(0);
  });
});

// ── Binding view (add-connector-bindings 6.2) ────────────────────────────────
//
// The connector card leads with what the installed packs declare, and renders
// the ledger's four states as themselves. Seeded straight into the run's
// SQLite: the ledger is written by the install/grant flows, which this test is
// not about — here it is the rendering contract that is under test.

// Auth is off in the e2e run, so /api/connections answers for the machine-owner
// identity (registry-credentials ownerKey).
const OWNER = "machine-owner";

function seedLedger(rows) {
  // Migrations apply after the server starts answering, so wait for the table
  // instead of racing it (same reason as artifact-delivery.spec.js).
  const deadline = Date.now() + 60_000;
  for (;;) {
    const probe = new Database(tempDbPath());
    try {
      const ready = probe
        .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'connector_binding_ledger'")
        .get().c;
      if (ready === 1) {
        const now = new Date().toISOString();
        const insert = probe.prepare(
          `INSERT OR REPLACE INTO connector_binding_ledger
             (email, pack_id, pack_version, binding_key, provider, operations,
              connection_id, status, optional, granted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const r of rows) {
          insert.run(OWNER, r.packId, "1", r.key, r.provider, JSON.stringify(r.operations), r.connectionId ?? null, r.status, r.optional ? 1 : 0, r.grantedAt ?? null, now);
        }
        return;
      }
    } finally {
      probe.close();
    }
    if (Date.now() > deadline) throw new Error("connector_binding_ledger never appeared");
  }
}

// A live binding token. `granted` in the projection is asked of the credential,
// not inferred from the ledger, so the revoke action only exists when this row
// does — seeding the ledger alone would prove nothing about it.
function seedBindingToken(packId, bindingKey, token) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const probe = new Database(tempDbPath());
    try {
      const ready = probe
        .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'user_connector_credentials'")
        .get().c;
      if (ready === 1) {
        probe
          .prepare(
            `INSERT OR REPLACE INTO user_connector_credentials
               (email, kind, slot, token, pat_id, purpose, source_account, stale, active, updated_at)
             VALUES (?, 'binding', ?, ?, NULL, ?, NULL, 0, 0, ?)`,
          )
          .run(OWNER, `${packId}:${bindingKey}`, token, `e2e/${bindingKey}`, new Date().toISOString());
        return;
      }
    } finally {
      probe.close();
    }
    if (Date.now() > deadline) throw new Error("user_connector_credentials never appeared");
  }
}

// The console's address comes from the deployment baseline (mcp.json), which the
// hermetic e2e store does not have. Add one so the connect/reconnect links have
// somewhere real to point — the same row production carries.
function seedConnectorBaseline(origin) {
  const mcpPath = path.join(path.dirname(tempDbPath()), "mcp.json");
  const current = fs.existsSync(mcpPath) ? JSON.parse(fs.readFileSync(mcpPath, "utf8")) : {};
  current.mcpServers = current.mcpServers ?? {};
  current.mcpServers.connector = { url: `${origin}/mcp`, credentialRef: "connector" };
  fs.writeFileSync(mcpPath, JSON.stringify(current, null, 2));
}

test.describe("connector binding view", () => {
  test("four states render distinctly; unwired reads as a capability gap; account area stays", async ({ page }) => {
    seedConnectorBaseline("https://connector.e2e.test");
    seedLedger([
      // Granted: a live token exists, so the row offers revoke + shows when.
      { packId: "pack-e2e", key: "kingdee", provider: "kingdee", operations: ["read", "write"], status: "satisfied", optional: false, connectionId: "conn-e2e", grantedAt: "2026-11-01T00:00:00.000Z" },
      // Satisfied but never granted: the one-click grant is what is missing.
      { packId: "pack-e2e", key: "alipay", provider: "alipay", operations: ["read"], status: "satisfied", optional: false, connectionId: "conn-al" },
      { packId: "pack-e2e", key: "wms", provider: "wms", operations: ["read"], status: "missing", optional: false },
      { packId: "pack-e2e", key: "erp-legacy", provider: "erp-legacy", operations: ["read"], status: "stale", optional: false },
      { packId: "pack-e2e", key: "carrier", provider: "carrier", operations: ["read"], status: "unwired", optional: true },
      // A key the pack no longer declares: history, not a requirement.
      { packId: "pack-e2e", key: "gone", provider: "gone", operations: ["read"], status: "deprecated", optional: false },
    ]);
    seedBindingToken("pack-e2e", "kingdee", "oct_e2e_kingdee");

    await pinLocaleEn(page);
    await page.goto("/settings/connections");
    const view = page.getByTestId("connector-bindings-view");
    await expect(view).toBeVisible();

    // Summary excludes the deprecated row: 1 pack, 5 live bindings, 2 the user
    // owes (missing + stale; the unwired one is optional), 1 capability gap.
    await expect(page.getByTestId("connector-bindings-summary")).toHaveText(
      "1 packs · 5 bindings · 2 to resolve · 1 capability gaps",
    );

    const row = (key) => page.locator(`[data-testid='connector-binding-row'][data-binding-key='${key}']`);
    await expect(row("kingdee")).toHaveAttribute("data-state", "satisfied");
    await expect(row("kingdee").getByTestId("connector-binding-state")).toHaveText("Connected");
    await expect(row("wms")).toHaveAttribute("data-state", "missing");
    await expect(row("wms").getByTestId("connector-binding-state")).toHaveText("Not connected");
    await expect(row("erp-legacy")).toHaveAttribute("data-state", "stale");
    await expect(row("erp-legacy").getByTestId("connector-binding-state")).toHaveText("Expired");
    await expect(row("carrier")).toHaveAttribute("data-state", "unwired");
    await expect(row("carrier").getByTestId("connector-binding-state")).toHaveText("Capability gap");
    await expect(row("carrier").getByTestId("connector-binding-optional")).toBeVisible();

    // `unwired` never degrades to `missing`, and it explains itself: no account
    // closes a catalog gap, so the hint must say so rather than send the user to
    // the connect button.
    await expect(page.getByTestId("connector-bindings-unwired-hint")).toBeVisible();
    await expect(row("wms").getByTestId("connector-binding-state")).not.toHaveText("Capability gap");

    await expect(page.locator("[data-testid='connector-binding-row'][data-binding-key='gone']")).toHaveCount(0);

    // ── The one action each row offers (6.2) ────────────────────────────────
    const action = (key) => row(key).getByTestId("connector-binding-action");

    // Granted: revoke, plus when it was granted.
    await expect(row("kingdee")).toHaveAttribute("data-granted", "1");
    await expect(action("kingdee")).toHaveAttribute("data-action", "revoke");
    await expect(action("kingdee")).toHaveText("Revoke access");
    await expect(row("kingdee").getByTestId("connector-binding-granted-at")).toBeVisible();

    // Satisfied but never granted: the missing step is the grant itself.
    await expect(row("alipay")).toHaveAttribute("data-granted", "0");
    await expect(action("alipay")).toHaveAttribute("data-action", "grant");
    await expect(action("alipay")).toHaveText("Grant access");

    // A dead or absent connection is repaired in the connector console; both
    // point at the baseline origin's /me shell.
    await expect(action("wms")).toHaveAttribute("data-action", "connect");
    await expect(action("wms")).toHaveAttribute("href", "https://connector.e2e.test/me");
    await expect(action("erp-legacy")).toHaveAttribute("data-action", "reconnect");
    await expect(action("erp-legacy")).toHaveAttribute("href", "https://connector.e2e.test/me");

    // No gesture closes a catalog gap, and an outage is not a todo: neither row
    // offers an action at all (a dead button would be worse than none).
    await expect(row("carrier").getByTestId("connector-binding-action")).toHaveCount(0);

    // Bindings lead, the account area follows — and the manual-paste fallback
    // (always available, console link needs a baseline connector row) is intact.
    await expect(page.getByTestId("connector-connect-panel")).toBeVisible();
    await expect(page.getByTestId("connector-paste-toggle")).toBeVisible();
  });

  // ── add-connector-role-mapping 5.1/5.2 ────────────────────────────────────
  //
  // A role binding names a need ("a WMS"); the customer names the system. The
  // three states that must not be confused live here: `unmapped` (choose one),
  // `unwired` (the chosen one cannot serve it), `missing` (it is gone). The
  // picker's data and the transition are stubbed at the API seam — the server
  // half is covered by scripts/test-connector-role-mapping.mjs; what is under
  // test here is that the card asks for a choice instead of sending the user to
  // connect a system they never picked.
  test("a role binding offers a system picker; choosing turns the row connected", async ({ page }) => {
    seedConnectorBaseline("https://connector.e2e.test");
    let chosen = null;
    const roleRow = (status) => ({
      packId: "pack-role",
      key: "warehouse",
      provider: status === "unmapped" ? "wms" : "wangdian",
      role: "wms",
      providerRole: true,
      operations: ["read"],
      status,
      optional: false,
      granted: false,
      grantedAt: null,
    });

    // Everything except the binding projection stays real (baseline, accounts):
    // only the ledger view is replaced, so the row states are exactly ours.
    await page.route("**/api/connections", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const connector = (body.connections ?? []).find((c) => c.id === "connector");
      if (connector) {
        const status = chosen ? "satisfied" : "unmapped";
        connector.bindings = [roleRow(status)];
        connector.bindingSummary = {
          packs: 1,
          bindings: 1,
          unresolved: chosen ? 0 : 1,
          unwired: 0,
          unmapped: chosen ? 0 : 1,
        };
      }
      await route.fulfill({ response, json: body });
    });

    await page.route("**/api/connector/role-mappings", async (route) => {
      await route.fulfill({
        json: {
          mappings: [
            {
              role: "wms",
              operations: ["read"],
              packs: ["pack-role"],
              optional: false,
              provider: chosen,
              updatedAt: chosen ? "2026-11-08T00:00:00.000Z" : null,
              candidates: [
                { provider: "wangdian", connectionName: "仓库A" },
                { provider: "kuaidi100", connectionName: "快递" },
              ],
              rejected: [{ provider: "acme", gaps: ["read"] }],
              candidatesState: { ok: true },
            },
          ],
        },
      });
    });

    let put = null;
    await page.route("**/api/connector/role-mappings/*", async (route) => {
      put = { method: route.request().method(), url: route.request().url(), body: route.request().postDataJSON() };
      chosen = put.body.provider;
      await route.fulfill({ json: { ok: true, mapping: { role: "wms", provider: chosen } } });
    });

    await pinLocaleEn(page);
    await page.goto("/settings/connections");
    const row = page.locator("[data-testid='connector-binding-row'][data-binding-key='warehouse']");
    await expect(row).toHaveAttribute("data-state", "unmapped");
    await expect(row).toHaveAttribute("data-role", "wms");

    // 5.2: the copy and the action are the choice ones — not "capability gap",
    // not "not connected", and no console link for a system nobody picked.
    await expect(row.getByTestId("connector-binding-state")).toHaveText("Choose a system");
    await expect(row.getByTestId("connector-binding-action")).toHaveAttribute("data-action", "choose");
    await expect(row.locator("[data-testid='connector-binding-action'][data-action='connect']")).toHaveCount(0);
    await expect(page.getByTestId("connector-bindings-unmapped-hint")).toBeVisible();
    await expect(page.getByTestId("connector-bindings-unmapped")).toHaveText("1 waiting for your choice");
    await expect(page.getByTestId("connector-bindings-unwired-hint")).toHaveCount(0);

    // The picker offers only the systems the API said are usable.
    const select = row.getByTestId("connector-binding-choose");
    await expect(select.locator("option")).toHaveCount(3); // placeholder + 2 candidates
    await select.selectOption("wangdian");
    await row.getByTestId("connector-binding-action").click();

    await expect.poll(() => put?.body?.provider).toBe("wangdian");
    expect(put.method).toBe("PUT");
    expect(put.url).toContain("/api/connector/role-mappings/wms");

    // Choosing is the whole repair: the row re-reads as connected, and the next
    // missing step is the grant (the system is authorized, the pack is not).
    await expect(row).toHaveAttribute("data-state", "satisfied");
    await expect(row.getByTestId("connector-binding-state")).toHaveText("Connected");
    await expect(row.getByTestId("connector-binding-action")).toHaveAttribute("data-action", "grant");
    await expect(page.getByTestId("connector-bindings-unmapped")).toHaveCount(0);
  });

  test("a role binding whose chosen system stopped working offers 'Change system', not 'connect'", async ({ page }) => {
    seedConnectorBaseline("https://connector.e2e.test");
    await page.route("**/api/connections", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const connector = (body.connections ?? []).find((c) => c.id === "connector");
      if (connector) {
        connector.bindings = [
          {
            packId: "pack-role",
            key: "warehouse",
            provider: "wangdian",
            role: "wms",
            providerRole: true,
            operations: ["read", "write"],
            status: "unwired",
            optional: false,
            granted: false,
            grantedAt: null,
          },
        ];
        connector.bindingSummary = { packs: 1, bindings: 1, unresolved: 1, unwired: 1, unmapped: 0 };
      }
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/connector/role-mappings", async (route) => {
      await route.fulfill({
        json: {
          mappings: [
            {
              role: "wms",
              operations: ["read", "write"],
              packs: ["pack-role"],
              optional: false,
              provider: "wangdian",
              updatedAt: "2026-11-08T00:00:00.000Z",
              // Connected, but read-only: it cannot serve the declared write.
              candidates: [{ provider: "kuaidi100", connectionName: "快递" }],
              rejected: [{ provider: "wangdian", gaps: ["write"] }],
              candidatesState: { ok: true },
            },
          ],
        },
      });
    });

    await pinLocaleEn(page);
    await page.goto("/settings/connections");
    const row = page.locator("[data-testid='connector-binding-row'][data-binding-key='warehouse']");

    await expect(row).toHaveAttribute("data-state", "unwired");
    await expect(row.getByTestId("connector-binding-state")).toHaveText("Capability gap");
    // Unknown provider is a real state the user can fix by choosing again — the
    // row keeps offering the choice, and the current (unusable) one stays visible
    // so the card does not look like nothing was ever chosen.
    const select = row.getByTestId("connector-binding-choose");
    await expect(select.locator("option")).toHaveCount(2); // current-but-unusable + 1 candidate
    await expect(row.getByTestId("connector-binding-action")).toHaveAttribute("data-action", "choose");
    await expect(row.getByTestId("connector-binding-action")).toHaveText("Change system");
    await expect(page.getByTestId("connector-bindings-unwired-hint")).toBeVisible();
  });

  // A role whose candidate list is empty because the connected systems cannot
  // cover the declared classes: the card must say WHICH system and WHAT is
  // missing. Telling the user "connect one" when they already connected the
  // right kind of system sends them in a circle.
  test("no usable candidate names the system that falls short and what it lacks", async ({ page }) => {
    seedConnectorBaseline("https://connector.e2e.test");
    await page.route("**/api/connections", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const connector = (body.connections ?? []).find((c) => c.id === "connector");
      if (connector) {
        connector.bindings = [
          {
            packId: "pack-role",
            key: "warehouse",
            provider: "wms",
            role: "wms",
            providerRole: true,
            operations: ["read", "write"],
            status: "unmapped",
            optional: false,
            granted: false,
            grantedAt: null,
          },
        ];
        connector.bindingSummary = { packs: 1, bindings: 1, unresolved: 1, unwired: 0, unmapped: 1 };
      }
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/connector/role-mappings", async (route) => {
      await route.fulfill({
        json: {
          mappings: [
            {
              role: "wms",
              operations: ["read", "write"],
              packs: ["pack-role"],
              optional: false,
              provider: null,
              updatedAt: null,
              // Connected, but read-only → not offerable for a read+write binding.
              candidates: [],
              rejected: [{ provider: "wangdian", gaps: ["write"] }],
              candidatesState: { ok: true },
            },
          ],
        },
      });
    });

    await pinLocaleEn(page);
    await page.goto("/settings/connections");
    const row = page.locator("[data-testid='connector-binding-row'][data-binding-key='warehouse']");

    // The picker is replaced by an explanation, not by a dead dropdown.
    await expect(row.getByTestId("connector-binding-choose")).toHaveCount(0);
    const empty = row.getByTestId("connector-binding-choose-empty");
    await expect(empty).toContainText("cannot serve what this pack needs");
    const rejected = row.locator("[data-testid='connector-binding-choose-rejected']");
    await expect(rejected).toHaveAttribute("data-provider", "wangdian");
    await expect(rejected).toHaveAttribute("data-gaps", "write");
    await expect(rejected).toContainText("missing write");
  });
});
