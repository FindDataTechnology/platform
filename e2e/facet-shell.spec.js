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

  // ── In-site depth (overhaul-facet-shell-ia-and-space D7) ──────────────────
  // The reader no longer has to leave the host for the two things this page
  // was worst at: the native configuration shape, and the site's own map.
  await expect(page.getByTestId("docs-mcp-sample-cursor")).toContainText("mcpServers");
  await expect(page.getByTestId("docs-pitfalls-cursor")).toBeVisible();
  await expect(page.getByTestId("docs-site-entries")).toBeVisible();
  // One concept, one name: the site map reuses the shell's own labels.
  await expect(page.getByTestId("docs-site-entry-studio")).toContainText("创作台");
  // The rail marks the section the reader is actually in.
  await page.getByTestId("docs-nav-docs-site").click();
  await expect(page.getByTestId("docs-site")).toBeInViewport();
  await expect(page.getByTestId("docs-nav-docs-site")).toHaveAttribute("aria-current", "true");
  // Client-side search answers without a request.
  await page.getByTestId("docs-search").fill("mcpServers");
  await expect(page.getByTestId("docs-search-results")).toBeVisible();
  await page.getByTestId("docs-search").fill("zzzz-no-such-copy");
  await expect(page.getByTestId("docs-search-empty")).toBeVisible();
  await page.getByTestId("docs-search").fill("");

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
  // Author/admin surfaces sit behind the account control
  // (overhaul-facet-shell-ia-and-space): the creator opens it to reach their
  // publishes, the admin additionally reaches content ops. Neither takes
  // primary-row width any more.
  await page.getByTestId("facet-user-chip").click();
  await expect(page.getByTestId("facet-account-mine")).toBeVisible();
  await expect(page.getByTestId("facet-account-curate")).toBeVisible();

  // #/mine renders the creator console — the hash keeps resolving for a
  // viewer whose identity grants it, menu entry or not.
  await page.goto(`${base}/#/mine`);
  await expect(page.getByTestId("facet-mine-view")).toBeVisible();
  // Shared container, same as the board below: this face is behind sign-in,
  // so the anonymous width sentinel cannot see it. Scoped as a descendant —
  // the filing footer carries its own container too.
  await expect(page.locator('[data-testid="facet-container"] [data-testid="facet-mine-view"]')).toBeVisible();
  // Its title is the page's h1, not an h2 (a11y outline).
  await expect(page.locator('[data-testid="facet-mine-view"] h1')).toHaveCount(1);
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
  await expect(page.locator('[data-testid="facet-curate-view"] h1')).toHaveCount(1);
  await expect(page.getByTestId("facet-curate-usage-degraded")).toBeVisible();

  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

