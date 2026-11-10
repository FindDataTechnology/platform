// The facet shell smoke sentinel (fix-facet-packs-crash): the thin shell
// borrows 壹座 pack components verbatim and mounts NO router (facet-platform:
// "the shell SHALL add no router dependency"). This spec is the net that
// catches a host-side change — e.g. a routing hook creeping into a borrowed
// component (exactly what blanked production #/packs on 2026-10-11) — before
// it ships. Served by e2e/facet-shell-server.mjs (real facet service,
// anonymous face, one seeded public pack, src-built shell bundle).
import { expect, test } from "@playwright/test";

const base = `http://127.0.0.1:${process.env.E2E_FACET_SHELL_PORT || 3209}`;

test("all four shell views render without a routing provider", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  // Pin zh-CN: the infra views' copy assertions below read Chinese strings
  // (the shell's locale store, same key the 壹座 suite uses).
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));

  // intro: the landing carries its CTAs and the footer ladder.
  await page.goto(`${base}/#/`);
  await expect(page.getByTestId("facet-tabs")).toBeVisible();
  await expect(page.getByTestId("intro-cta-packs")).toBeVisible();
  await expect(page.getByTestId("facet-footer")).toBeVisible();

  // packs: the borrowed 壹座 view must mount cleanly with no Router
  // ancestor — cards render, search is interactive.
  await page.goto(`${base}/#/packs`);
  // Two seeds: the smoke pack (no v2 display — the degradation chain stays
  // pinned on it) and the v2 passthrough pack (older publishedAt → sorts last,
  // .first() stays the smoke pack).
  await expect(page.locator('[data-testid^="pack-card-"]')).toHaveCount(2);
  await expect(page.getByTestId("pack-search-input")).toBeVisible();

  // Version history on the borrowed detail (add-facet-version-history): the
  // anonymous face reaches the seeded pack's version list — the route serves
  // public packs without a credential, and the shared disclosure lazy-loads.
  await page.locator('[data-testid^="pack-card-"]').first().click();
  const detail = page.getByTestId("pack-detail");
  await expect(detail.getByTestId("pack-version-list")).toBeVisible();
  await detail.getByTestId("pack-version-list-toggle").click();
  await expect(detail.getByTestId("pack-version-list-row-1")).toBeVisible();

  // mcp: the catalog must mount with its narrative and both tabs
  // (add-facet-infra-pages). The shell server now wires the e2e registry stub,
  // so the servers tab carries real stub entries.
  await page.goto(`${base}/#/mcp`);
  await expect(page.getByTestId("infra-narrative")).toBeVisible();
  await expect(page.getByTestId("mcp-tab-servers")).toBeVisible();
  await expect(page.getByTestId("mcp-tab-skills")).toBeVisible();

  // Depth view: open the stub server's card — tool surface (names with
  // descriptions) and provenance render; the card list itself stays without
  // tool surfaces (lazy depth payload).
  const card = page.getByTestId("mcp-card-e2e-registry-mcp");
  await expect(card).toBeVisible();
  await card.click();
  const depth = page.getByTestId("mcp-depth-e2e-registry-mcp");
  await expect(depth).toBeVisible();
  await expect(page.getByTestId("mcp-tool-read")).toContainText("Read an entry.");
  await expect(page.getByTestId("mcp-depth-license")).toContainText("MIT");
  await expect(page.getByTestId("mcp-depth-provider")).toContainText("e2e-org");
  await page.getByTestId("mcp-depth-back").click();
  await expect(card).toBeVisible();

  // Skills catalog: provenance renders for the declared entry and the
  // honest not-declared mark for the bare one.
  await page.getByTestId("mcp-tab-skills").click();
  await expect(page.getByTestId("skills-catalog")).toBeVisible();
  await expect(page.getByTestId("skill-provenance-e2e-provenance-skill")).toContainText("https://github.com/example/e2e-skills");
  await expect(page.getByTestId("skill-provenance-e2e-bare-skill")).toContainText("未标注");

  // docs (add-facet-docs-view): the three sections render statically, 壹座
  // leads the install tabs, a target page carries the single-sourced facts,
  // and the deep-guide links point into the public repository.
  await page.goto(`${base}/#/docs`);
  await expect(page.getByTestId("facet-docs-view")).toBeVisible();
  await expect(page.getByTestId("docs-install")).toBeVisible();
  await expect(page.getByTestId("docs-mcp")).toBeVisible();
  await expect(page.getByTestId("docs-create")).toBeVisible();
  await expect(page.getByTestId("docs-install-yizuo")).toBeVisible(); // default-selected
  await page.getByTestId("docs-install-tab-cursor").click();
  const cursorPane = page.getByTestId("docs-install-client-cursor");
  await expect(cursorPane).toContainText("--target cursor");
  await expect(cursorPane).toContainText("~/.cursor/skills");
  await expect(cursorPane).toContainText("~/.cursor/mcp.json");
  // The honest OAuth statement must render (no universal zero-paste promise).
  await expect(page.getByTestId("docs-mcp-oauth-honest")).toBeVisible();
  const guide = page.getByTestId("docs-create-deep-guide");
  await expect(guide).toHaveAttribute("href", /github\.com\/FindDataTechnology\/platform\/blob\/main\/docs\/creating-packs\.md$/);

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});

