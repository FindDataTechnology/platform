// ── Focus overlay e2e (add-focus-overlay) ────────────────────────────────────
//
// The preference-diff contract on the real cell runtime: a stored overlay
// recomposes both patches at every composition point (next switch, live PUT,
// CRUD-driven rewrite, switch-back), additions draw from the enabled
// universe, baseline removal is role-scoped, dangling entries converge
// silently across a pack upgrade and an uninstall, the 资源微调 panel
// round-trips an adjustment, and a second client's panel refreshes from the
// PUT broadcast (deployment-global semantics). MP parity is absent by design
// — asserted statically: the mini-program sources never call the overlay API.
//
// Serial: one shared agent runtime; the persisted agent.preset and the stored
// overlay are restored between tests (afterEach).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { tempStoreDirs, waitForIdle } from "./helpers.js";

const PACK_ID = "focus-overlay-e2e";
const AGENT_ID = "overlay-tuner-e2e";
const PACK_NAME = "微调自检包";
const SKILL_A = "overlay-skill-a-e2e";
const SKILL_B = "overlay-skill-b-e2e";
const USER_SKILL = "overlay-user-skill-e2e";
const EXTRA_MCP = "overlay-extra-e2e"; // DB-installed, enabled, non-baseline
const REGISTRY_REF = "e2e-registry-mcp";

const manifest = (version, extra = {}) => ({
  name: PACK_NAME,
  description: "focus-overlay e2e",
  tags: ["e2e"],
  // v1/v2 rename SKILL_A → SKILL_A2 (the upgrade-drift scenario).
  skills: extra.skills ?? [
    { name: SKILL_A, description: "甲", content: `# v${version}\n甲。` },
    { name: SKILL_B, description: "乙", content: `# v${version}\n乙。` },
  ],
  mcpServers: extra.mcpServers ?? [{ registryName: REGISTRY_REF }],
  agents: [{ id: AGENT_ID, name: "微调官", persona: "你是微调官。" }],
});

const dirs = tempStoreDirs();
const patchPath = (file) => path.join(dirs.dshHome, "profiles", "platform", file);
const packRoot = path.join(dirs.root, "custom-skills", "packs", PACK_ID);
const personaRoot = path.join(packRoot, "personas", AGENT_ID);

const mcpServersOf = (file = "mcp.patch.yml") =>
  yaml.load(fs.readFileSync(patchPath(file), "utf8"))
    .flatMap((row) => row.insert ?? [])
    .map((e) => e.config.serverName);
const skillDirsOf = () =>
  yaml.load(fs.readFileSync(patchPath("skills.patch.yml"), "utf8"))[0].config.customSkillDirs;

// Switch presets through a raw WS connection (the pack-agent-scoping helper).
function switchPreset(page, id) {
  return page.evaluate(
    (presetId) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error(`set_preset(${presetId}) timeout`));
        }, 90000);
        let sent = false;
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === "error" && sent) {
            clearTimeout(timer);
            ws.close();
            reject(new Error(msg.message));
          }
          if (msg.type === "current_preset" && msg.id === presetId && sent) {
            clearTimeout(timer);
            ws.close();
            resolve(msg.id);
          }
        };
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "set_preset", id: presetId }));
          sent = true;
        };
      }),
    id,
  );
}

// A switch may race a still-draining turn (the dead-LLM guard probe retries
// with backoff before its error lands) — retry on the streaming guard until
// the runtime settles.
async function idleSwitch(page, id, attempts = 15) {
  for (let i = 0; ; i++) {
    try {
      return await switchPreset(page, id);
    } catch (e) {
      if (i >= attempts || !/responding/i.test(String(e?.message))) throw e;
      await page.waitForTimeout(3000);
    }
  }
}

