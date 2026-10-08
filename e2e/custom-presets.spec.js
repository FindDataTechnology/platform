// ── Custom presets e2e (add-custom-presets) ──────────────────────────────────
//
// The full walkthrough on the real cell runtime: the 自建预设 page's
// create→select→edit→delete round-trip (creation through the actual form —
// persona + reference chips), selecting focuses both patches on the baseline
// plus the preset's compose root with the 「聚焦 · 自建」 badge and the focus
// note in the generated persona, a cross-pack reference follows its pack's
// lifecycle (uninstall drops, reinstall returns), a shadowed id (agents.json
// override) composes full, and a pack install attempting a `user.`-prefixed
// agent id is rejected naming the reserved namespace. Deleting the selected
// preset resets the runtime to the built-in agent and prunes its artifacts.
//
// Serial: one shared agent runtime; the persisted agent.preset, the repo's
// agents.json (temporarily extended for the shadowing case), and the pack are
// restored between tests (afterEach).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { tempStoreDirs, waitForIdle } from "./helpers.js";

const PACK_ID = "cp-e2e-pack";
const PACK_SKILL_A = "cp-pack-skill-a-e2e";
const PACK_SKILL_B = "cp-pack-skill-b-e2e";
const USER_SKILL = "cp-user-skill-e2e";
const EXTRA_MCP = "cp-extra-e2e"; // DB-installed, non-baseline: focused drops it

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsJsonPath = path.join(repoRoot, "agents.json");

const dirs = tempStoreDirs();
const patchPath = (file) => path.join(dirs.dshHome, "profiles", "platform", file);
const presetsRoot = (id) => path.join(dirs.root, "custom-skills", "presets", id);
// dsh-agent-presets' containment regex forbids dots in preset dir names, so
// the generated preset lives under the roster/dash form of the catalog id —
// and a raw set_preset speaks that form too (the agent-switch path maps).
const rosterId = (id) => id.replace(/\./g, "-");
const generatedPreset = (id) => path.join(dirs.dshHome, ".agent-presets", rosterId(id), "agent.cordis.yml");

const mcpServersOf = () =>
  yaml.load(fs.readFileSync(patchPath("mcp.patch.yml"), "utf8"))
    .flatMap((row) => row.insert ?? [])
    .map((e) => e.config.serverName);
const skillDirsOf = () =>
  yaml.load(fs.readFileSync(patchPath("skills.patch.yml"), "utf8"))[0].config.customSkillDirs;

// Switch presets through a raw WS connection; resolves on the server's
// current_preset confirmation (the pack-agent-scoping helper).
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

async function idleSwitch(page, id, attempts = 15) {
  for (let i = 0; ; i++) {
    try {
      return await switchPreset(page, id);
    } catch (e) {
      // Retry the transient guards only: a turn still draining, or a child
      // restart the catalog sync just triggered ("still initializing").
      if (i >= attempts || !/responding|initializing/i.test(String(e?.message))) throw e;
      await page.waitForTimeout(3000);
    }
  }
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

async function installPack(page, version) {
  const manifest = {
    name: "自建引用包",
    description: "custom-presets e2e",
    skills: [
      { name: PACK_SKILL_A, description: "甲", content: `# v${version}\n甲。` },
      { name: PACK_SKILL_B, description: "乙", content: `# v${version}\n乙。` },
    ],
    mcpServers: [],
    agents: [],
  };
  const r = await page.request.post("/api/mypacks/install", {
    data: { packId: PACK_ID, version, manifest },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}

async function createPresetApi(page, body) {
  const r = await page.request.post("/api/agent/presets", { data: body, timeout: 90_000 });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).preset;
}

test.describe.configure({ mode: "serial" });

async function gotoChatZh(page) {
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
  await page.goto("/chat/");
  await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15_000 });
}

// The repo's agents.json (gitignored, machine-local) is extended IN PLACE for
// the shadowing case and always restored — workers:1 keeps this race-free.
let agentsJsonOriginal = null;