// Agent-count bucket filter (optimize-paas-module-audit N-10): the borrowed
// market view keeps this state in the `agents` URL param because the shell
// mounts it with NO Router ancestor — the write goes through
// window.history, so it must land in the real query string (#/packs is the
// hash route) and a reload must re-read it. Pins the exact regression class
// behind the 2026-10-11 blank #/packs.
test("pack agent-count filter rides the URL and survives a reload", async ({ page }) => {
  await page.goto(`${base}/#/packs`);
  await expect(page.getByTestId("pack-search-input")).toBeVisible({ timeout: 15000 });
  const filter = page.getByTestId("pack-agent-size-filter");
  await expect(filter).toBeVisible();

  await filter.selectOption("2-3");
  await expect.poll(() => new URL(page.url()).search).toContain("agents=2-3");

  await page.reload();
  await expect(page.getByTestId("pack-search-input")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("pack-agent-size-filter")).toHaveValue("2-3");
});

// ── Conditional views + data plane (add-facet-content-management) ────────────
// The shell layer is exercised with a whoami route-injection (the browser
// cannot present the proxy identity — that channel is server-to-server by
// design); the data plane below drives the REAL facet service with real
// forwarded identities over the internal token.

const INTERNAL_TOKEN = process.env.E2E_FACET_TOKEN || "e2e-facet-token";
const forwarded = (email, groups) => ({
  "x-facet-token": INTERNAL_TOKEN,
  "x-facet-user": Buffer.from(JSON.stringify({ email, groups })).toString("base64url"),
});