async function installPack(page, version, extra) {
  const r = await page.request.post("/api/mypacks/install", {
    data: { packId: PACK_ID, version, manifest: manifest(version, extra) },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}

async function connectRegistry(page) {
  const connect = await page.request.post("/api/registry/credential", {
    data: { token: "opaque-e2e-token", source: "paste" },
  });
  expect(connect.ok()).toBeTruthy();
}

async function addExtraServer(page, name = EXTRA_MCP) {
  const r = await page.request.post("/api/extensions/mcp", {
    data: { name, config: { url: "http://127.0.0.1:9/mcp" }, enabled: true },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
}

async function putOverlay(page, preset, overlay) {
  const r = await page.request.put("/api/agent/overlay", {
    data: { preset, ...(overlay === null ? { overlay: null } : { overlay }) },
    timeout: 90_000,
  });
  return { status: r.status(), body: await r.json() };
}

async function waitPresetInRoster(page, id) {
  await expect
    .poll(
      () =>
        page.evaluate(
          (presetId) =>
            new Promise((resolve) => {
              const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
              const timer = setTimeout(() => {
                ws.close();
                resolve(false);
              }, 4000);
              let sent = false;
              ws.onmessage = (ev) => {
                const msg = JSON.parse(ev.data);
                if (sent && msg.type === "presets") {
                  clearTimeout(timer);
                  ws.close();
                  resolve(msg.presets.some((p) => p.id === presetId && !p.broken));
                }
              };
              ws.onopen = () => {
                ws.send(JSON.stringify({ type: "list_presets" }));
                sent = true;
              };
            }),
          id,
        ),
      { timeout: 90_000 },
    )
    .toBe(true);
}

async function prepareRole(page, version = 1, extra) {
  await connectRegistry(page);
  const { report } = await installPack(page, version, extra);
  expect(report.mcpServers.find((m) => m.name === REGISTRY_REF)?.status).toBe("installed");
  await expect
    .poll(() => fs.existsSync(path.join(dirs.dshHome, ".agent-presets", AGENT_ID, "agent.cordis.yml")))
    .toBe(true);
  await waitPresetInRoster(page, AGENT_ID);
}

test.describe.configure({ mode: "serial" });

async function gotoChatZh(page) {
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
  await page.goto("/chat/");
  await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15_000 });
}

test.afterEach(async ({ page }) => {
  await waitForIdle(page, 60_000).catch(() => {});
  await idleSwitch(page, "standard").catch(() => {});
  await putOverlay(page, AGENT_ID, null).catch(() => {});
  await page.request.delete(`/api/mypacks/${PACK_ID}?force=1`).catch(() => {});
  await page.request.delete(`/api/extensions/mcp/${EXTRA_MCP}`).catch(() => {});
  await page.request.delete(`/api/extensions/mcp/${REGISTRY_REF}`).catch(() => {});
  await page.request.delete(`/api/extensions/skills/${USER_SKILL}`).catch(() => {});
});

test("a stored overlay recomposes both patches and the GET exposes the diff and the universes", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/chat/");
  await prepareRole(page);
  await addExtraServer(page);
  const skill = await page.request.post("/api/extensions/skills", {
    data: { name: USER_SKILL, description: "用户技能", content: "# u" },
  });
  expect(skill.ok(), await skill.text()).toBeTruthy();

  // The stored diff is a preference, not a snapshot: PUT while the role is
  // NOT live stores it (no rewrite needed — the next switch composes).
  const put = await putOverlay(page, AGENT_ID, {
    addMcp: [EXTRA_MCP], removeMcp: [], addSkills: [USER_SKILL], removeSkills: [SKILL_A],
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);

  // The GET reports the diff, the effective set, and the addable universes —
  // the panel's single source.
  const doc = await page.request.get(`/api/agent/overlay?preset=${AGENT_ID}`).then((r) => r.json());
  expect(doc.overlay?.addMcp).toEqual([EXTRA_MCP]);
  expect(doc.effective.mcpServers).toEqual(expect.arrayContaining(["memory", REGISTRY_REF, EXTRA_MCP]));
  expect(doc.effective.skills.sort()).toEqual([SKILL_B, USER_SKILL].sort());
  expect(doc.addableMcp).not.toContain(EXTRA_MCP);

  // Selecting the role composes derived ± overlay: the non-baseline server
  // enters the focused MCP set, and the persona compose root (forced for an
  // undeclared persona) links whole-pack minus the removal plus the add.
  await idleSwitch(page, AGENT_ID);
  const servers = mcpServersOf();
  expect(servers).toContain(EXTRA_MCP);
  expect(servers).toContain(REGISTRY_REF);
  expect(servers).toContain("memory");
  const dirList = skillDirsOf();
  expect(dirList).toContain(personaRoot);
  expect(dirList).not.toContain(packRoot);
  expect(fs.readdirSync(personaRoot).sort()).toEqual([SKILL_B, USER_SKILL].sort());

  // Switching away and back recomposes from the stored preference — the same
  // derivation a restart would run (no snapshot anywhere to go stale).
  await idleSwitch(page, "standard");
  expect(mcpServersOf()).toContain(EXTRA_MCP); // full mode ignores the diff
  await idleSwitch(page, AGENT_ID);
  expect(mcpServersOf()).toContain(EXTRA_MCP);
  expect(fs.readdirSync(personaRoot).sort()).toEqual([SKILL_B, USER_SKILL].sort());
});

test("a live PUT rewrites both patches for the next session and rejects mid-stream", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/chat/");
  await prepareRole(page);
  await addExtraServer(page);
  await idleSwitch(page, AGENT_ID);
  await putOverlay(page, AGENT_ID, { addMcp: [EXTRA_MCP], removeMcp: [], addSkills: [], removeSkills: [] });

  // Baseline removal through the LIVE preset: the PUT rides the serialized
  // mutation path — rewrite both patches + idle restart — so the response
  // resolves only once the next session would compose adjusted.
  const live = await putOverlay(page, AGENT_ID, {
    addMcp: [EXTRA_MCP], removeMcp: ["memory"], addSkills: [], removeSkills: [],
  });
  expect(live.status, JSON.stringify(live.body)).toBe(200);
  const servers = mcpServersOf();
  expect(servers).not.toContain("memory", "the baseline server is removed for THIS role");
  expect(servers).toContain(EXTRA_MCP);

  // Role-scoped: full mode still loads the baseline the overlay removed.
  await idleSwitch(page, "standard");
  expect(mcpServersOf()).toContain("memory");

  // The set_preset guard: `prompt` sets isStreaming synchronously at dispatch
  // (no await before it), so a PUT fired right after the WS frame hits the
  // guard — deterministically, without waiting on any real model output. A
  // lost race would CLEAR the diff (a 200), so restore + retry once.
  const intended = { addMcp: [EXTRA_MCP], removeMcp: ["memory"], addSkills: [], removeSkills: [] };
  const guardProbe = () =>
    page.evaluate(
      (presetId) =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(window.location.origin.replace(/^http/, "ws") + "/");
          const timer = setTimeout(() => reject(new Error("guard probe timeout")), 30000);
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: "prompt", text: "overlay guard probe" }));
            // Same task, strictly after the WS frame: the loopback fetch lands
            // after the prompt was admitted.
            fetch("/api/agent/overlay", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ preset: presetId, overlay: null }),
            }).then((r) => {
              clearTimeout(timer);
              ws.close();
              resolve(r.status);
            }, (e) => reject(new Error(String(e))));
          };
        }),
      AGENT_ID,
    );
  let outcome = await guardProbe();
  if (outcome !== 409) {
    await putOverlay(page, AGENT_ID, intended);
    outcome = await guardProbe();
  }
  expect(outcome).toBe(409);

  // The rejected PUT stored nothing: the diff still holds the removal.
  const doc = await page.request.get(`/api/agent/overlay?preset=${AGENT_ID}`).then((r) => r.json());
  expect(doc.overlay?.removeMcp).toEqual(["memory"]);
});