test.afterEach(async ({ page }) => {
  await waitForIdle(page, 5000).catch(() => {});
  await switchPreset(page, "standard").catch(() => {});
  // Delete any presets this spec created (the roster is deployment-global).
  const roster = await page.request.get("/api/agent/presets").then((r) => r.json());
  for (const row of roster?.presets ?? []) {
    await page.request.delete(`/api/agent/presets/${row.id}`, { timeout: 90_000 }).catch(() => {});
  }
  await page.request.delete(`/api/mypacks/${PACK_ID}?force=1`).catch(() => {});
  await page.request.delete(`/api/extensions/mcp/${EXTRA_MCP}`).catch(() => {});
  await page.request.delete(`/api/extensions/skills/${USER_SKILL}`).catch(() => {});
  if (agentsJsonOriginal !== null) {
    fs.writeFileSync(agentsJsonPath, agentsJsonOriginal);
    agentsJsonOriginal = null;
    await page.request.post("/api/catalog/refresh").catch(() => {});
  }
});

test("create→select→focus: the page's form, the badge, and both patches", async ({ page }) => {
  test.setTimeout(240_000);
  await gotoChatZh(page);
  await installPack(page, 1);
  const skill = await page.request.post("/api/extensions/skills", {
    data: { name: USER_SKILL, description: "用户技能", content: "# u\n用户技能。" },
  });
  expect(skill.ok(), await skill.text()).toBeTruthy();
  // A non-baseline DB server the focused mode must drop.
  const extra = await page.request.post("/api/extensions/mcp", {
    data: { name: EXTRA_MCP, config: { url: "http://127.0.0.1:9/mcp" }, enabled: true },
  });
  expect(extra.ok(), await extra.text()).toBeTruthy();

  // Create through the actual management page (Settings → 自建预设): name +
  // persona + two reference chips, no free-form name entry anywhere.
  await page.goto("/settings/presets");
  await expect(page.getByTestId("custom-presets-page")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("preset-create").click();
  await page.getByTestId("preset-name-input").fill("Counsel E2E");
  await page.getByTestId("preset-persona-input").fill("你是自建的法务助手，擅长合同审查。");
  await page.getByTestId(`preset-ref-chip-${PACK_SKILL_A}`).click();
  await page.getByTestId(`preset-ref-chip-${USER_SKILL}`).click();
  await page.getByTestId("preset-save").click();
  const item = page.getByTestId("preset-item-user.counsel-e2e");
  await expect(item).toBeVisible({ timeout: 30_000 });

  // The catalog payload: persona-only with the marker + the summary (the
  // cost readout is part of the form — visible above the chips).
  const catalog = await page.request.get("/api/catalog").then((r) => r.json());
  const entry = catalog.agents.find((a) => a.id === "user.counsel-e2e");
  expect(entry?.customPreset).toBe(true);
  expect(entry?.name).toBe("Counsel E2E");
  expect(entry?.packId).toBeUndefined();
  expect(entry?.resourceSummary).toEqual({ skillCount: 2, mcpCount: 0, declared: true });

  // The generated persona carries the custom focus note.
  await expect.poll(() => fs.existsSync(generatedPreset("user.counsel-e2e"))).toBe(true);
  const persona = fs.readFileSync(generatedPreset("user.counsel-e2e"), "utf8");
  expect(persona).toContain("自建的法务助手");
  expect(persona).toContain("自建预设");
  await waitPresetInRoster(page, rosterId("user.counsel-e2e"));

  // Picker: the custom role renders with the 「聚焦 · 自建」 badge.
  await page.goto("/chat/");
  await page.getByTestId("strip-more").click();
  const option = page.getByTestId("strip-agent-option").filter({ hasText: "Counsel E2E" });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await expect(option.getByTestId("strip-agent-focus-badge")).toHaveText("聚焦 · 自建 · 2 技能 · 0 MCP");

  // Selecting focuses both patches: MCP = baseline only (the DB server drops),
  // skills = baseline + the presets/<id>/ compose root only.
  await option.click();
  await expect
    .poll(() => page.evaluate(() => window.__chatStore.getState().currentAgent), { timeout: 90_000 })
    .toBe("user.counsel-e2e");
  expect(mcpServersOf()).toEqual(["memory"]);
  const focusedDirs = skillDirsOf().map((d) => path.resolve(d));
  expect(focusedDirs).toEqual([path.resolve(repoRoot, "skills"), presetsRoot("user.counsel-e2e")]);
  // The compose root links exactly the two available references.
  expect(fs.readdirSync(presetsRoot("user.counsel-e2e")).sort()).toEqual([PACK_SKILL_A, USER_SKILL].sort());
});

test("a cross-pack reference follows its pack's lifecycle", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/chat/");
  await installPack(page, 1);
  const preset = await createPresetApi(page, {
    name: "Lifecycle",
    persona: "p",
    skills: [PACK_SKILL_A],
  });
  await expect.poll(() => fs.existsSync(generatedPreset(preset.id))).toBe(true);
  await waitPresetInRoster(page, rosterId(preset.id));
  await idleSwitch(page, rosterId(preset.id));
  expect(fs.readdirSync(presetsRoot(preset.id))).toEqual([PACK_SKILL_A]);

  // Uninstall: the reference list still names the skill, but composition
  // omits it — no root at all, skills patch is baseline only.
  const uninstall = await page.request.delete(`/api/mypacks/${PACK_ID}`);
  expect(uninstall.ok(), await uninstall.text()).toBeTruthy();
  await expect
    .poll(() => skillDirsOf().map((d) => path.resolve(d)), { timeout: 30_000 })
    .toEqual([path.resolve(repoRoot, "skills")]);
  expect(fs.existsSync(presetsRoot(preset.id))).toBe(false);

  // Reinstall: the reference regains effect with no preset edit.
  await installPack(page, 1);
  await expect
    .poll(() => skillDirsOf().map((d) => path.resolve(d)), { timeout: 30_000 })
    .toEqual([path.resolve(repoRoot, "skills"), presetsRoot(preset.id)]);

  await idleSwitch(page, "standard");
});

