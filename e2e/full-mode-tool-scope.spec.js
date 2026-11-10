// ── Full-mode tool scope e2e (full-mode-tool-scope 4.3) ─────────────────────
//
// Runs against the dedicated FULL_MODE_TOOL_SCOPE=on server
// (playwright.full-mode.config.js). File-level truth at the same seam the
// pack-agent-scoping suite uses: tool-filter.json is what the child's preset
// bridge consumes.
//
//   E2E_PORT=3110 npx playwright test --config=playwright.full-mode.config.js

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { tempStoreDirs, waitForIdle } from "./helpers.js";

const dirs = tempStoreDirs();
const SERVER = "e2e-registry-mcp";
// The roster form of a catalog preset id (dsh-profile.rosterPresetId): dots and
// other non-alphanumerics fold to dashes, so `user.preset` → `user-preset`.
const rosterId = (catalogId) => String(catalogId).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
const patchPath = (file) => path.join(dirs.dshHome, "profiles", "platform", file);
const toolFilterOf = () => {
  try {
    return JSON.parse(fs.readFileSync(patchPath("tool-filter.json"), "utf8"));
  } catch {
    return { mcpTools: {} };
  }
};

// Raw-WS preset switch; resolves on the server's current_preset confirmation.
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

function manifestFor(packId, agentId, refs) {
  return {
    name: `全模式-${packId}`,
    description: "full-mode tool scope e2e",
    tags: [],
    skills: [{ name: `${packId}-skill`, description: "技能", content: "# c" }],
    mcpServers: refs,
    agents: [{ id: agentId, name: "角色", persona: "你是角色。" }],
  };
}

async function installPack(page, packId, agentId, refs) {
  const r = await page.request.post("/api/mypacks/install", {
    data: { packId, version: 1, manifest: manifestFor(packId, agentId, refs) },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}

test.describe.configure({ mode: "serial" });

let presetId = null;

test.beforeEach(async ({ page }) => {
  await page.goto("/chat/");
  const connect = await page.request.post("/api/registry/credential", {
    data: { token: "opaque-e2e-token", source: "paste" },
  });
  expect(connect.ok()).toBeTruthy();
});

test.afterEach(async ({ page }) => {
  await waitForIdle(page, 5000).catch(() => {});
  await switchPreset(page, "standard").catch(() => {});
  await page.request.put("/api/mcp-tool-scope", { data: { fullSurface: [] } }).catch(() => {});
  for (const id of ["fm-a", "fm-b", "fm-c"]) {
    await page.request.delete(`/api/mypacks/${id}?force=1`).catch(() => {});
  }
  if (presetId) await page.request.delete(`/api/agent/presets/${presetId}`).catch(() => {});
  presetId = null;
  await page.request.delete(`/api/extensions/mcp/${SERVER}`).catch(() => {});
});

test("full mode composes the union of installed packs' declarations", async ({ page }) => {
  test.setTimeout(150_000);
  await installPack(page, "fm-a", "fm-agent-a", [{ registryName: SERVER, allowTools: ["read", "search"] }]);
  await installPack(page, "fm-b", "fm-agent-b", [{ registryName: SERVER, allowTools: ["search", "write"] }]);

  // The second install reuses the already-mounted server, so it need not fire
  // a patch rewrite. Force one composition with BOTH packs installed: into a
  // pack persona and back to the full mode.
  await waitPresetInRoster(page, "fm-agent-b");
  await switchPreset(page, "fm-agent-b");
  await switchPreset(page, "standard");

  await expect
    .poll(() => [...(toolFilterOf().mcpTools[SERVER] ?? [])].sort(), { timeout: 30_000 })
    .toEqual(["read", "search", "write"]);
});

test("the per-server override lifts the filter after recomposition", async ({ page }) => {
  test.setTimeout(150_000);
  await installPack(page, "fm-c", "fm-agent-c", [{ registryName: SERVER, allowTools: ["read"] }]);
  await expect.poll(() => toolFilterOf().mcpTools[SERVER] ?? [], { timeout: 30_000 }).toEqual(["read"]);

  const put = await page.request.put("/api/mcp-tool-scope", { data: { fullSurface: [SERVER] } });
  expect(put.ok()).toBeTruthy();

  // Recomposition: into the pack persona and back to the full mode.
  await waitPresetInRoster(page, "fm-agent-c");
  await switchPreset(page, "fm-agent-c");
  await switchPreset(page, "standard");
  await expect.poll(() => toolFilterOf().mcpTools[SERVER], { timeout: 30_000 }).toBeUndefined();
});

test("a custom preset narrows to its declared tools", async ({ page }) => {
  test.setTimeout(150_000);
  await installPack(page, "fm-a", "fm-agent-a", [{ registryName: SERVER, allowTools: ["read", "search"] }]);

  const r = await page.request.post("/api/agent/presets", {
    data: {
      name: "全模式预设",
      persona: "你是预设。",
      skills: [],
      mcpServers: [SERVER],
      mcpTools: { [SERVER]: ["read"] },
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  presetId = (await r.json()).preset.id;

  await waitPresetInRoster(page, rosterId(presetId));
  await switchPreset(page, rosterId(presetId));
  await expect.poll(() => toolFilterOf().mcpTools[SERVER] ?? [], { timeout: 30_000 }).toEqual(["read"]);
});