test("dangling entries converge silently across an uninstall and a pack upgrade", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/chat/");
  await prepareRole(page);
  await addExtraServer(page);
  await idleSwitch(page, AGENT_ID);
  const { status } = await putOverlay(page, AGENT_ID, {
    addMcp: [EXTRA_MCP], removeMcp: [], addSkills: [], removeSkills: [SKILL_A],
  });
  expect(status).toBe(200);
  await expect.poll(() => mcpServersOf(), { timeout: 20_000 }).toContain(EXTRA_MCP);

  // Drift 1 — the ADDED server is uninstalled: the CRUD-driven rewrite
  // re-derives focused, the add resolves to nothing, and the entry is inert
  // (no error state; the diff row itself stays untouched).
  const del = await page.request.delete(`/api/extensions/mcp/${EXTRA_MCP}`);
  expect(del.ok()).toBeTruthy();
  await expect.poll(() => mcpServersOf(), { timeout: 20_000 }).not.toContain(EXTRA_MCP);
  const afterUninstall = await page.request.get(`/api/agent/overlay?preset=${AGENT_ID}`).then((r) => r.json());
  expect(afterUninstall.overlay?.addMcp).toEqual([EXTRA_MCP], "the stored diff is not pruned by drift");

  // Drift 2 — a pack upgrade RENAMES the removed skill: the stale removal
  // targets a name that no longer exists, so the renamed skill composes as
  // part of the derived set (and the uninstall-drift add stays inert).
  await connectRegistry(page);
  await installPack(page, 2, {
    skills: [
      { name: "overlay-skill-a2-e2e", description: "甲改", content: "# v2\n甲改。" },
      { name: SKILL_B, description: "乙", content: "# v2\n乙。" },
    ],
  });
  await expect
    .poll(() => (fs.existsSync(personaRoot) ? fs.readdirSync(personaRoot).sort() : []), { timeout: 20_000 })
    .toEqual(["overlay-skill-a2-e2e", SKILL_B].sort());
});