test("conditional tabs and views follow identity", async ({ page }) => {
  await page.route("**/api/whoami", (route) =>
    route.fulfill({
      json: { email: "ops@e2e.local", groups: ["creators", "admin"], creator: true, admin: true },
    }),
  );
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${base}/#/`);
  // anonymous regression already covered above; here the creator+admin sees
  // all five tabs.
  await expect(page.getByRole("button", { name: "My agents" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Curation" })).toBeVisible();

  // #/mine renders the creator console.
  await page.goto(`${base}/#/mine`);
  await expect(page.getByTestId("facet-mine-view")).toBeVisible();
  await expect(page.getByTestId("facet-mine-publish")).toBeVisible();

  // …and its version history renders through the SHARED presentation
  // (add-facet-version-history): the mine route-injection stands in for the
  // identity-gated list; expanding the shared disclosure shows the row with
  // its note — the same component the public detail mounts.
  await page.route(/\/api\/packs\?author=me/, (route) =>
    route.fulfill({
      json: {
        total: 1,
        page: 1,
        pageSize: 100,
        packs: [
          {
            id: "mine-shared-ver",
            authorEmail: "ops@e2e.local",
            createdAt: Date.now(),
            version: 2,
            name: "作者面共享版本组件",
            description: "d",
            tags: [],
            publishedAt: Date.now(),
            visibility: "public",
            unlisted: false,
          },
        ],
      },
    }),
  );
  await page.route("**/api/packs/mine-shared-ver/versions", (route) =>
    route.fulfill({
      json: {
        versions: [
          { version: 2, publishedAt: Date.now(), authorEmail: "ops@e2e.local", notes: "v2 说明。" },
          { version: 1, publishedAt: Date.now() - 1000, authorEmail: "ops@e2e.local" },
        ],
      },
    }),
  );
  await page.reload();
  const shared = page.getByTestId("facet-mine-versions-mine-shared-ver");
  await expect(shared).toBeVisible();
  await shared.getByTestId("facet-mine-versions-mine-shared-ver-toggle").click();
  await expect(page.getByTestId("facet-mine-versions-mine-shared-ver-row-2")).toContainText("v2 说明。");

  // #/curate renders the board with the honest usage degradation (no
  // usage-source env on the shell server).
  await page.goto(`${base}/#/curate`);
  await expect(page.getByTestId("facet-curate-view")).toBeVisible();
  await expect(page.getByTestId("facet-curate-usage-degraded")).toBeVisible();

  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

test("unauthorized deep links fall back to the intro landing", async ({ page }) => {
  await page.route("**/api/whoami", (route) => route.fulfill({ json: { email: null, groups: [] } }));
  await page.goto(`${base}/#/curate`);
  await expect(page.getByTestId("intro-cta-packs")).toBeVisible();
  await expect(page.getByRole("button", { name: "My agents" })).toHaveCount(0);
});

// ── Sign-in honesty (polish-fusion-details follow-up) ────────────────────────
// A failed OIDC return lands on /?auth_error=…: the shell must SAY so instead
// of silently showing the anonymous face (the user reported "logged in but no
// signed-in indicator" — an invisible failure reads as a missing indicator).

test("a failed sign-in return surfaces a banner and scrubs the param", async ({ page }) => {
  await page.route("**/api/whoami", (route) => route.fulfill({ json: { email: null, groups: [] } }));
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));

  await page.goto(`${base}/?auth_error=state#/`);
  const banner = page.getByTestId("facet-auth-error");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("登录未完成：会话校验失败，请重试。");
  await expect(banner.getByRole("button", { name: "重试登录" })).toBeVisible();
  // The param is scrubbed so a refresh does not re-raise the failure.
  await expect(page).toHaveURL(/\/#\//);
  expect(page.url()).not.toContain("auth_error");

  // Dismiss drops the banner without touching the view.
  await banner.getByRole("button", { name: "关闭" }).click();
  await expect(page.getByTestId("facet-auth-error")).toHaveCount(0);

  // Unknown codes degrade to the generic line, not a raw key.
  await page.goto(`${base}/?auth_error=weird#/`);
  await expect(page.getByTestId("facet-auth-error")).toContainText("登录未完成，请重试。");

  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

test("a signed-in viewer gets an explicit logged-in chip", async ({ page }) => {
  await page.route("**/api/whoami", (route) =>
    route.fulfill({ json: { email: "ops@e2e.local", groups: ["creators"], creator: true } }),
  );
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
  await page.goto(`${base}/#/`);
  const chip = page.getByTestId("facet-user-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("ops@e2e.local");
  await expect(chip).toHaveAttribute("title", "已登录：ops@e2e.local");
});

test("data plane: publish, curate, versions, visibility, unpublish with real forwarded identity", async ({ request }) => {
  const creator = forwarded("creator@e2e.local", ["creators"]);
  const admin = forwarded("ops@e2e.local", ["admin"]);

  // Publish from manifest (creator identity).
  const manifest = {
    name: "策展数据面冒烟",
    description: "add-facet-content-management sentinel",
    notes: "初版：数据面冒烟版本说明。",
    tags: ["shell-smoke"],
    category: "legal",
    skills: [{ name: "curate-smoke", description: "d", content: "# x" }],
    mcpServers: [],
    agents: [],
  };
  const pub = await request.post(`${base}/api/packs`, { headers: creator, data: { manifest } });
  expect(pub.ok()).toBeTruthy();
  const { id } = await pub.json();

  // Author-declared category rides the publish; stranger cannot feature.
  const listed = await request.get(`${base}/api/packs?category=legal`, { headers: creator });
  const cat = await listed.json();
  expect(cat.packs.some((p) => p.id === id && p.category === "legal")).toBeTruthy();
  const denied = await request.put(`${base}/api/packs/${id}/curation`, {
    headers: creator,
    data: { featured: true },
  });
  expect(denied.status()).toBe(403);

  // Admin curates: category + featured; the market listing reflects both.
  const cur = await request.put(`${base}/api/packs/${id}/curation`, {
    headers: admin,
    data: { category: "daas", featured: true },
  });
  expect(cur.ok()).toBeTruthy();
  const after = await request.get(`${base}/api/packs`, { headers: admin });
  const row = (await after.json()).packs.find((p) => p.id === id);
  expect(row.category).toBe("daas");
  expect(row.featured).toBe(true);

  // Author-only surfaces: version history and visibility flip. The version
  // note rides the immutable manifest and surfaces inline in the list
  // (add-facet-version-history, task 1.3's data-plane leg).
  const versions = await request.get(`${base}/api/packs/${id}/versions`, { headers: creator });
  expect(versions.ok()).toBeTruthy();
  const vrows = (await versions.json()).versions;
  expect(vrows.length).toBe(1);
  expect(vrows[0].notes).toBe("初版：数据面冒烟版本说明。");
  const vdoc = await request.get(`${base}/api/packs/${id}/versions/1`, { headers: creator });
  expect((await vdoc.json()).manifest.notes).toBe("初版：数据面冒烟版本说明。");
  const vis = await request.put(`${base}/api/packs/${id}/visibility`, {
    headers: creator,
    data: { visibility: "private" },
  });
  expect(vis.ok()).toBeTruthy();

  // Private: gone for a stranger, present for the author (author=me filter).
  const stranger = await request.get(`${base}/api/packs?author=me`, { headers: forwarded("x@e2e.local", []) });
  expect((await stranger.json()).packs.some((p) => p.id === id)).toBeFalsy();
  const mine = await request.get(`${base}/api/packs?author=me`, { headers: creator });
  expect((await mine.json()).packs.some((p) => p.id === id)).toBeTruthy();

  // Usage proxy: admin session required; anonymous gets 401.
  const usage = await request.get(`${base}/api/ops/pack-usage`);
  expect(usage.status()).toBe(401);

  // Unpublish (author) hides it from the anonymous market.
  const un = await request.post(`${base}/api/packs/${id}/unpublish`, { headers: creator });
  expect(un.ok()).toBeTruthy();
  const anonList = await request.get(`${base}/api/packs`);
  expect((await anonList.json()).packs.some((p) => p.id === id)).toBeFalsy();
});

// ── Footer shapes + dialog action bar (polish-facet-interactions) ────────────

test("the intro landing carries the full footer; tool views carry the filing-only footer", async ({ page }) => {
  await page.goto(`${base}/#/`);
  await expect(page.getByTestId("facet-footer")).toBeVisible();
  await expect(page.getByTestId("facet-filing-footer")).toHaveCount(0);

  for (const hash of ["#/packs", "#/mcp", "#/docs"]) {
    await page.goto(`${base}/${hash}`);
    await expect(page.getByTestId("facet-filing-footer")).toBeVisible();
    await expect(page.getByTestId("facet-footer")).toHaveCount(0);
  }
});

test("the pack dialog carries an always-visible action bar with close, and anonymous subscribe gets the login guidance", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${base}/#/packs`);
  await page.locator('[data-testid^="pack-card-"]').first().click();
  await expect(page.getByTestId("pack-detail")).toBeVisible();

  // The bar is visible without scrolling, with subscribe + close.
  await expect(page.getByTestId("pack-action-bar")).toBeVisible();
  await expect(page.getByTestId("pack-subscribe")).toBeVisible();
  await expect(page.getByTestId("pack-detail-close")).toBeVisible();

  // No gap: the bar's bottom edge sits flush with the dialog's bottom edge
  // (the earlier sticky + negative-margin approach left a see-through slit).
  const dialogBox = await page.getByTestId("pack-detail").boundingBox();
  const barBox = await page.getByTestId("pack-action-bar").boundingBox();
  expect(Math.abs(dialogBox.y + dialogBox.height - (barBox.y + barBox.height))).toBeLessThanOrEqual(1);
  // The facet shell omits the goto-mine affordance (no installed-packs surface).
  await expect(page.getByRole("button", { name: /我的智能体|My agents/ })).toHaveCount(0);

  // Anonymous subscribe: no raw error — the guidance row appears.
  await page.getByTestId("pack-subscribe").click();
  await expect(page.getByTestId("pack-login-guidance")).toBeVisible();
  // The sign-in action inside the row carries the host navigation (asserted
  // by presence — activating it would navigate away from this spec's scope).
  await expect(page.getByTestId("pack-login-go")).toBeVisible();

  // Close control (top-right) dismisses the dialog in one step.
  await page.getByTestId("pack-detail-close").click();
  await expect(page.getByTestId("pack-detail")).toHaveCount(0);

  // Scrim click closes in one step (the two-step confirm was tried and
  // reverted by the user's call — keep the plain dismissal).
  await page.locator('[data-testid^="pack-card-"]').first().click();
  await expect(page.getByTestId("pack-detail")).toBeVisible();
  await page.locator(".bg-scrim").click({ position: { x: 5, y: 5 }, force: true });
  await expect(page.getByTestId("pack-detail")).toHaveCount(0);

  // The goto-mine affordance for a signed-out viewer flips the guidance row
  // (no silent no-op, no navigation).
  await page.locator('[data-testid^="pack-card-"]').first().click();
  await expect(page.getByTestId("pack-action-bar")).toBeVisible();
  await page.getByRole("button", { name: /查看我的智能体|View my agents|Ver mis agentes|Voir mes agents|マイエージェントを見る/ }).click();
  await expect(page.getByTestId("pack-login-guidance")).toBeVisible();

  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

// Locale-switch refetch (overhaul-market-catalog-presentation P0): switching
// the shell's locale re-fetches the market in the new language — cards, chip
// labels, cross-track search, and the open detail dialog — with no manual
// reload. This is the browser half of the contract; the server halves
// (lineLabel projection, cross-track search) are pinned by
// scripts/test-market-locale-refetch.mjs.
test("market refetches when the locale switches, list and open dialog alike", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));

  await page.goto(`${base}/#/packs`);
  const card = page.locator('[data-testid^="pack-card-"]').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("谦面壳冒烟包");

  // 五槽位卡片 (overhaul-market-catalog-presentation P2): identity seal, name,
  // badges, version, then the PROMISE — the first sentence only, never the
  // second sentence the seed carries to pin the extraction.
  await expect(card.getByRole("img")).toHaveCount(1); // the line seal
  await expect(card).toContainText("壳冒烟哨兵包。");
  await expect(card).not.toContainText("这是第二句");
  // explicit zero words (the pack declares no skills/roles/tools)
  await expect(card).toContainText("无技能");
  // The canonical zh line word is the chip label under zh (label == word).
  await expect(page.getByTestId("pack-category-chips")).toContainText("柏讯 · 数据与情报");

  // Switch via the shell's header switcher: the list silently refetches —
  // the overlay-projected card text and the localized chip label arrive
  // without any manual reload, and the canonical filter keeps working.
  await page.getByTestId("facet-locale-switcher").selectOption("en");
  await expect(card).toContainText("Facet Shell Smoke Pack");
  await expect(page.getByTestId("pack-category-chips")).toContainText("Wire · Data & Intelligence");

  // Cross-track search: a keyword that exists ONLY in the en overlay block.
  await page.getByTestId("pack-search-input").fill("English sentinel");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator('[data-testid^="pack-card-"]')).toHaveCount(1);
  await expect(card).toContainText("Facet Shell Smoke Pack");

  // Clearing the search restores the full list (same locale, zh-track hit).
  await page.getByTestId("pack-search-input").fill("");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator('[data-testid^="pack-card-"]')).toHaveCount(1);

  // The open detail dialog refetches on locale change without closing: back
  // to zh-CN while the dialog is open, the title returns to the zh name.
  await card.click();
  const detail = page.getByTestId("pack-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Facet Shell Smoke Pack");
  // ⑥ 边界与诚实声明 sits at its fixed position (the version's note)
  // The seed's en overlay now covers notes too (P3 4.11 full-coverage seed):
  // the boundary statement must localize like every other org-surface field.
  await expect(detail.getByTestId("pack-detail-boundary-notes")).toContainText("English version note of the shell smoke pack.");
  // ⑦ version history stays at the content tail
  await expect(detail.getByTestId("pack-version-list")).toBeVisible();
  await page.getByTestId("facet-locale-switcher").selectOption("zh-CN");
  await expect(detail).toContainText("谦面壳冒烟包");
  await page.getByTestId("pack-detail-close").click();

  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

// Declared facets (overhaul-market-catalog-presentation P1): the chip strip is
// the server's DECLARED taxonomy with counts — five line chips always, zero
// counts included, and a second row for the non-zero domain values. The strip
// never reshapes as content moves; a zero-count line stays and says so.
test("facet strip is the declared taxonomy: five lines with counts plus a domain row", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));

  await page.goto(`${base}/#/packs`);
  const strip = page.getByTestId("pack-facets");
  await expect(strip).toBeVisible();

  // Axis 1: exactly the five declared lines, each carrying its count.
  const lineChips = strip.locator("[data-line-count]");
  await expect(lineChips).toHaveCount(5);
  await expect(strip).toContainText("柏讯 · 数据与情报");
  // The seeded pack sits on the wire line; every other line is zero-count but
  // still rendered (spatial memory, not a live projection of the rows).
  const zeroChips = strip.locator('[data-line-count="0"]');
  await expect(zeroChips).toHaveCount(4);

  // Clicking an empty line says so in its own words.
  await zeroChips.first().click();
  await expect(page.getByTestId("pack-market-empty")).toContainText("该线暂无上架内容");

  // Back to all; axis 2 shows the declared domain with its count.
  await page.getByRole("button", { name: "全部垂类" }).click();
  const domains = page.getByTestId("pack-domain-chips");
  await expect(domains).toBeVisible();
  await expect(domains).toContainText("投研");

  // Filtering by domain keeps the pack (it declares investing).
  await domains.getByRole("button", { name: /投研/ }).click();
  await expect(page.locator('[data-testid^="pack-card-"]')).toHaveCount(1);

  // Labels follow the request locale; the strip's SHAPE does not move.
  await page.getByTestId("facet-locale-switcher").selectOption("en");
  await expect(page.getByTestId("pack-facets").locator("[data-line-count]")).toHaveCount(5);
  await expect(page.getByTestId("pack-domain-chips")).toContainText("Investing");

  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

// Curation board's domain picker (P1 2.7): vocabulary chips only, and an
// unclassified pack is the visible backlog until a domain is picked.
test("curation board picks domains from the vocabulary and clears the unclassified flag", async ({ page, request }) => {
  const creator = forwarded("creator-domains@e2e.local", ["creators"]);
  const manifest = {
    name: "领域策展冒烟",
    description: "domain picker sentinel",
    tags: ["shell-smoke"],
    category: "legal",
    // A pack must carry at least one capability to be publishable.
    skills: [{ name: "domain-smoke", description: "d", content: "# x" }],
    mcpServers: [],
    agents: [],
  };
  const pub = await request.post(`${base}/api/packs`, { headers: creator, data: { manifest } });
  expect(pub.ok()).toBeTruthy();
  const { id } = await pub.json();

  await page.route("**/api/whoami", (route) =>
    route.fulfill({ json: { email: "creator-domains@e2e.local", groups: ["creators", "admin"], creator: true, admin: true } }),
  );
  // The board's list is admin-scoped; publish was forwarded identity, so the
  // admin view reaches it through the same internal token.
  await page.route(/\/api\/packs\?/, (route) =>
    route.continue({ headers: { ...route.request().headers(), ...creator } }),
  );
  // The board's WRITE goes to the same identity-gated route: without the
  // forwarded creator headers the browser (anonymous) would 403 and the badge
  // would stay — the harness must carry the identity on the PUT too.
  await page.route(/\/api\/packs\/[^/]+\/curation$/, (route) =>
    route.continue({ headers: { ...route.request().headers(), ...creator } }),
  );
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));

  await page.goto(`${base}/#/curate`);
  const row = page.getByTestId(`facet-curate-row-${id}`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId(`facet-curate-unclassified-${id}`)).toBeVisible();

  // No free-text domain input exists: the picker renders vocabulary chips.
  await expect(row.locator("input")).toHaveCount(1); // only the legacy category input
  await row.getByTestId(`facet-curate-domain-${id}-legal`).click();
  await page.getByTestId(`facet-curate-save-domains-${id}`).click();
  await expect(page.getByTestId(`facet-curate-unclassified-${id}`)).toHaveCount(0);
  // The write is visible on the read face's facet counts.
  const facets = await request.get(`${base}/api/packs/facets?locale=zh`, { headers: creator });
  const body = await facets.json();
  expect(body.domains.some((d) => d.slug === "legal" && d.count >= 1)).toBeTruthy();
});

test("example prompts copy to the clipboard on the router-less shell (P2 3.5)", async ({ page, context }) => {
  // The facet shell wires NO chat session, so an example click falls back to
  // copy-to-clipboard — the confirmation appears only on a real write.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
  await page.goto(`${base}/#/packs`);
  // Explicit id, not .first(): by this point in the file the curation test has
  // published a second, guide-less pack into the shared registry.
  await page.locator('[data-testid="pack-card-facet-shell-smoke"]').click();
  const detail = page.getByTestId("pack-detail");
  await expect(detail.getByTestId("pack-guide-card")).toBeVisible();
  await expect(detail.getByTestId("pack-guide-example-0")).toBeVisible();

  await detail.getByTestId("pack-guide-example-0").click();
  await expect(detail.getByTestId("pack-guide-example-copied")).toBeVisible();
  await expect(detail.getByTestId("pack-guide-example-copied")).toContainText("已复制");
  // The copied text is the prompt BODY, not the card title.
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("示例指令哨兵全文");
  // No navigation happened — the shell has no /chat to land on.
  expect(page.url()).toContain("#/packs");
});

test("v2 display block rides the card and the detail (P3 4.5)", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
  await page.goto(`${base}/#/packs`);
  const card = page.getByTestId("pack-card-facet-shell-v2");
  await expect(card).toBeVisible();

  // Slot 2: the DECLARED promise wins — the description (and its first
  // sentence) never competes for the slot when display.promise exists.
  await expect(card).toContainText("声明承诺：一屏可见的风险清单。");
  await expect(card).not.toContainText("普通描述");
  // Slot 4: declared audience renders through the facets vocabulary label.
  await expect(card.getByTestId("pack-audience-facet-shell-v2")).toContainText("法务");

  await card.click();
  const detail = page.getByTestId("pack-detail");
  await expect(detail.getByTestId("pack-detail-outcomes")).toContainText("风险清单");
  await expect(detail.getByTestId("pack-detail-outcomes")).toContainText("逐条定位到条款");
  // ④ examples ride the v2 channel even WITHOUT a guide — and stay actionable
  // (facet host: clipboard fallback, the prompt BODY not the title).
  await detail.getByTestId("pack-guide-example-0").click();
  await expect(detail.getByTestId("pack-guide-example-copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("声明示例提示词全文");
});

test("coverage meter on the boundary face: 0/m declared gaps and full cover (P3 4.11)", async ({ page }) => {
  // Coverage is a secondary-track read (the zh main track needs none): switch
  // to en FIRST, then read both states off the SAME section.
  await page.goto(`${base}/#/packs`);
  await page.getByTestId("facet-locale-switcher").selectOption("en");

  // v2 pack: declared org surface, NO en overlay → 0 covered + field paths.
  await page.getByTestId("pack-card-facet-shell-v2").click();
  const detail = page.getByTestId("pack-detail");
  await expect(detail.getByTestId("pack-detail-coverage")).toContainText("0/");
  await expect(detail.getByTestId("pack-detail-coverage-missing")).toContainText("promise");
  await expect(detail.getByTestId("pack-detail-coverage-missing")).toContainText("outcomes[0].title");
  // The marker informs and NEVER gates: subscribe/install stay enabled.
  await expect(detail.getByTestId("pack-subscribe")).toBeEnabled();
  await page.keyboard.press("Escape");

  // smoke pack: full en overlay → the honest all-covered line. Explicit id —
  // in batch the curation test has by now PUBLISHED a newer pack into the
  // shared registry, and .first() would land on that one instead.
  await page.getByTestId("pack-card-facet-shell-smoke").click();
  await expect(detail.getByTestId("pack-detail-coverage")).toContainText("covered in en");
  await expect(detail.getByTestId("pack-detail-coverage-missing")).toHaveCount(0);
});

test("coverage board on the curation face: per-pack n/m badges, gap paths, gap-only filter (P4 5.4)", async ({ page }) => {
  const creator = forwarded("board@e2e.local", ["creators", "admin"]);
  await page.route("**/api/whoami", (route) =>
    route.fulfill({ json: { email: "board@e2e.local", groups: ["creators", "admin"], creator: true, admin: true } }),
  );
  await page.route(/\/api\/packs\?/, (route) => route.continue({ headers: { ...route.request().headers(), ...creator } }));
  // The coverage board read is auth-gated (it lists private/unlisted names too).
  await page.route("**/api/packs/curation/coverage**", (route) =>
    route.continue({ headers: { ...route.request().headers(), ...creator } }),
  );
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));

  await page.goto(`${base}/#/curate`);

  // v2 pack: declared org surface, no en overlay → 0-covered badge + gap paths.
  const v2Row = page.getByTestId("facet-curate-row-facet-shell-v2");
  await expect(v2Row).toBeVisible();
  await expect(page.getByTestId("facet-curate-coverage-facet-shell-v2")).toContainText("en 0/");
  await expect(page.getByTestId("facet-curate-gaps-facet-shell-v2")).toContainText("promise");

  // smoke pack: full en overlay → all-covered badge, NO gap list rendered.
  // 9 = name+description+notes+guide 3×2 (the base manifest declares no
  // top-level tags — the seed's tags live only in the en overlay).
  await expect(page.getByTestId("facet-curate-coverage-facet-shell-smoke")).toContainText("en 9/9");
  await expect(page.getByTestId("facet-curate-gaps-facet-shell-smoke")).toHaveCount(0);

  // Patrol filter: gaps only hides the covered row, keeps the gapped one.
  await page.getByTestId("facet-curate-only-gaps").click();
  await expect(page.getByTestId("facet-curate-row-facet-shell-v2")).toBeVisible();
  await expect(page.getByTestId("facet-curate-row-facet-shell-smoke")).toHaveCount(0);
});

// MCP catalog locale refetch (polish-facet-catalog-depth 1.1/3.1): the
// catalog's data face follows the shell's locale selection — switching the
// header switcher refetches /api/mcp-catalog (and the open depth view) with
// ?locale=, so annotated cards and annotated tools flip their DATA language
// together with chrome. This is the browser half; the wiring (fetch params +
// deps) is pinned on source by scripts/test-mcp-depth-tools.mjs.
test("mcp catalog refetches data when the locale switches, cards and depth tools alike", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));

  await page.goto(`${base}/#/mcp`);
  const card = page.getByTestId("mcp-card-e2e-catalog-depth-mcp");
  await expect(card).toBeVisible();
  // zh: the annotation's human track leads (not the raw display_name).
  await expect(card).toContainText("目录深度注释服务器");

  // Switch zh→en: the list silently refetches WITH ?locale=en — pin the
  // request itself, then the card's flipped data language.
  const refetch = page.waitForRequest((r) => r.url().includes("/api/mcp-catalog?locale=en"));
  await page.getByTestId("facet-locale-switcher").selectOption("en");
  await refetch;
  await expect(card).toContainText("Annotated Depth Server");

  // The open depth view refetches in the new locale too — the annotated
  // tool's human label flips, while the raw callable name never goes away.
  await card.click();
  const depth = page.getByTestId("mcp-depth-e2e-catalog-depth-mcp");
  await expect(depth).toBeVisible();
  await expect(page.getByTestId("mcp-tool-annotated_tool")).toContainText("Annotated Tool");
  await expect(page.getByTestId("mcp-tool-annotated_tool")).toContainText("annotated_tool"); // raw name stays
  // Back to zh: the depth view refetches again and the tool label flips back.
  const depthRefetch = page.waitForRequest((r) => r.url().includes("/api/mcp-catalog/e2e-catalog-depth-mcp?locale=zh"));
  await page.getByTestId("facet-locale-switcher").selectOption("zh-CN");
  await depthRefetch;
  await expect(page.getByTestId("mcp-tool-annotated_tool")).toContainText("注解工具");

  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