test("the author console tiles its list instead of one full-width column", async ({ page }) => {
  // No locale pin: the geometry below is locale-independent, and the per-locale
  // loop at the end drives the locale from the page. An `addInitScript` pin
  // would re-run on every navigation and silently clobber those switches —
  // turning "no overflow in 5 locales" into five measurements of one locale.
  await page.route("**/api/whoami", (route) =>
    route.fulfill({ json: { email: "creator-tiles@e2e.local", groups: ["creators"], creator: true, admin: false } }),
  );
  // Three rows: enough that a one-column list and a two-column grid differ.
  await page.route(/\/api\/packs\?author=me/, (route) =>
    route.fulfill({
      json: {
        total: 3,
        page: 1,
        pageSize: 100,
        packs: ["tile-a", "tile-b", "tile-c"].map((id, i) => ({
          id,
          authorEmail: "creator-tiles@e2e.local",
          createdAt: Date.now() - i * 1000,
          version: 1,
          name: `作者列表铺开 ${id}`,
          description: "d",
          tags: [],
          publishedAt: Date.now() - i * 1000,
          visibility: "public",
          unlisted: false,
        })),
      },
    }),
  );
  // Each row lazy-loads its own version strip; answer it so no row renders an
  // error state (the assertions below are about geometry, not content).
  await page.route(/\/api\/packs\/[^/]+\/versions/, (route) =>
    route.fulfill({ json: { versions: [{ version: 1, publishedAt: Date.now(), authorEmail: "creator-tiles@e2e.local" }] } }),
  );

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${base}/#/mine`);
  const rows = page.locator('[data-testid^="facet-mine-row-"]');
  await expect(rows).toHaveCount(3);
  const xs = await rows.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      // Bucket x by 8px for the same reason the market sentinel does: entrance
      // animation shifts a card a few pixels, row membership is the property.
      return Math.round(r.x / 8) * 8;
    }),
  );
  expect(new Set(xs).size, `rows all started at x=${xs[0]}, so the list is one column`).toBeGreaterThan(1);

  // Narrow: back to a single stack, still on the container.
  await page.setViewportSize({ width: 390, height: 900 });
  const narrowXs = await rows.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().x / 8) * 8));
  expect(new Set(narrowXs).size).toBe(1);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);

  // …and in every locale. The width matrix only covers the anonymous views; a
  // signed-in header carries the account chip on top of the entry row, and the
  // translated labels are the longer ones (es "Estudio de creación", fr
  // "Atelier de création"). This is the only place those two meet at 390px.
  for (const locale of ["en", "zh-CN", "es", "fr", "ja"]) {
    await page.evaluate((l) => localStorage.setItem("platform.locale", l), locale);
    await page.reload();
    await expect(rows.first()).toBeVisible();
    // Prove the loop is real: the top-of-test addInitScript re-runs on every
    // navigation, so a locale set from the page can be clobbered on reload. If
    // that happened, measuring "no overflow in 5 locales" would really be five
    // measurements of one locale — a guard that cannot fail.
    await expect(page.getByTestId("facet-locale-switcher")).toHaveValue(locale);
    const report = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(
      { locale, ...report },
      `${locale}: the signed-in console scrolls horizontally at 390px (${report.scroll} > ${report.client})`,
    ).toEqual({ locale, scroll: report.client, client: report.client });
  }
});

test("unauthorized deep links fall back to the intro landing", async ({ page }) => {
  await page.route("**/api/whoami", (route) => route.fulfill({ json: { email: null, groups: [] } }));
  await page.goto(`${base}/#/curate`);
  await expect(page.getByTestId("intro-cta-packs")).toBeVisible();
  // No identity → no account control at all, so no author/admin door renders.
  await expect(page.getByTestId("facet-user-chip")).toHaveCount(0);
  await expect(page.getByTestId("facet-account-menu")).toHaveCount(0);
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
  // The control states who is signed in even while closed; the email itself
  // moved into the menu (overhaul-facet-shell-ia-and-space) so the header row
  // stops growing with a long address.
  const chip = page.getByTestId("facet-user-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("账号");
  await expect(chip).toHaveAttribute("title", "已登录：ops@e2e.local");
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("facet-account-menu")).toContainText("ops@e2e.local");
  // Escape closes it without leaving the view.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("facet-account-menu")).toHaveCount(0);
});

