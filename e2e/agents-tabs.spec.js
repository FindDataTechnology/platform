import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// /agents after the supply-domain migration.
//
// add-agent-builder-hub gave this route a four-area builder hub (Build /
// Supply / Creations / Tuning, ?tab=… deep links, SURFACE_SLUG_ALIASES for the
// legacy slugs). add-supply-studio-migration (archived 2026-11-08) dissolved
// it: creation and publishing moved to the supply domain, the route keeps its
// slug/route identity but serves AgentMarketPage — the market entry plus the
// local install panel, which is the runtime half that stays in 壹座 — and the
// Tuning area became its own /tuning route.
//
// The nine assertions that used to live here were all pinned to the retired
// hub's testids and had been dead since the teardown (test.skip marker). This
// block is the rewrite against the live faces: what the route must serve now,
// what must no longer exist, and that legacy ?tab= links degrade quietly
// instead of landing on an error face.
const STUDIO_ORIGIN = "https://facet.finddatatech.cloud";

// Retired hub surface — none of it may come back on this route.
const RETIRED_HUB_TESTIDS = [
  "agents-page",
  "agents-tab-build",
  "agents-tab-supply",
  "agents-tab-creations",
  "agents-tab-tuning",
  "agents-tab-apps",
  "build-section",
  "supply-section",
  "creations-section",
  "tuning-section",
];

test.describe("agent market facade (/agents after the supply migration)", () => {
  test("serves the market entry and none of the retired four-zone hub", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents");
    await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15000 });
    // unify-material-market: the surface now carries four capability species.
    await expect(page.getByTestId("agent-market-title")).toHaveText("Materials");
    for (const id of RETIRED_HUB_TESTIDS) {
      await expect(page.getByTestId(id), `retired hub testid ${id}`).toHaveCount(0);
    }
  });

  test("the only outbound door is authoring — the market itself is in-product", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents");
    // drop-external-market-door: the marketplace is this deployment's own market
    // plane, so no link leaves the product for "the market". The authoring entry
    // (supply-domain Studio) stays — different surface, same repository.
    await expect(page.getByTestId("agent-market-open")).toHaveCount(0);
    // Same origin definition as the studio redirect and the fleet 来源蓝图 chip
    // (web/src/lib/studio-origin.ts) — three copies of this literal drifted once
    // already and one landed on the platform domain's error face.
    const studio = page.getByTestId("agent-market-studio");
    await expect(studio).toHaveAttribute("href", `${STUDIO_ORIGIN}/#/studio`);
    await expect(studio).toHaveAttribute("target", "_blank");
    await expect(studio).toHaveAttribute("rel", /noopener/);
  });

  test("install panel is the runtime half that stays in 壹座", async ({ page }) => {
    await pinLocaleEn(page);
    // restructure-yizuo-ia: installed packs + drafts moved into the 我的 tab of
    // the merged market surface (they used to sit under the market façade).
    await page.goto("/agents?tab=mine");
    const installed = page.getByTestId("agent-market-mine-installed");
    await expect(installed).toBeVisible({ timeout: 15000 });
    // MyPacksView resolves to the list, the loading skeleton, or the honest
    // error card — all three mean the panel is mounted; an empty section would
    // mean it stopped mounting.
    await expect(
      installed
        .locator(
          '[data-testid="my-packs-section"], [data-testid="my-packs-skeleton"], [data-testid="my-packs-error"]',
        )
        .first(),
    ).toBeVisible({ timeout: 15000 });
  });

  test("legacy ?tab= links degrade to the facade, never to an error face", async ({ page }) => {
    await pinLocaleEn(page);
    for (const tab of ["market", "supply", "agents", "creations", "tuning", "apps"]) {
      await page.goto(`/agents?tab=${tab}`);
      await expect(page.getByTestId("agent-market-page"), `?tab=${tab}`).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId("agents-page"), `?tab=${tab}`).toHaveCount(0);
    }
  });

  test("retired Settings sections land on the live faces (no 404)", async ({ page }) => {
    await pinLocaleEn(page);
    // packs → the agent-market install panel (add-supply-studio-migration 4.5)
    await page.goto("/settings/packs");
    await expect(page).toHaveURL(/\/agents(\?|$)/);
    await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15000 });
    // presets → the Settings native general section: their management face left
    // the hub with the Creations area, so the redirect must not echo a ?tab=.
    await page.goto("/settings/presets");
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("settings-general")).toBeVisible({ timeout: 15000 });
  });
});

