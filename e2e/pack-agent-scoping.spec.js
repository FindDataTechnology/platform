// ── Pack agent scoping e2e (add-pack-agent-scoping) ──────────────────────────
//
// The full focused walkthrough on the real cell runtime: install a pack →
// its role appears in the picker with the focus badge (packId from the
// catalog payload) → selecting it rewrites BOTH patch files focused (probed
// from the store's dsh-home) and its generated persona carries the focus
// note → MCP CRUD and a pack upgrade while focused keep the focus (a new pack
// MCP ref enters the focused set, a non-baseline server stays out) →
// switching back restores the full surface → uninstall leaves no orphan pack
// root and the skills patch stops listing it.
//
// The honest-decline turn needs a real model, so it lives behind @smoke
// (same discipline as chat-turn.spec.js).
//
// Serial: one shared agent runtime, and the persisted agent.preset must be
// restored between tests (afterEach).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { gotoChat, tempStoreDirs, waitForIdle } from "./helpers.js";

const PACK_ID = "pack-scope-e2e";
const AGENT_ID = "scope-reviewer-e2e";
const PACK_NAME = "聚焦自检包";
const SKILL_NAME = "scope-skill-e2e";
const EXTRA_MCP = "scope-extra-e2e"; // DB-installed, non-baseline: focused drops it

const manifest = (version, extra = {}) => ({
  name: PACK_NAME,
  description: "pack-agent-scoping e2e",
  tags: ["e2e"],
  skills: extra.skills ?? [{ name: SKILL_NAME, description: "聚焦技能", content: `# v${version}\n按聚焦模式审查。` }],
  mcpServers: extra.mcpServers ?? [],
  agents: [
    {
      id: AGENT_ID,
      name: "聚焦审查官",
      persona: "你是聚焦审查官。",
      ...(extra.resources !== undefined ? { resources: extra.resources } : {}),
    },
  ],
});

const dirs = tempStoreDirs();
const patchPath = (file) => path.join(dirs.dshHome, "profiles", "platform", file);
const packRoot = path.join(dirs.root, "custom-skills", "packs", PACK_ID);

const mcpServersOf = (file = "mcp.patch.yml") =>
  yaml.load(fs.readFileSync(patchPath(file), "utf8"))
    .flatMap((row) => row.insert ?? [])
    .map((e) => e.config.serverName);
const skillDirsOf = () =>
  yaml.load(fs.readFileSync(patchPath("skills.patch.yml"), "utf8"))[0].config.customSkillDirs;

// Switch presets through a raw WS connection; resolves on the server's
// current_preset confirmation (after the child restarts).
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

