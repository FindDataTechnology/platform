// ── Deploy-form model/budget e2e (add-deploy-form-model-budget, fast lane) ──
//
// The pack detail dialog's deploy section now offers per-serving-agent model
// and turn-budget inputs whose empty state rides no map (standing precedence:
// preserved override → declaration → platform default). The gateway plane is
// route-mocked statefully (preset-publish-flow.spec.js's pattern): the mock
// records every deploy request so the FORM's wire contract is asserted
// directly — what the deployer typed is what the request carries, and what
// they left empty is what the request omits.
//
// The model lane/roster gates are asserted here in their UI shape only (the
// form surfaces the refusal localized and keeps the form mounted); the
// server-side gate chain has its own coverage in agent-service-config.spec.js.
//
//   npm run test:e2e -- e2e/pack-deploy-config.spec.js

import { expect, test } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const MANIFEST = {
  name: "Deploy form config e2e",
  description: "部署表单模型/预算 e2e",
  tags: ["e2e"],
  skills: [],
  mcpServers: [],
  agents: [
    {
      id: "form-agent",
      name: "表单角色",
      persona: "你是部署表单测试角色。",
      serving: {
        protocol: "a2a",
        model: "e2e-declared-model",
        modelWhitelist: ["e2e-declared-model", "e2e-alt-model"],
        budget: { turnMinutes: 7 },
      },
    },
  ],
};

const PACK = { id: "pack-deploy-cfg-e2e", version: 1 };

function gatewayState() {
  // deployReply: the canned response for the NEXT deploy POST — the default
  // is success; refusal tests swap it (status + body, code included).
  return { deploys: [], deployReply: null };
}

function installGatewayMock(page, state) {
  const json = (body, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  const summary = {
    id: PACK.id,
    authorEmail: "e2e@example.test",
    createdAt: Date.now(),
    version: PACK.version,
    name: MANIFEST.name,
    description: MANIFEST.description,
    tags: ["e2e"],
    publishedAt: Date.now(),
  };
  return page.route("**/api/packs**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();

    if (method === "GET" && path === "/api/packs/serving-status") {
      return route.fulfill(json({ configured: true }));
    }
    if (method === "GET" && path === "/api/packs/billing/me") {
      return route.fulfill(json({ linked: true, balance: 10, accountState: "ok", panelUrl: "https://panel.example.test" }));
    }
    if (method === "GET" && path === "/api/packs") {
      return route.fulfill(json({ packs: [summary] }));
    }
    if (method === "GET" && path === `/api/packs/${PACK.id}`) {
      return route.fulfill(json({ ...summary, manifest: MANIFEST }));
    }
    if (method === "GET" && /\/billing-bindings$/.test(path)) {
      return route.fulfill(json({}));
    }
    if (method === "GET" && /\/deployments$/.test(path)) {
      return route.fulfill(json({ deployments: [] }));
    }
    const dep = path.match(/^\/api\/packs\/([^/]+)\/versions\/(\d+)\/deploy$/);
    if (method === "POST" && dep) {
      state.deploys.push({ packId: dep[1], version: Number(dep[2]), body: req.postDataJSON() });
      if (state.deployReply) {
        const { status, body } = state.deployReply;
        return route.fulfill(json(body, status));
      }
      return route.fulfill(
        json({
          deployed: [{ agentId: "form-agent", agentPath: `packs/${dep[1]}/form-agent`, skills: [] }],
          billing: { linked: true },
          effectiveWithinSecs: 300,
        }),
      );
    }
    return route.fulfill(json({ error: `unmocked gateway path: ${method} ${path}` }, 500));
  });
}

async function openDeployForm(page) {
  await pinLocaleEn(page);
  await page.goto("/packs?tab=market");
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15_000 });
  // `market` is a retired slug normalized to `agents` (agent-catalog) — the
  // stale name here clicked a tab that cannot render.
  await page.getByTestId("agent-market-tab-agents").click(); // market tab, then the card
  await page.getByTestId(`pack-card-${PACK.id}`).click();
  await expect(page.getByTestId("pack-detail")).toBeVisible();
  await expect(page.getByTestId("pack-deploy-model-form-agent")).toBeVisible({ timeout: 15_000 });
}