test("the account menu stays inside the viewport at every width", async ({ page }) => {
  // The panel is absolutely positioned and 224px wide. With a fixed `right-0`
  // anchor it clipped its OWN first characters off the left edge whenever the
  // header wrapped the chip toward the middle of a narrow screen — measured in
  // production at 390px: chip 124..207 ⇒ panel left = −17px, so 「已登录: …」、
  // 「我的发布」、「内容运营」、「退出登录」 each lost their first glyph. scrollWidth
  // stayed 0 the whole time, so a plain "no horizontal scroll" guard cannot see
  // it: the text was outside the screen without widening the document. Assert
  // the panel's own box instead, at every width a phone or a laptop uses.
  await page.route("**/api/whoami", (route) =>
    route.fulfill({ json: { email: "ops@e2e.local", groups: ["creators"], admin: true, creator: true } }),
  );
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
  const widths = [320, 360, 390, 414, 768, 1024, 1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${base}/#/`);
    await page.getByTestId("facet-user-chip").click();
    const menu = page.getByTestId("facet-account-menu");
    await expect(menu).toBeVisible();
    const box = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, vw: document.documentElement.clientWidth };
    });
    expect(box.left, `${width}px: panel left ${box.left} must be on screen`).toBeGreaterThanOrEqual(-1);
    expect(box.right, `${width}px: panel right ${box.right} must be on screen`).toBeLessThanOrEqual(box.vw + 1);
    // And it must not hide behind its own trigger: the label row is readable.
    await expect(menu).toContainText("ops@e2e.local");
    await page.keyboard.press("Escape");
  }
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

  // Clearing the search restores the full list. The refetch is async, so the
  // assertion has to wait for the settled state first: asserting a count right
  // after the click reads the PREVIOUS result set (the search's single card)
  // and passes on stale DOM — then goes red whenever the refetch happens to
  // land before the first poll (observed 2026-11-11). Both seeds are public and
  // carry a version, and the listing has no locale-based row filter, so the
  // full list is both of them.
  await page.getByTestId("pack-search-input").fill("");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByTestId("pack-market-skeleton")).toHaveCount(0);
  await expect(page.locator('[data-testid^="pack-card-"]')).toHaveCount(2);

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
  // The board sits on the shell's shared container (facet-platform: "one
  // shared container grid"). It shipped bare until the MCP view exposed the
  // same defect, so pin the wrapping here — this face is behind sign-in, which
  // is exactly why the anonymous width sentinel never saw it.
  await expect(page.locator('[data-testid="facet-container"] [data-testid="facet-curate-view"]')).toBeVisible();
  const row = page.getByTestId(`facet-curate-row-${id}`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId(`facet-curate-unclassified-${id}`)).toBeVisible();

  // Master–detail (overhaul-facet-shell-ia-and-space D6): the row is a list
  // entry, not an editor — selecting it opens the panel that carries the
  // vocabulary pickers and the single Save.
  await row.click();
  const detail = page.getByTestId("facet-curate-detail");
  await expect(detail).toBeVisible();
  // Neither axis accepts free text: category is a <select>, domains are chips.
  await expect(row.locator("input")).toHaveCount(0);
  const categoryPicker = page.getByTestId(`facet-curate-category-${id}`);
  expect(await categoryPicker.evaluate((el) => el.tagName)).toBe("SELECT");
  await page.getByTestId(`facet-curate-domain-${id}-legal`).click();
  await page.getByTestId(`facet-curate-save-${id}`).click();
  await expect(page.getByTestId(`facet-curate-unclassified-${id}`)).toHaveCount(0);
  // The write is visible on the read face's facet counts.
  const facets = await request.get(`${base}/api/packs/facets?locale=zh`, { headers: creator });
  const body = await facets.json();
  expect(body.domains.some((d) => d.slug === "legal" && d.count >= 1)).toBeTruthy();

  // Narrow viewport: this is the one face the anonymous width matrix cannot
  // reach (it needs admin), so its collapse is pinned here — master list and
  // detail pane stack into one column and the document still does not scroll
  // sideways (facet-platform: "narrow viewports stay usable").
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload();
  await expect(page.getByTestId("facet-curate-view")).toBeVisible();
  // Select a row so the detail pane actually exists — measuring only the
  // master column would make the stacking assertion below a no-op.
  await page.getByTestId(`facet-curate-row-${id}`).click();
  await expect(page.getByTestId("facet-curate-detail")).toBeVisible();
  const panes = await page.evaluate(() => {
    const at = (sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? Math.round(r.x / 8) * 8 : null;
    };
    return { list: at('[data-testid="facet-curate-list"]'), detail: at('[data-testid="facet-curate-detail"]') };
  });
  // Stacked: the detail pane starts where the master column starts.
  expect(panes.list).not.toBeNull();
  expect(panes.detail).toBe(panes.list);
  const narrow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(narrow.scroll).toBeLessThanOrEqual(narrow.client + 1);
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
  // Gap paths live in the detail panel (the list keeps the badge only).
  await v2Row.click();
  await expect(page.getByTestId("facet-curate-gaps-facet-shell-v2")).toContainText("promise");

  // smoke pack: full en overlay → all-covered badge, NO gap list rendered.
  // 9 = name+description+notes+guide 3×2 (the base manifest declares no
  // top-level tags — the seed's tags live only in the en overlay).
  await expect(page.getByTestId("facet-curate-coverage-facet-shell-smoke")).toContainText("en 9/9");
  // Selecting the covered pack replaces the gap list with the complete state.
  await page.getByTestId("facet-curate-row-facet-shell-smoke").click();
  await expect(page.getByTestId("facet-curate-coverage-full-facet-shell-smoke")).toBeVisible();
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