async function installPack(page, version, extra) {
  const r = await page.request.post("/api/mypacks/install", {
    data: { packId: PACK_ID, version, manifest: manifest(version, extra) },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}

// The generated preset must be in the RUNTIME roster (presets/list) before a
// switch — the catalog sync writes the file then restarts the child, and a
// switch racing the restart fails with "Unknown agent mode".
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

async function addExtraServer(page, name = EXTRA_MCP) {
  const r = await page.request.post("/api/extensions/mcp", {
    data: { name, config: { url: "http://127.0.0.1:9/mcp" }, enabled: true },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
}

test.describe.configure({ mode: "serial" });

// goto WITHOUT the en-pinning gotoChat helper: the badge assertion reads the
// zh-CN copy. Waits only for the app shell (the WS helpers below need a real
// origin, not the app's readiness).
async function gotoChatZh(page) {
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
  await page.goto("/chat/");
  await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15_000 });
}

test.afterEach(async ({ page }) => {
  await waitForIdle(page, 5000).catch(() => {});
  await switchPreset(page, "standard").catch(() => {});
  await page.request.delete(`/api/mypacks/${PACK_ID}?force=1`).catch(() => {});
  await page.request.delete(`/api/extensions/mcp/${EXTRA_MCP}`).catch(() => {});
  await page.request.delete("/api/extensions/mcp/e2e-registry-mcp").catch(() => {});
  await page.request.delete("/api/extensions/mcp/e2e-registry-mcp-2").catch(() => {});
  await page.request.delete("/api/extensions/skills/scope-skill2-e2e").catch(() => {});
  await page.request.delete(`/api/extensions/skills/${SKILL_NAME}`).catch(() => {});
});

test("selecting a pack role focuses both patches and badges the picker", async ({ page }) => {
  test.setTimeout(150_000);
  await gotoChatZh(page);
  await installPack(page, 1);
  await addExtraServer(page);

  // The catalog payload carries the packId (+ display name) for the badge.
  const catalog = await page.request.get("/api/catalog").then((r) => r.json());
  const entry = catalog.agents.find((a) => a.id === AGENT_ID);
  expect(entry?.packId).toBe(PACK_ID);
  expect(entry?.packName).toBe(PACK_NAME);

  // The generated persona preset must exist before the picker click (the
  // catalog sync writes it + restarts; a click racing that file would fork
  // the agent remotely instead of switching the preset).
  await expect
    .poll(() => fs.existsSync(path.join(dirs.dshHome, ".agent-presets", AGENT_ID, "agent.cordis.yml")))
    .toBe(true);
  await waitPresetInRoster(page, AGENT_ID);
  const persona = fs.readFileSync(path.join(dirs.dshHome, ".agent-presets", AGENT_ID, "agent.cordis.yml"), "utf8");
  expect(persona).toContain("聚焦模式");
  expect(persona).toContain("切换回标准模式");

  // Picker: the pack agent renders with the focus badge naming its pack and
  // the role's resource summary (v1 manifest: 1 skill, 0 MCP refs).
  await page.getByTestId("strip-more").click();
  const option = page.getByTestId("strip-agent-option").filter({ hasText: "聚焦审查官" });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await expect(option.getByTestId("strip-agent-focus-badge")).toHaveText(
    `聚焦 · ${PACK_NAME} · 1 技能 · 0 MCP`,
  );

  // Selecting the role is a preset switch → both patches rewrite focused,
  // then one restart carries the persona.
  await option.click();
  await expect
    .poll(() => page.evaluate(() => window.__chatStore.getState().currentAgent), { timeout: 90_000 })
    .toBe(AGENT_ID);

  // MCP patch focused: baseline (seeded mcp.json "memory") kept, the
  // non-baseline DB server dropped.
  const focusedServers = mcpServersOf();
  expect(focusedServers).toContain("memory");
  expect(focusedServers).not.toContain(EXTRA_MCP);

  // Skills patch focused: the baseline skills root + the pack root ONLY (the
  // user root is out of the focused set).
  const focusedDirs = skillDirsOf();
  expect(focusedDirs).toContain(packRoot);
  expect(focusedDirs).not.toContain(path.join(dirs.root, "custom-skills"));

  // Switching back restores the full surface (exact today's behavior).
  await switchPreset(page, "standard");
  const fullServers = mcpServersOf();
  expect(fullServers).toContain(EXTRA_MCP);
  const fullDirs = skillDirsOf();
  expect(fullDirs).toContain(path.join(dirs.root, "custom-skills"));
  expect(fullDirs).toContain(packRoot);
});

test("MCP CRUD and a pack upgrade while focused keep the focus", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto("/chat/");
  await installPack(page, 1);
  await addExtraServer(page);
  await expect
    .poll(() => fs.existsSync(path.join(dirs.dshHome, ".agent-presets", AGENT_ID, "agent.cordis.yml")))
    .toBe(true);
  await waitPresetInRoster(page, AGENT_ID);
  await switchPreset(page, AGENT_ID);

  // CRUD while focused: another non-baseline server is added through the
  // normal route — the rewrite re-derives the scope, so it stays out.
  await page.request
    .post("/api/extensions/mcp", {
      data: { name: "scope-crud-e2e", config: { url: "http://127.0.0.1:9/mcp" }, enabled: true },
    })
    .then((r) => expect(r.ok()).toBeTruthy());
  await expect
    .poll(() => mcpServersOf(), { timeout: 20_000 })
    .not.toContain("scope-crud-e2e");
  await page.request.delete("/api/extensions/mcp/scope-crud-e2e").then((r) => expect(r.ok()).toBeTruthy());

  // Upgrade the focused pack to a version adding an MCP reference. The ref
  // installs through the market path (stub registry + pasted credential),
  // the mcpChanged hook re-derives, and the ref lands IN the focused set.
  const connect = await page.request.post("/api/registry/credential", {
    data: { token: "opaque-e2e-token", source: "paste" },
  });
  expect(connect.ok()).toBeTruthy();
  const { report } = await installPack(page, 2, { mcpServers: [{ registryName: "e2e-registry-mcp" }] });
  expect(report.mcpServers.find((m) => m.name === "e2e-registry-mcp")?.status).toBe("installed");
  await expect
    .poll(() => mcpServersOf(), { timeout: 20_000 })
    .toContain("e2e-registry-mcp");
  // Still focused: the non-baseline manual server never comes back.
  expect(mcpServersOf()).not.toContain(EXTRA_MCP);

  await switchPreset(page, "standard");
});

test("uninstall leaves no orphan pack root and the skills patch stops listing it", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/chat/");
  await installPack(page, 1);
  await expect
    .poll(() => fs.existsSync(path.join(dirs.dshHome, ".agent-presets", AGENT_ID, "agent.cordis.yml")))
    .toBe(true);
  await waitPresetInRoster(page, AGENT_ID);
  // Full-mode patch lists the pack root.
  await expect
    .poll(() => skillDirsOf(), { timeout: 20_000 })
    .toContain(packRoot);

  const r = await page.request.delete(`/api/mypacks/${PACK_ID}`);
  expect(r.ok(), await r.text()).toBeTruthy();
  // The pack root is gone from disk…
  await expect.poll(() => fs.existsSync(packRoot)).toBe(false);
  // …and from the skills patch (rewritten by the uninstall route).
  await expect
    .poll(() => skillDirsOf(), { timeout: 30_000 })
    .not.toContain(packRoot);
});