test("editing through the page regenerates the persona and the focused set", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoChatZh(page);
  await installPack(page, 1);
  const preset = await createPresetApi(page, {
    name: "Editable",
    persona: "初版人设。",
    skills: [PACK_SKILL_A],
  });
  await expect.poll(() => fs.existsSync(generatedPreset(preset.id))).toBe(true);
  await waitPresetInRoster(page, rosterId(preset.id));
  await idleSwitch(page, rosterId(preset.id));

  // Edit through the page: new persona text + swap the skill reference.
  await page.goto("/settings/presets");
  await expect(page.getByTestId(`preset-item-${preset.id}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`preset-edit-${preset.id}`).click();
  await page.getByTestId("preset-persona-input").fill("改版人设：覆盖原文。");
  await page.getByTestId(`preset-ref-chip-${PACK_SKILL_A}`).click();
  await page.getByTestId(`preset-ref-chip-${PACK_SKILL_B}`).click();
  await page.getByTestId("preset-save").click();
  await expect(page.getByTestId(`preset-item-${preset.id}`)).toBeVisible({ timeout: 30_000 });

  // The generated preset regenerated with the new persona (the catalog sync
  // fires on every mutation)…
  await expect
    .poll(() => fs.readFileSync(generatedPreset(preset.id), "utf8"), { timeout: 30_000 })
    .toContain("改版人设");
  // …and because the preset is LIVE, the focused composition re-derived with
  // the swapped reference.
  await expect
    .poll(() => fs.readdirSync(presetsRoot(preset.id)).sort(), { timeout: 30_000 })
    .toEqual([PACK_SKILL_B]);

  await idleSwitch(page, "standard");
});

test("deleting the selected preset resets to the built-in agent and prunes", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoChatZh(page);
  const preset = await createPresetApi(page, {
    name: "Doomed",
    persona: "即将被删除。",
    // no references — composes the baseline alone, the quickest focus
  });
  await expect.poll(() => fs.existsSync(generatedPreset(preset.id))).toBe(true);
  await waitPresetInRoster(page, rosterId(preset.id));
  // Select through the picker (set_agent) so the store's agent label tracks
  // the switch — the raw set_preset path confirms the preset but never
  // broadcasts agent_changed.
  await page.getByTestId("strip-more").click();
  const option = page.getByTestId("strip-agent-option").filter({ hasText: "Doomed" });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect
    .poll(() => page.evaluate(() => window.__chatStore.getState().currentAgent), { timeout: 90_000 })
    .toBe(preset.id);

  // Delete through the page (confirm dialog test-double: accept).
  page.once("dialog", (d) => d.accept());
  await page.goto("/settings/presets");
  await page.getByTestId(`preset-delete-${preset.id}`).click();
  await expect(page.getByTestId(`preset-item-${preset.id}`)).toHaveCount(0, { timeout: 30_000 });

  // The selection fell back to the built-in agent (agent_changed)…
  await expect
    .poll(() => page.evaluate(() => window.__chatStore.getState().currentAgent), { timeout: 30_000 })
    .toBe("local");
  // …the generated preset and the catalog entry are gone, and the full
  // surface is restored.
  await expect.poll(() => fs.existsSync(generatedPreset(preset.id))).toBe(false);
  const catalog = await page.request.get("/api/catalog").then((r) => r.json());
  expect(catalog.agents.find((a) => a.id === preset.id)).toBeUndefined();
  expect(skillDirsOf().map((d) => path.resolve(d))).toContain(path.resolve(dirs.root, "custom-skills"));
});

test("a shadowed id (agents.json override) composes full", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/chat/");
  const preset = await createPresetApi(page, { name: "Shadowed", persona: "被覆盖的人设。" });
  await expect.poll(() => fs.existsSync(generatedPreset(preset.id))).toBe(true);
  await waitPresetInRoster(page, rosterId(preset.id));

  // The operator's file takes the same id: local overrides the user source.
  agentsJsonOriginal = fs.readFileSync(agentsJsonPath, "utf8");
  const doc = JSON.parse(agentsJsonOriginal);
  doc.agents = [
    ...(doc.agents ?? []),
    {
      id: preset.id,
      type: "agent-remote",
      mode: "chat",
      baseUrl: "http://127.0.0.1:9/v1",
      model: "shadow-model",
      name: "操作员覆盖",
    },
  ];
  fs.writeFileSync(agentsJsonPath, JSON.stringify(doc, null, 2));
  await page.request.post("/api/catalog/refresh");

  // The merged view shows the override; the id composes FULL under the
  // overriding entry's persona (the user root is back in the skills patch).
  const catalog = await page.request.get("/api/catalog").then((r) => r.json());
  const entry = catalog.agents.find((a) => a.id === preset.id);
  expect(entry?.name).toBe("操作员覆盖");
  expect(entry?.customPreset).toBeUndefined();
  await idleSwitch(page, rosterId(preset.id));
  expect(skillDirsOf().map((d) => path.resolve(d))).toContain(path.resolve(dirs.root, "custom-skills"));

  // Restore + verify the preset re-enters the merged view un-shadowed.
  fs.writeFileSync(agentsJsonPath, agentsJsonOriginal);
  agentsJsonOriginal = null;
  await page.request.post("/api/catalog/refresh");
  await expect
    .poll(async () => {
      const c = await page.request.get("/api/catalog").then((r) => r.json());
      return c.agents.find((a) => a.id === preset.id)?.customPreset ?? false;
    }, { timeout: 30_000 })
    .toBe(true);
  await idleSwitch(page, "standard");
});

test("a pack install attempting a user.-prefixed agent id fails naming the reserved namespace", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/chat/");
  const preset = await createPresetApi(page, { name: "Held", persona: "占位。" });

  // The shared validator's reserved-namespace rule (the double-lock's first
  // half; the foreign-owner skip report is unit-verified — an id a preset
  // holds is by construction user.-prefixed, so validation is the reachable
  // guard here): the install fails naming the namespace, nothing
  // materializes, and the preset is untouched.
  const squat = await page.request.post("/api/mypacks/install", {
    data: {
      packId: "cp-squat-pack",
      version: 1,
      manifest: {
        name: "抢注包",
        skills: [{ name: "cp-squat-skill-e2e", description: "d", content: "# c" }],
        agents: [{ id: "user.sneaky", name: "抢注", persona: "p" }],
      },
    },
  });
  expect(squat.status()).toBe(400);
  const body = await squat.json();
  expect(body.details.some((d) => /reserved "user\." namespace/.test(d.error))).toBeTruthy();

  // And spelling a REAL preset's id in the manifest meets the same wall —
  // the namespace rule and the owner rule agree (never-overwrite, either way).
  const collide = await page.request.post("/api/mypacks/install", {
    data: {
      packId: "cp-collide-pack",
      version: 1,
      manifest: {
        name: "同名包",
        skills: [{ name: "cp-collide-skill-e2e", description: "d", content: "# c" }],
        agents: [{ id: preset.id, name: "同名", persona: "p" }],
      },
    },
  });
  expect(collide.status()).toBe(400);
  expect((await collide.json()).details.some((d) => /reserved "user\." namespace/.test(d.error))).toBeTruthy();
  const after = await page.request.get(`/api/agent/presets/${preset.id}`).then((res) => res.json());
  expect(after.preset?.persona).toBe("占位。", "the preset is untouched by the collision attempt");
  const packs = await page.request.get("/api/mypacks").then((res) => res.json());
  expect(packs.packs.some((p) => p.packId === "cp-squat-pack" || p.packId === "cp-collide-pack")).toBe(false);
});