// ── Viewport usage (overhaul-facet-shell-ia-and-space D1/D2/D5) ──────────────
// The market used to be one full-width row per pack at every width: a 1600px
// line of text on a desktop and the same list on a phone. The shell now tiles
// the cards and moves the filters into a rail; this is the layout sentinel —
// it fails if either the tile grid or the rail disappears.
test("the market tiles on a wide viewport and collapses on a narrow one", async ({ page }) => {
  const cardsX = async () =>
    page.locator('[data-testid^="pack-card-"]').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        // Bucket y by 8px: the list rides the `rise-in` entrance (fade + 4px
        // translate, staggered up to 200ms), so a mid-animation sample reports
        // a few pixels of difference per card. Layout row/column is what this
        // sentinel judges, not animation phase.
        return { x: Math.round(r.x / 8) * 8, y: Math.round(r.y / 8) * 8, w: Math.round(r.width) };
      }),
    );

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${base}/#/packs`);
  await expect(page.locator('[data-testid^="pack-card-"]').first()).toBeVisible();

  // Tiled: the cards do not stack in one column — siblings share a row and
  // differ in x (the exact column count follows the seed size, so assert the
  // shape, not a magic number).
  const wide = await cardsX();
  expect(wide.length).toBeGreaterThan(1);
  expect(new Set(wide.map((c) => c.x)).size).toBeGreaterThan(1);
  expect(new Set(wide.map((c) => c.y)).size).toBeLessThan(wide.length);

  // Rail: the filter block sits beside the results, not above them.
  const filters = await page.getByTestId("pack-filters").boundingBox();
  const firstCard = await page.locator('[data-testid^="pack-card-"]').first().boundingBox();
  expect(filters.x + filters.width).toBeLessThanOrEqual(firstCard.x + 1);
  // The declared taxonomy strip is still the same anchor the domain suite reads.
  await expect(page.getByTestId("pack-facets")).toBeVisible();

  // Narrow: one column, no page-level horizontal scroll.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.locator('[data-testid^="pack-card-"]').first()).toBeVisible();
  const narrow = await cardsX();
  expect(new Set(narrow.map((c) => c.x)).size).toBe(1);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
});