// ── Resource declarations (add-persona-resource-sets) ────────────────────────
// Three scenarios on top of the undeclared behavior covered above: a declared
// subset narrows both patches (MCP counts visible in the patch, skills via the
// persona compose root), an empty declaration focuses to the baseline alone,
// and an upgrade that adds a declaration re-derives the focused patches.

const SKILL2_NAME = "scope-skill2-e2e";
const personaRoot = path.join(packRoot, "personas", AGENT_ID);

async function connectRegistry(page) {
  const connect = await page.request.post("/api/registry/credential", {
    data: { token: "opaque-e2e-token", source: "paste" },
  });
  expect(connect.ok(), await connect.text()).toBeTruthy();
}

test("a declared subset narrows the focused MCP set and scopes skills to the persona root", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/chat/");
  await connectRegistry(page);
  const { report } = await installPack(page, 1, {
    skills: [
      { name: SKILL_NAME, description: "聚焦技能", content: "# v1\n保留。" },
      { name: SKILL2_NAME, description: "第二技能", content: "# v1\n排除。" },
    ],
    mcpServers: [{ registryName: "e2e-registry-mcp" }, { registryName: "e2e-registry-mcp-2" }],
    resources: { skills: [SKILL_NAME], mcpServers: ["e2e-registry-mcp-2"] },
  });
  // Both registry refs really installed — the narrowing below is the
  // declaration's doing, not an unresolvable ref.
  expect(report.mcpServers.map((m) => [m.name, m.status])).toEqual([
    ["e2e-registry-mcp", "installed"],
    ["e2e-registry-mcp-2", "installed"],
  ]);

  await expect
    .poll(() => fs.existsSync(path.join(dirs.dshHome, ".agent-presets", AGENT_ID, "agent.cordis.yml")))
    .toBe(true);
  await waitPresetInRoster(page, AGENT_ID);
  await switchPreset(page, AGENT_ID);

  // MCP patch: ONLY the declared ref of the two (plus the seeded baseline
  // "memory"). The other installed pack ref is dropped by the declaration.
  const servers = mcpServersOf();
  expect(servers).toContain("memory");
  expect(servers).toContain("e2e-registry-mcp-2");
  expect(servers).not.toContain("e2e-registry-mcp");

  // Skills patch: baseline + the PERSONA compose root — not the pack root.
  const focusedDirs = skillDirsOf();
  expect(focusedDirs).toContain(personaRoot);
  expect(focusedDirs).not.toContain(packRoot);
  expect(focusedDirs).not.toContain(path.join(dirs.root, "custom-skills"));
  // The compose root links exactly the declared skill.
  expect(fs.readdirSync(personaRoot).sort()).toEqual([SKILL_NAME]);

  await switchPreset(page, "standard");
});