test("the 资源微调 panel round-trips an adjustment", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoChatZh(page);
  await prepareRole(page);
  await addExtraServer(page);

  // Open the picker, then the role's adjust affordance (pack roles only).
  await page.getByTestId("strip-more").click();
  const option = page.getByTestId("strip-agent-option").filter({ hasText: "微调官" });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`strip-agent-adjust-${AGENT_ID}`).click();

  const panel = page.getByTestId("overlay-panel");
  await expect(panel).toBeVisible();
  // The role's derived set renders: the baseline server, the pack ref, and
  // both pack skills; the enabled non-baseline server sits in the addable row.
  await expect(panel.getByTestId(`overlay-item-${REGISTRY_REF}`)).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId(`overlay-item-${SKILL_A}`)).toBeVisible();
  await expect(panel.getByTestId(`overlay-add-${EXTRA_MCP}`)).toBeVisible();

  // Add the server, remove one skill, apply — the note states the
  // next-session contract.
  await panel.getByTestId(`overlay-add-${EXTRA_MCP}`).click();
  await panel.getByTestId(`overlay-item-${SKILL_A}`).click();
  await expect(panel.getByTestId(`overlay-item-${SKILL_A}`)).toHaveAttribute("data-removed", "true");
  await panel.getByTestId("overlay-apply").click();
  await expect(panel.getByTestId("overlay-note")).toBeVisible({ timeout: 30_000 });

  // Reopening shows the ADJUSTED effective set (the GET recomposes): the
  // added server is a member now; the removed skill left the effective set
  // and renders in the addable row — restorable from there.
  await page.keyboard.press("Escape");
  await page.getByTestId("strip-more").click();
  await page.getByTestId(`strip-agent-adjust-${AGENT_ID}`).click();
  await expect(panel.getByTestId(`overlay-item-${EXTRA_MCP}`)).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId(`overlay-item-${SKILL_A}`)).toHaveCount(0);
  await expect(panel.getByTestId(`overlay-add-${SKILL_A}`)).toBeVisible();

  // The applied diff is what the next composition of the role loads.
  await idleSwitch(page, AGENT_ID);
  expect(mcpServersOf()).toContain(EXTRA_MCP);
  expect(fs.readdirSync(personaRoot).sort()).toEqual([SKILL_B].sort());
});

test("a second client's panel refreshes after a PUT broadcast", async ({ page, context }) => {
  test.setTimeout(180_000);
  await gotoChatZh(page);
  await prepareRole(page);
  await addExtraServer(page);

  // Client B opens the same role's panel…
  const pageB = await context.newPage();
  await pageB.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
  await pageB.goto("/chat/");
  await expect(pageB.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15_000 });
  await pageB.getByTestId("strip-more").click();
  await expect(pageB.getByTestId("strip-agent-option").filter({ hasText: "微调官" })).toBeVisible({ timeout: 30_000 });
  await pageB.getByTestId(`strip-agent-adjust-${AGENT_ID}`).click();
  const panelB = pageB.getByTestId("overlay-panel");
  await expect(panelB.getByTestId(`overlay-item-${REGISTRY_REF}`)).toBeVisible({ timeout: 15_000 });
  await expect(panelB.getByTestId(`overlay-add-${EXTRA_MCP}`)).toBeVisible();

  // …client A adjusts through the API (deployment-global: any writer counts).
  const put = await putOverlay(page, AGENT_ID, {
    addMcp: [EXTRA_MCP], removeMcp: [], addSkills: [], removeSkills: [],
  });
  expect(put.status).toBe(200);

  // B's view refreshes from the broadcast — same adjustments, same role.
  await expect(panelB.getByTestId(`overlay-item-${EXTRA_MCP}`)).toBeVisible({ timeout: 15_000 });
  await expect(panelB.getByTestId(`overlay-add-${EXTRA_MCP}`)).toHaveCount(0);
  await pageB.close();
});

test("miniprogram parity is absent by design (no overlay API in the MP client)", async () => {
  // The MP fast-follow is documented, not shipped: a static assertion that
  // the mini-program sources never call the overlay API (its picker keeps the
  // read-only role badge from add-persona-resource-sets).
  const miniappRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "miniapp", "src");
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js|wxml|wxss|json)$/.test(entry.name)) {
        if (fs.readFileSync(full, "utf8").includes("agent/overlay")) hits.push(full);
      }
    }
  };
  walk(miniappRoot);
  expect(hits).toEqual([]);
});