// ── tuning surface (/tuning, formerly the hub's Tuning area) ─────────────────
test.describe("tuning surface", () => {
  test("hosts skill-candidate review and the persona-amendment placeholder", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/tuning");
    await expect(page.getByTestId("tuning-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("tuning-skill-candidates")).toBeVisible();
    // Persona revision capability未上线 — the empty-state placeholder stays
    // visible rather than the 区 being hidden (hub spec carried over verbatim).
    await expect(page.getByTestId("tuning-persona-amendments")).toBeVisible();

    // SkillCandidatesView renders NOTHING when the queue is empty (deliberate:
    // no clutter), so the review box needs a pending proposal to prove the face
    // is wired rather than merely mounted.
    const created = await page.request.post("/api/skill-evolution/propose", {
      data: {
        name: `tuning-probe-${Date.now()}`,
        description: "tuning surface mount probe",
        body: "1. 读取上期口径。\n2. 与本期对齐。\n3. 差异单独列示（调优面挂载探针）。",
        evidence: { source: "e2e#tuning", solved: "口径漂移", boundary: "周报" },
      },
    });
    const id = (await created.json()).candidate.id;
    try {
      await page.reload();
      await expect(page.getByTestId("skill-candidates")).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId(`skill-candidate-${id}`)).toBeVisible();
    } finally {
      await page.request.post(`/api/skill-evolution/candidates/${id}/reject`, {
        data: { reason: "e2e cleanup" },
      });
    }
  });

  // 8.1 back-link, re-aimed at the live doorway: the source-doc chip is an
  // in-app `/studio?doc=` link, and the retirement redirect now hands it to the
  // supply domain with the doc id intact — the whole cross-domain chain, not
  // just the chip's presence. A proposal without a source doc must stay
  // chip-free (honest absence, the cell-MCP path).
  test("source-doc chip walks the retired /studio redirect to the supply domain", async ({
    page,
  }) => {
    await pinLocaleEn(page);
    await page.route(`${STUDIO_ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>facet</title>" }),
    );
    const base = {
      description: "8.1 back-link leg",
      body: "1. 读取上期口径。\n2. 与本期对齐。\n3. 差异单独列示（回链验证腿）。",
      evidence: { source: "turn e2e#1", solved: "口径漂移", boundary: "周报" },
    };
    const linked = await page.request.post("/api/skill-evolution/propose", {
      data: { ...base, name: `doclink-${Date.now()}`, sourceDocId: "bp_e2e_backlink_probe" },
    });
    const bare = await page.request.post("/api/skill-evolution/propose", {
      data: { ...base, name: `nodoc-${Date.now()}` },
    });
    const linkedId = (await linked.json()).candidate.id;
    const bareId = (await bare.json()).candidate.id;
    try {
      await page.goto("/tuning");
      const chip = page.getByTestId(`skill-candidate-source-doc-${linkedId}`);
      await expect(chip).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId(`skill-candidate-source-doc-${bareId}`)).toHaveCount(0);
      await chip.click();
      await expect(page).toHaveURL(
        new RegExp(`^${STUDIO_ORIGIN.replace(/\./g, "\\.")}/#/studio\\?doc=bp_e2e_backlink_probe$`),
      );
    } finally {
      // Cleanup: reject both so the review face stays clean for the next run.
      for (const id of [linkedId, bareId]) {
        await page.request.post(`/api/skill-evolution/candidates/${id}/reject`, {
          data: { reason: "e2e cleanup" },
        });
      }
    }
  });
});