test("an empty declaration focuses both dimensions to the baseline alone", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto("/chat/");
  await connectRegistry(page);
  await installPack(page, 1, {
    mcpServers: [{ registryName: "e2e-registry-mcp" }],
    resources: { skills: [], mcpServers: [] },
  });
  await expect
    .poll(() => fs.existsSync(path.join(dirs.dshHome, ".agent-presets", AGENT_ID, "agent.cordis.yml")))
    .toBe(true);
  await waitPresetInRoster(page, AGENT_ID);
  await switchPreset(page, AGENT_ID);

  // The pack's ref is installed, yet the empty declaration keeps it out: the
  // focused MCP surface is the baseline ("memory") alone.
  const servers = mcpServersOf();
  expect(servers).toContain("memory");
  expect(servers).not.toContain("e2e-registry-mcp");
  // Skills patch: baseline only — no pack root, no persona root.
  expect(skillDirsOf()).toHaveLength(1);

  await switchPreset(page, "standard");
});

test("an upgrade that adds a declaration re-derives the focused patches", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/chat/");
  await connectRegistry(page);

  // v1 undeclared: whole-pack focus (both refs once installed, pack root).
  await installPack(page, 1, { mcpServers: [{ registryName: "e2e-registry-mcp" }] });
  await expect
    .poll(() => fs.existsSync(path.join(dirs.dshHome, ".agent-presets", AGENT_ID, "agent.cordis.yml")))
    .toBe(true);
  await waitPresetInRoster(page, AGENT_ID);
  await switchPreset(page, AGENT_ID);
  await expect
    .poll(() => mcpServersOf(), { timeout: 20_000 })
    .toContain("e2e-registry-mcp");
  expect(skillDirsOf()).toContain(packRoot);

  // v2 adds a second ref + a second skill AND declares a subset that keeps
  // only the new ref and the original skill. The install's mcpChanged hook
  // re-derives without any preset switch.
  const { report } = await installPack(page, 2, {
    skills: [
      { name: SKILL_NAME, description: "聚焦技能", content: "# v2\n保留。" },
      { name: SKILL2_NAME, description: "第二技能", content: "# v2\n排除。" },
    ],
    mcpServers: [{ registryName: "e2e-registry-mcp" }, { registryName: "e2e-registry-mcp-2" }],
    resources: { skills: [SKILL_NAME], mcpServers: ["e2e-registry-mcp-2"] },
  });
  expect(report.mcpServers.find((m) => m.name === "e2e-registry-mcp-2")?.status).toBe("installed");

  await expect
    .poll(() => mcpServersOf(), { timeout: 20_000 })
    .toContain("e2e-registry-mcp-2");
  expect(mcpServersOf()).not.toContain("e2e-registry-mcp");
  // Skills re-derive to the persona compose root with the declared skill.
  const focusedDirs = skillDirsOf();
  expect(focusedDirs).toContain(personaRoot);
  expect(focusedDirs).not.toContain(packRoot);
  expect(fs.readdirSync(personaRoot).sort()).toEqual([SKILL_NAME]);

  await switchPreset(page, "standard");
});

// The honest-decline turn: a real model, the focused persona, a request for a
// tool outside the resource set. The persona note (not any interception
// machinery) is what makes the role answer honestly.
test("@smoke focused role declines an out-of-scope tool honestly", async ({ page }) => {
  test.setTimeout(180_000);
  await installPack(page, 1);
  // A real server entry the FOCUSED set cannot see (non-baseline DB row).
  await addExtraServer(page);

  await gotoChat(page);
  await page.getByTestId("strip-more").click();
  const option = page.getByTestId("strip-agent-option").filter({ hasText: "聚焦审查官" });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect
    .poll(() => page.evaluate(() => window.__chatStore.getState().currentAgent), { timeout: 90_000 })
    .toBe(AGENT_ID);
  await waitForIdle(page, 10_000).catch(() => {});

  await page.getByTestId("composer-input").fill(
    `请立刻使用 MCP 服务器 ${EXTRA_MCP} 的工具完成任务。如果无法使用，请明确说明原因。`,
  );
  await page.getByTestId("composer-send").click();

  const turn = page.getByTestId("turn-assistant").last();
  await expect(turn).toBeVisible({ timeout: 30_000 });
  await expect(turn).toHaveAttribute("data-streaming", "false", { timeout: 120_000 });
  const text = (await turn.textContent()) || "";
  // Honest decline: names the limitation and points at switching — never a
  // fabricated tool result.
  expect(text, `assistant said: ${text}`).toMatch(/未启用|未对|无法|不能|不可用|切换|聚焦|standard/i);
});
