import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Onboarding (add-onboarding-tutorial): the three-step first-run tour, its
// persistence, the restructured help center, and the pack guide card in the
// market detail. Unlike every other spec, these tests use a BARE context —
// pinLocaleEn opts all other specs out of the tour via the done marker; here
// an inline pin keeps only the locale pinned so the tour actually appears.

async function pinLocaleKeepTour(page) {
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem("platform.locale")) localStorage.setItem("platform.locale", "en");
    } catch { /* ignore */ }
  });
}

async function gotoFreshChat(page) {
  await pinLocaleKeepTour(page);
  await page.goto("/chat/");
  await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
}

test.describe("first-run tour", () => {
  test("a fresh browser sees the three steps and finishing persists the done marker", async ({ page }) => {
    await gotoFreshChat(page);
    await expect(page.getByTestId("tour-card")).toBeVisible();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-step", "1");

    await page.getByTestId("tour-next").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-step", "2");
    await page.getByTestId("tour-next").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-step", "3");
    // The last step's button reads Done and dismisses.
    await page.getByTestId("tour-next").click();
    await expect(page.getByTestId("tour-card")).toHaveCount(0);

    // Reload: the marker persists, no tour again.
    await page.reload();
    await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
    await expect(page.getByTestId("tour-card")).toHaveCount(0);
  });

  test("skip persists too", async ({ page }) => {
    await gotoFreshChat(page);
    await expect(page.getByTestId("tour-card")).toBeVisible();
    await page.getByTestId("tour-skip").click();
    await expect(page.getByTestId("tour-card")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
    await expect(page.getByTestId("tour-card")).toHaveCount(0);
  });

  test("Escape dismisses and the surface stays interactive", async ({ page }) => {
    await gotoFreshChat(page);
    await expect(page.getByTestId("tour-card")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tour-card")).toHaveCount(0);
    // The underlying composer is reachable after dismissal.
    await expect(page.getByTestId("composer-input")).toBeEditable();
  });

  test("the tour does not appear when the done marker is already set", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/chat/");
    await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
    await expect(page.getByTestId("tour-card")).toHaveCount(0);
  });
});

test.describe("help center", () => {
  async function openHelp(page) {
    await pinLocaleKeepTour(page);
    await page.goto("/chat/");
    await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
    await page.getByTestId("composer-input").fill("/help");
    await page.keyboard.press("Escape"); // dismiss the slash picker, keep the text
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("help-dialog")).toBeVisible({ timeout: 15000 });
  }

  test("three tabs render and quick start is default", async ({ page }) => {
    await openHelp(page);
    await expect(page.getByTestId("help-tab-start")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("help-start")).toBeVisible();
    await page.getByTestId("help-tab-guides").click();
    await expect(page.getByTestId("help-guides")).toBeVisible();
    // The client content module is an EMPTY shell since move-pack-guides-to-
    // manifest 3.3 终态 (2026-11-01): every guide body moved into the pack's
    // own manifest, and the help tab's per-pack list therefore renders the
    // honest empty state instead of a hardcoded six. The tab itself stays a
    // first-class surface (empty-state copy, not a hidden tab), which is what
    // this asserts.
    await expect(page.getByTestId("help-guide-item")).toHaveCount(0);
    await expect(page.getByTestId("help-guides-empty")).toContainText("No scenario guides yet.");
    await page.getByTestId("help-tab-reference").click();
    await expect(page.getByTestId("help-reference")).toBeVisible();
  });

  test("replay affordance clears the marker and re-opens the tour", async ({ page }) => {
    await openHelp(page);
    await page.getByTestId("help-tab-start").click();
    await page.getByTestId("help-replay-tour").click();
    await expect(page.getByTestId("help-dialog")).toBeHidden();
    await expect(page.getByTestId("tour-card")).toBeVisible();
    // Finishing the replay re-arms the done marker.
    await page.getByTestId("tour-skip").click();
    await page.reload();
    await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
    await expect(page.getByTestId("tour-card")).toHaveCount(0);
  });
});