// ── Embedded face navigation (overhaul-facet-shell-ia-and-space D4) ──────────
// The creation face embeds 壹座's studio page inside a scoped route table. Its
// back control used to link to /agents?tab=build, a route this host does not
// serve, so the button was a silent no-op (supply-studio: 不存在静默无操作).
test("the creation face's back control actually moves the host view", async ({ page }) => {
  await page.route("**/api/whoami", (route) =>
    route.fulfill({ json: { email: "ops@e2e.local", groups: ["creators"], creator: true } }),
  );
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${base}/#/studio`);
  await expect(page.getByTestId("facet-studio-face")).toBeVisible();
  const back = page.getByTestId("ws-back");
  await expect(back).toBeVisible();

  await back.click();
  // The host moved to the market — not a no-op, and not a blank route.
  await expect(page.getByTestId("pack-market-section")).toBeVisible();
  await expect(page).toHaveURL(/#\/packs$/);
  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

// ── View changes land at the top (overhaul-facet-shell-ia-and-space polish) ──
// `<main>` is the scroll container, and `key={view}` only remounts the error
// boundary INSIDE it — so the offset used to carry over. Reading to the bottom
// of the docs and then opening the market dropped the reader mid-page, which is
// the "the interactions feel off" half of the original report. No scroll reset
// existed anywhere in the shell.
test("switching views lands at the top of the new view", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}/#/docs`);
  await expect(page.getByTestId("docs-install")).toBeVisible();

  // Scroll the shell's own scroller (not the window) to the bottom.
  const scrolled = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return -1;
    main.scrollTop = main.scrollHeight;
    return main.scrollTop;
  });
  expect(scrolled, "the docs page must be tall enough to scroll at this viewport").toBeGreaterThan(200);

  await page.getByTestId("facet-tabs").getByText("智能体市场").click();
  await expect(page.getByTestId("pack-market-section")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.querySelector("main")?.scrollTop ?? -1))
    .toBeLessThanOrEqual(2);

  // And the docs deep-link still works after the reset (no hash side effects).
  await page.goto(`${base}/#/docs`);
  await expect(page.getByTestId("docs-install")).toBeVisible();
  expect(await page.evaluate(() => document.querySelector("main")?.scrollTop ?? -1)).toBeLessThanOrEqual(2);
});

// ── One page heading per view (a11y outline) ────────────────────────────────
// Measured before this: the market rendered NO heading at all and MCP started at
// h2, so the two busiest public surfaces had no document root; the author and
// admin faces titled themselves at h2. Every view now opens with exactly one h1
// carrying its task name, and the sections below nest under it.
test("every public view carries exactly one page heading", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
  const EXPECTED = [
    ["#/", "千人千面"],
    ["#/packs", "智能体市场"],
    ["#/mcp", "MCP 与技能"],
    ["#/docs", "使用指南"],
  ];
  for (const [hash, title] of EXPECTED) {
    await page.goto(`${base}/${hash}`);
    const h1 = page.locator("main h1");
    await expect(h1, `${hash} must carry exactly one h1`).toHaveCount(1);
    await expect(h1).toContainText(title);
  }
});

// ── The tab names the view you are on ───────────────────────────────────────
// Seven views share one document, so the static <title> said 「智能体市场」 on
// every page (and never followed the locale). Tabs, history entries and
// bookmarks are user-visible surfaces with no testid, which is why this drifted.
test("the document title names the current view in the current locale", async ({ browser }) => {
  const titleFor = (hash, label) => [`${base}/${hash}`, label];

  // One context per locale, not one addInitScript per iteration: init scripts
  // ACCUMULATE and all re-run on every navigation, so the loop's first locale
  // kept winning and the "en" assertions were really measuring zh-CN.
  for (const [locale, expected] of [
    [
      "zh-CN",
      [
        titleFor("#/packs", "智能体市场"),
        titleFor("#/mcp", "MCP 与技能"),
        titleFor("#/docs", "使用指南"),
        titleFor("#/", "介绍"),
      ],
    ],
    ["en", [titleFor("#/packs", "Agent market"), titleFor("#/docs", "Guide")]],
  ]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript((l) => localStorage.setItem("platform.locale", l), locale);
    try {
      for (const [url, label] of expected) {
        await page.goto(url);
        await expect(page.getByTestId("facet-tabs")).toBeVisible();
        await expect(page, `${url} in ${locale} should title itself ${label}`).toHaveTitle(
          new RegExp(`^${label} · 谦面 Facet$`),
        );
      }
    } finally {
      await context.close();
    }
  }
});