// ── Settings Tools & Skills alias ────────────────────────────────────────────
// One section, two slugs: the canonical `mcp` opens the tools view and the
// legacy `skills` alias opens the skills view (sections.ts aliasProps) — the
// alias resolves into the same component rather than forking it. The hub's
// supply cabinet that used to host a second mount is gone, so /agents must no
// longer render ExtensionsPage at all.
test.describe("settings extensions alias", () => {
  test("one component, two slugs: mcp and skills differ only by sub-view", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/mcp");
    const mcp = page.getByTestId("extensions-page");
    await expect(mcp).toBeVisible({ timeout: 15000 });
    await expect(mcp).toHaveAttribute("data-extensions-type", "mcp");

    await page.goto("/settings/skills");
    const skills = page.getByTestId("extensions-page");
    await expect(skills).toBeVisible({ timeout: 15000 });
    await expect(skills).toHaveAttribute("data-extensions-type", "skills");

    await page.goto("/agents");
    await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("extensions-page")).toHaveCount(0);
  });
});

// ── /packs install face (add-supply-studio-migration 5.2 fix) ────────────────
// facet studio's deployTeam deep link lands on /packs?deployCastPack=<id> —
// the route must exist (previously the catch-all bounced it to /chat) and
// render the pack marketplace surface with the market tab active. This is a
// mount check: the detail dialog's API fan-out is covered by pack specs.
test.describe("packs install face", () => {
  test("/packs mounts the marketplace page instead of falling to chat, deep link param rides", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/packs?deployCastPack=cast_probe_pack");
    await expect(page).toHaveURL(/\/agents\?deployCastPack=cast_probe_pack$/);
    await expect(page.getByTestId("agent-market-page")).toBeVisible();
    // unify-material-market: the pack browse tab is now labelled 智能体/Agents.
    await expect(page.getByTestId("agent-market-tab-agents")).toHaveAttribute("data-active", "true");
    // Not the chat catch-all: no composer.
    await expect(page.locator("textarea[data-testid='composer-input']")).toHaveCount(0);
  });

  test("/packs without params still mounts (direct navigation)", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/packs");
    await expect(page.getByTestId("agent-market-page")).toBeVisible();
  });

  // add-supply-studio-migration 2.2 (live 2026-11-08): the SSO callback returns
  // to /login?deployCastPack=… with the session already set. The old
  // unconditional /login → /chat bounce dropped the handoff, so the cross-domain
  // deploy flow dead-ended on the chat home. Pin the query through the bounce.
  test("login bounce keeps the deploy handoff query", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/login?deployCastPack=cast_probe_pack&v=1");
    await expect(page).toHaveURL(/\/agents\?deployCastPack=cast_probe_pack&v=1$/);
    await expect(page.getByTestId("agent-market-page")).toBeVisible();
  });
});

// ── /studio retirement redirect (add-supply-studio-migration 4.1) ────────────
// The creation surface lives on the supply domain; the old in-domain deep link
// must hand over WITH its query (?doc=/?new=/?fork= ids are migration-stable).
// Live 2026-11-08: <Navigate> was handed an absolute URL, react-router read it
// as an in-app path, and the shell landed on its error face — the redirect now
// replaces the document, which this pins by intercepting the facet navigation.
test.describe("studio retirement redirect", () => {
  test("/studio?doc=… lands on the supply-domain hash deep link with the id intact", async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("https://facet.finddatatech.cloud/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>facet</title>" }),
    );
    await page.goto("/studio?doc=bp_probe_deep_link");
    await expect(page).toHaveURL(/^https:\/\/facet\.finddatatech\.cloud\/#\/studio\?doc=bp_probe_deep_link$/);
  });
});