test.describe("pack guide card", () => {
  const COVERED = "J9sO_wRCgUVjbYVEqD4Pog"; // 法律-合同 — manifest carries a guide
  const UNCOVERED = "pack-no-guide-e2e";

  // Since move-pack-guides-to-manifest 3.3 终态 the manifest is the ONLY guide
  // source (the client content module is an empty shell), so the "covered" pack
  // here is covered BY ITS MANIFEST — the same shape a creator publishes.
  function manifest(name, description, guide) {
    return {
      name,
      description,
      version: 1,
      tags: ["法律"],
      skills: [{ name: "demo-skill", description: "演示技能", content: "# demo\n" }],
      mcpServers: [],
      agents: [],
      ...(guide ? { guide } : {}),
    };
  }

  const GUIDE = {
    steps: [
      { title: "准备合同", body: "把待审合同与对照版本放进资料库。" },
      { title: "发起审查", body: "选择法律-合同专家，粘贴条款或引用文档。" },
      { title: "核对结论", body: "按条款逐项核对风险等级与建议措辞。" },
    ],
  };

  async function stubMarket(page) {
    const packs = [
      {
        id: COVERED,
        authorEmail: "a@e2e.test",
        createdAt: Date.now(),
        publishedAt: Date.now(),
        version: 1,
        name: "法律-合同",
        description: "合同全流程审查",
        tags: ["法律"],
        manifest: manifest("法律-合同", "合同全流程审查", GUIDE),
      },
      {
        id: UNCOVERED,
        authorEmail: "a@e2e.test",
        createdAt: Date.now(),
        publishedAt: Date.now(),
        version: 1,
        name: "No Guide Pack",
        description: "没有指南的包",
        tags: ["法律"],
        manifest: manifest("No Guide Pack", "没有指南的包"),
      },
    ];
    const detail = (p) => ({ ...p, manifest: p.manifest });
    await page.route("**/api/packs**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      if (req.method() === "GET" && path === "/api/packs") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            total: packs.length,
            page: 1,
            pageSize: 50,
            packs: packs.map(({ manifest: _m, ...rest }) => rest),
          }),
        });
      }
      const m = path.match(/^\/api\/packs\/([^/]+)$/);
      if (req.method() === "GET" && m) {
        const p = packs.find((x) => x.id === decodeURIComponent(m[1]));
        if (!p) return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Pack not found"}' });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail(p)) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
  }

  test("covered pack shows the guide card with three steps", async ({ page }) => {
    await pinLocaleEn(page);
    await stubMarket(page);
    await page.goto("/packs");
    await expect(page.getByTestId("pack-card-J9sO_wRCgUVjbYVEqD4Pog")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("pack-card-J9sO_wRCgUVjbYVEqD4Pog").click();
    const guide = page.getByTestId("pack-guide-card");
    await expect(guide).toBeVisible();
    // The steps list only — example questions (when present) are a separate
    // block and do not count toward the three steps.
    await expect(page.getByTestId("pack-guide-steps").getByRole("listitem")).toHaveCount(3);
  });

  test("uncovered pack renders no guide card", async ({ page }) => {
    await pinLocaleEn(page);
    await stubMarket(page);
    await page.goto("/packs");
    await expect(page.getByTestId(`pack-card-${UNCOVERED}`)).toBeVisible({ timeout: 15000 });
    await page.getByTestId(`pack-card-${UNCOVERED}`).click();
    await expect(page.getByTestId("pack-detail")).toBeVisible();
    await expect(page.getByTestId("pack-guide-card")).toHaveCount(0);
  });
});

test.describe("welcome prompt dispatch", () => {
  // The dispatch chain (spec: chat-welcome-state) has three rungs: a pack whose
  // content module ships prompts → that zh set; a pack agent or a custom preset
  // with no prompts → the focused chrome set; anything else → the default four.
  //
  // The first rung is empty BY DESIGN today: move-pack-guides-to-manifest 3.3
  // 终态 (2026-11-01) evacuated every per-pack prompt set into the pack's own
  // manifest, and `promptsFor` is the deliberately-kept empty shell (see
  // web/src/lib/packGuides.ts). So every pack agent falls to the focused set,
  // and that is what this describe pins — the ladder itself, not the retired
  // content. The roster is injected through the e2e store seam, so no server
  // state is touched and nothing survives this page.
  const ROSTER = [
    { id: "agent-pack-e2e", name: "Pack Expert", packId: "J9sO_wRCgUVjbYVEqD4Pog" },
    { id: "agent-guide-only-e2e", name: "Guide Only Expert", packId: "qnhd7B3J1-HKDDKzZQ_fUQ" },
    { id: "agent-custom-e2e", name: "Custom Preset Expert", customPreset: "user.demo" },
  ];

  async function selectAgent(page, id) {
    await page.evaluate(
      ([agents, agentId]) => window.__chatStore.setState({ agents, currentAgent: agentId }),
      [ROSTER, id],
    );
  }

  // The card element carries its branch on data-prompt-key, so assertions do
  // not depend on locale copy.
  function promptKeys(page) {
    return page
      .getByTestId("welcome-prompt-card")
      .evaluateAll((cards) => cards.map((c) => c.dataset.promptKey));
  }

  test("every pack agent takes the focused set; switching experts refreshes in place", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/chat/");
    await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });

    // A pack agent — covered or not — lands on the focused chrome set, because
    // the module that used to ship pack prompts is an empty shell.
    await selectAgent(page, "agent-pack-e2e");
    await expect
      .poll(() => promptKeys(page))
      .toEqual(["focused-1", "focused-2", "focused-3", "focused-4"]);

    // A covered pack with a guide but no prompt set → the same focused chrome (en copy).
    await selectAgent(page, "agent-guide-only-e2e");
    await expect
      .poll(() => promptKeys(page))
      .toEqual(["focused-1", "focused-2", "focused-3", "focused-4"]);
    await expect(page.getByTestId("welcome-prompt-card").nth(0)).toContainText(
      "See what this expert does",
    );

    // A custom preset takes the same focused set.
    await selectAgent(page, "agent-custom-e2e");
    await expect
      .poll(() => promptKeys(page))
      .toEqual(["focused-1", "focused-2", "focused-3", "focused-4"]);

    // Leaving the roster entirely restores the default four — the set really
    // swaps with the selection, no reload.
    await page.evaluate(() => window.__chatStore.setState({ currentAgent: "local" }));
    await expect.poll(() => promptKeys(page)).toEqual(["docs", "skills", "tools", "write"]);
  });
});