// Depth tool surface (polish-facet-catalog-depth 2.1-2.3): grouping by tool
// name prefix with the 其他 tail bucket, a client-side filter that narrows
// across groups, clamp-to-preview descriptions with a per-tool expand
// affordance, and the raw mono name always present. Pure-function halves
// (grouping/filter/preview heuristic) pinned by
// scripts/test-mcp-depth-tools.mjs; this leg pins the rendered surface.
test("depth tools group by prefix, filter across groups, and fold long descriptions", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));

  await page.goto(`${base}/#/mcp`);
  await page.getByTestId("mcp-card-e2e-catalog-depth-mcp").click();
  const tools = page.getByTestId("mcp-depth-tools-list");
  await expect(tools).toBeVisible();

  // Grouping: alpha/beta carry siblings (groups with counts); loner_tool and
  // bare names fold into the 其他 tail bucket together with annotated_tool
  // and long_tool (no underscore prefix).
  await expect(page.getByTestId("mcp-tool-group-alpha")).toContainText("2");
  await expect(page.getByTestId("mcp-tool-group-beta")).toContainText("2");
  const other = page.getByTestId("mcp-tool-group-other");
  await expect(other).toContainText("其他");
  await expect(other).toContainText("3");

  // Clamp: line-clamp is CSS truncation — the full text always sits in the
  // DOM, so the fold state is pinned on the clamp class (and the raw name
  // rides the card throughout).
  const longSummary = page.getByTestId("mcp-tool-summary-long_tool");
  await expect(page.getByTestId("mcp-tool-long_tool")).toContainText("long_tool"); // raw name visible while folded
  await expect(longSummary).toHaveClass(/line-clamp-4/);
  await page.getByTestId("mcp-tool-toggle-long_tool").click();
  await expect(longSummary).not.toHaveClass(/line-clamp-4/);
  await expect(page.getByTestId("mcp-tool-long_tool")).toContainText("Fifth line only visible after expand.");
  await page.getByTestId("mcp-tool-toggle-long_tool").click();
  await expect(longSummary).toHaveClass(/line-clamp-4/);

  // Filter: narrows across groups (raw name hit in alpha); annotation label
  // hit; miss shows the empty state; clearing restores every group.
  await page.getByTestId("mcp-depth-tools-filter").fill("alpha_two");
  await expect(page.getByTestId("mcp-tool-alpha_one")).toHaveCount(0);
  await expect(page.getByTestId("mcp-tool-alpha_two")).toBeVisible();
  await expect(page.getByTestId("mcp-tool-group-beta")).toHaveCount(0);

  await page.getByTestId("mcp-depth-tools-filter").fill("注解工具"); // annotation label matches
  await expect(page.getByTestId("mcp-tool-annotated_tool")).toBeVisible();

  await page.getByTestId("mcp-depth-tools-filter").fill("zzz-no-match");
  await expect(page.getByTestId("mcp-depth-tools-empty")).toBeVisible();

  await page.getByTestId("mcp-depth-tools-filter").fill("");
  await expect(page.getByTestId("mcp-tool-group-alpha")).toBeVisible();
  await expect(page.getByTestId("mcp-tool-group-beta")).toBeVisible();
  await expect(page.getByTestId("mcp-tool-group-other")).toBeVisible();

  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});