test("deploy form: declaration context renders, empty rides no maps, budget rides, invalid blocks", async ({ page }) => {
  test.setTimeout(120_000);
  const state = gatewayState();
  await installGatewayMock(page, state);
  await openDeployForm(page);

  // Declaration context: whitelist hint + datalist options + declared
  // placeholders make the empty-input effect visible before submit.
  await expect(page.getByTestId("pack-deploy-model-wl-form-agent")).toContainText("e2e-declared-model");
  await expect(page.locator('#pack-deploy-model-wl-form-agent option[value="e2e-alt-model"]')).toHaveCount(1);
  await expect(page.getByTestId("pack-deploy-model-form-agent")).toHaveAttribute("placeholder", "e2e-declared-model");
  await expect(page.getByTestId("pack-deploy-budget-form-agent")).toHaveAttribute("placeholder", "7");

  // Empty inputs ride no maps — the standing-precedence semantics (D1): the
  // request carries neither models nor budgets nor rhythms.
  await page.getByTestId("pack-deploy-btn").click();
  await expect.poll(() => state.deploys.length, { timeout: 15_000 }).toBe(1);
  expect(state.deploys[0].body.models).toBeUndefined();
  expect(state.deploys[0].body.budgets).toBeUndefined();
  expect(state.deploys[0].body.rhythms).toBeUndefined();
  // Settle wait (same race discipline as below): the success handler's draft
  // clears land after the mock records the request.
  await expect(page.getByTestId("pack-deploy-btn")).toBeEnabled({ timeout: 15_000 });

  // A filled budget rides the request; the model stays omitted.
  await page.getByTestId("pack-deploy-budget-form-agent").fill("20");
  await page.getByTestId("pack-deploy-btn").click();
  await expect.poll(() => state.deploys.length, { timeout: 15_000 }).toBe(2);
  expect(state.deploys[1].body.budgets).toEqual({ "form-agent": 20 });
  expect(state.deploys[1].body.models).toBeUndefined();

  // Wait for the success handler to settle before the next fill: the poll
  // above passes when the mock RECORDS the request, and the handler's draft
  // clears land after the response — a fill racing that clear would vanish.
  await expect(page.getByTestId("pack-deploy-btn")).toBeEnabled({ timeout: 15_000 });

  // An invalid budget never leaves the form (D2): hint under the input,
  // submit disabled, no request fired.
  await page.getByTestId("pack-deploy-budget-form-agent").fill("121");
  await expect(page.getByTestId("pack-deploy-budget-invalid-form-agent")).toBeVisible();
  await expect(page.getByTestId("pack-deploy-btn")).toBeDisabled();
  await page.waitForTimeout(300);
  expect(state.deploys.length).toBe(2);
});

test("deploy form: a filled model rides the request and a lane refusal surfaces localized", async ({ page }) => {
  test.setTimeout(120_000);
  const state = gatewayState();
  state.deployReply = {
    status: 400,
    body: { error: "models.form-agent: model 'e2e-alt-model' is not authorized on the deployment key's billing lanes", code: "MODEL_LANE_REJECTED" },
  };
  await installGatewayMock(page, state);
  await openDeployForm(page);

  await page.getByTestId("pack-deploy-model-form-agent").fill("e2e-alt-model");
  await page.getByTestId("pack-deploy-btn").click();
  await expect.poll(() => state.deploys.length, { timeout: 15_000 }).toBe(1);
  expect(state.deploys[0].body.models).toEqual({ "form-agent": "e2e-alt-model" });

  // The refusal surfaces with its localized prefix and the server's reason
  // (which names the agent and the gate), and the form stays mounted.
  const detail = page.getByTestId("pack-detail");
  await expect(detail).toContainText("Model choice refused", { timeout: 15_000 });
  await expect(detail).toContainText("billing lanes");
  await expect(page.getByTestId("pack-deploy-model-form-agent")).toBeVisible();
});

test("deploy form: the unlinked-billing-plane model refusal stays a form error, never the guidance panel", async ({ page }) => {
  test.setTimeout(120_000);
  const state = gatewayState();
  state.deployReply = {
    status: 503,
    body: { error: "billing plane not configured — model lanes cannot be validated" },
  };
  await installGatewayMock(page, state);
  await openDeployForm(page);

  await page.getByTestId("pack-deploy-model-form-agent").fill("e2e-alt-model");
  await page.getByTestId("pack-deploy-btn").click();
  await expect.poll(() => state.deploys.length, { timeout: 15_000 }).toBe(1);

  // Regression guard for the catch-order trap: the 503's text also matches
  // the serving-not-configured branch's /not configured/i — the narrow
  // model-lanes branch must win, or the whole form would be swapped for the
  // self-host guidance panel and bury the reason.
  const detail = page.getByTestId("pack-detail");
  await expect(detail).toContainText("Model lanes cannot be validated", { timeout: 15_000 });
  await expect(page.getByTestId("pack-deploy-model-form-agent")).toBeVisible();
  await expect(page.getByTestId("pack-deploy-btn")).toBeVisible();
});
