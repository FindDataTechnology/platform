// ── Skill packages e2e (add-packaged-skills, task 6.1) ───────────────────────
//
// The full chain against the real cell: zip upload (Settings → Skills) with
// inventory preview + script acknowledgment → row + materialized directory
// tree → pack editor direct-upload seed → draft persistence → publish →
// market detail (file inventory projection) → subscribe with the one-time
// script confirm dialog → install report disclosure → the pack root's
// materialized tree.
//
// Honest scope note: the hermetic suite fakes the LLM, so "a real
// conversation resolving references/*.md" cannot run here — the runtime
// contract it depends on (the tree landing exactly where the skill
// filesystem provider takes its resource base) IS asserted on disk, the
// 刀二 precedent for this shape. The market plane is the same stateful
// browser stand-in packs.spec.js uses (its detail handler mirrors the real
// gateway's files-to-inventory projection); the server-side install fetch is
// the real facet-stub channel.

import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import {
  gotoSkills,
  pinLocaleEn,
  resetFacetStub,
  seedFacetPack,
  tempStoreDirs,
} from "./helpers.js";

const RUN = Date.now().toString(36);
// Two distinct skills: the settings upload becomes a USER skill; the pack
// must own its own (a same-named user row would collide and skip at install).
const USER_SKILL = `routing-user-${RUN}`;
const PACK_SKILL = `routing-pack-${RUN}`;
const PACK_NAME = `Packaged ${RUN}`;

// The package under test: body references the tree; a script triggers the
// confirm gates; a binary proves honest omission. `skillName` becomes the
// frontmatter name (normalized server-side into the platform grammar).
function packageFiles(skillName) {
  return {
    "SKILL.md": `---\nname: ${skillName}\nwhenToUse: 路线规划时\n---\n# 路线专家\n手册见 references/routing.md；打招呼用 scripts/hello.py。\n`,
    "references/routing.md": "# 路线手册\n北线优先。\n",
    "scripts/hello.py": "print('hello from packaged skill')\n",
    "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  };
}

async function buildZip(files) {
  const zip = new JSZip();
  for (const [p, content] of Object.entries(files)) zip.file(p, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

// The stateful market stand-in (packs.spec.js's shape, minimal routes) with
// the DETAIL projection the real gateway now applies: files → sorted path
// inventory (contents never ride the detail payload).
function installGatewayMock(page) {
  const state = { packs: [] };
  const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  const summary = (p) => ({
    id: p.id,
    authorEmail: p.authorEmail,
    createdAt: p.createdAt,
    version: p.version,
    name: p.manifest.name,
    description: p.manifest.description || "",
    tags: p.manifest.tags || [],
    publishedAt: p.publishedAt,
  });
  const projectManifest = (manifest) => ({
    ...manifest,
    skills: (manifest.skills ?? []).map((s) =>
      s?.files && typeof s.files === "object" && !Array.isArray(s.files)
        ? { ...s, files: Object.keys(s.files).sort() }
        : s,
    ),
  });

  page.route("**/api/packs**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();

    if (method === "GET" && p === "/api/packs") {
      const packs = state.packs.map(summary);
      return route.fulfill(json({ total: packs.length, page: 1, pageSize: 50, packs }));
    }
    if (method === "POST" && p === "/api/packs") {
      const body = req.postDataJSON();
      if (body.packId) {
        const pack = state.packs.find((x) => x.id === body.packId);
        pack.version += 1;
        pack.manifest = body.manifest;
        return route.fulfill(json({ id: pack.id, version: pack.version }));
      }
      const id = `pack-pkg-${state.packs.length + 1}`;
      const publishedAt = Date.now();
      state.packs.push({
        id, authorEmail: "creator@e2e.test", createdAt: publishedAt, publishedAt, version: 1,
        manifest: body.manifest,
        versionHistory: [{ version: 1, publishedAt, manifest: body.manifest }],
      });
      return route.fulfill(json({ id, version: 1 }));
    }
    const detail = p.match(/^\/api\/packs\/([^/]+)$/);
    if (method === "GET" && detail) {
      const pack = state.packs.find((x) => x.id === detail[1]);
      if (!pack) return route.fulfill(json({ error: "Pack not found" }, 404));
      return route.fulfill(json({ ...summary(pack), manifest: projectManifest(pack.manifest) }));
    }
    const versionDoc = p.match(/^\/api\/packs\/([^/]+)\/versions\/(\d+)$/);
    if (method === "GET" && versionDoc) {
      const pack = state.packs.find((x) => x.id === versionDoc[1]);
      // The version read is the install channel: FULL manifest, files intact.
      return route.fulfill(json({ id: pack.id, version: Number(versionDoc[2]), manifest: pack.manifest }));
    }
    const sub = p.match(/^\/api\/packs\/([^/]+)\/subscribe$/);
    if (method === "POST" && sub) {
      const pack = state.packs.find((x) => x.id === sub[1]);
      return route.fulfill(json({ packId: pack.id, version: pack.version }));
    }
    return route.fulfill(json({ error: "unmocked gateway path" }, 500));
  });
  return state;
}

const storeRoot = () => tempStoreDirs().root;
const userSkillDir = () => path.join(storeRoot(), "custom-skills", USER_SKILL);
const packSkillDir = (packId) => path.join(storeRoot(), "custom-skills", "packs", packId, PACK_SKILL);

async function gotoPacksTab(page, tab) {
  await pinLocaleEn(page);
  await page.goto("/agents?tab=market");
  await expect(page.getByTestId("packs-page")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`packs-tab-${tab}`).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("platform.locale", "en"));
  await resetFacetStub();
});

test("zip upload → preview → install → materialized tree; editor seed → draft → publish → subscribe (confirm) → pack tree", async ({ page }) => {
  const gw = installGatewayMock(page);
  const userZip = await buildZip(packageFiles(USER_SKILL));
  const packZip = await buildZip(packageFiles(PACK_SKILL));

  // ── Leg 1: Settings → Skills → upload the package ─────────────────────────
  await gotoSkills(page);
  await page.getByTestId("upload-skill-package-btn").click();
  await expect(page.getByTestId("skill-package-dialog")).toBeVisible();
  await page.getByTestId("skill-package-file-input").setInputFiles({
    name: "routing-user.zip",
    mimeType: "application/zip",
    buffer: userZip,
  });

  // Preview: the honest inventory — both text files, the script flagged by
  // the warning, the binary marked omitted, name normalized from frontmatter.
  await expect(page.getByTestId("skill-package-files")).toContainText("references/routing.md", { timeout: 10_000 });
  await expect(page.getByTestId("skill-package-files")).toContainText("scripts/hello.py");
  await expect(page.getByTestId("skill-package-files")).toContainText("logo.png");
  await expect(page.getByTestId("skill-package-files")).toContainText(/binary, not stored/i);
  await expect(page.getByTestId("skill-package-ack-scripts")).toBeVisible();

  await page.getByTestId("skill-package-ack-scripts").check();
  await page.getByTestId("skill-package-install").click();
  await expect(page.getByTestId("skill-package-success")).toContainText(USER_SKILL, { timeout: 10_000 });

  // The installed list shows the file-count badge (2 stored files).
  await expect(page.locator(`[data-testid="skill-card"][data-skill-name="${USER_SKILL}"]`)).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator(`[data-testid="skill-card"][data-skill-name="${USER_SKILL}"]`).getByTestId("skill-file-count"),
  ).toHaveText(/2 files/i);

  // The row exposes the file paths (the read projection's contract).
  const rows = await (await page.request.get("/api/extensions/skills")).json();
  const row = rows.skills.find((s) => s.name === USER_SKILL);
  expect(row.files, "row carries the path inventory").toEqual(
    expect.arrayContaining(["references/routing.md", "scripts/hello.py"]),
  );

  // The tree landed where the runtime's filesystem provider takes its base.
  expect(readFileSync(path.join(userSkillDir(), "SKILL.md"), "utf8")).toContain("whenToUse: 路线规划时");
  expect(readFileSync(path.join(userSkillDir(), "references", "routing.md"), "utf8")).toBe(packageFiles(USER_SKILL)["references/routing.md"]);
  expect(readFileSync(path.join(userSkillDir(), "scripts", "hello.py"), "utf8")).toBe(packageFiles(USER_SKILL)["scripts/hello.py"]);
  expect(existsSync(path.join(userSkillDir(), "logo.png")), "binary never lands on disk").toBe(false);

  // ── Leg 2: pack editor direct-upload seed → draft → publish ───────────────
  await gotoPacksTab(page, "drafts");
  await page.getByTestId("pack-draft-create").click();
  await expect(page.getByTestId("pack-editor")).toBeVisible();
  await page.locator("#pack-name").fill(PACK_NAME);
  await page.getByTestId("pack-skill-upload-input").setInputFiles({
    name: "routing-pack.zip",
    mimeType: "application/zip",
    buffer: packZip,
  });
  // The seeded entry names its full platform name and discloses the files.
  await expect(page.locator('[data-testid^="pack-skill-entry-0"]').locator("input").first()).toHaveValue(PACK_SKILL, { timeout: 10_000 });
  await expect(page.getByTestId("pack-skill-files-0")).toContainText("2 auxiliary files");
  // The manifest requires a non-empty description — the author fills it.
  await page.getByTestId("pack-skill-entry-0").locator("input").nth(1).fill("路线规划专家（多文件技能包）");

  await page.getByTestId("pack-agent-add").click();
  await page.getByTestId("pack-agent-entry-0").locator("input").nth(0).fill(`pkg-guide-${RUN}`);
  await page.getByTestId("pack-agent-entry-0").locator("input").nth(1).fill("向导");
  await page.getByTestId("pack-agent-entry-0").locator("textarea").fill("你是向导。");

  // Draft persistence: save, leave, reopen — the tree survives.
  await page.getByRole("button", { name: /save draft/i }).click();
  await page.getByRole("button", { name: /^close$/i }).click();
  await page.locator('[data-testid^="pack-draft-item-"]').first().click();
  await expect(page.getByTestId("pack-editor")).toBeVisible();
  await expect(page.getByTestId("pack-skill-files-0")).toContainText("2 auxiliary files");

  await page.getByTestId("pack-draft-publish").click();
  // Publishing auto-switches to the market; the mock store fills
  // asynchronously — poll the state, then assert the card.
  await expect.poll(() => gw.packs.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const published = gw.packs[gw.packs.length - 1];
  await expect(page.getByTestId(`pack-card-${published.id}`)).toContainText(PACK_NAME, { timeout: 15_000 });
  expect(published.manifest.skills[0].files["scripts/hello.py"]).toBe(packageFiles(PACK_SKILL)["scripts/hello.py"]);
  // The server-side install channel must serve the SAME full manifest.
  await seedFacetPack(published.id, published.version, published.manifest);

  // ── Leg 3: market detail (inventory projection) → subscribe → confirm ─────
  await gotoPacksTab(page, "market");
  await page.getByTestId(`pack-card-${published.id}`).click();
  await expect(page.getByTestId("pack-detail")).toBeVisible();
  // The detail lists the file inventory (paths, not contents).
  await expect(page.getByTestId(`pack-skill-files-${PACK_SKILL}`)).toContainText("references/routing.md");
  await expect(page.getByTestId(`pack-skill-files-${PACK_SKILL}`)).not.toContainText("北线优先");

  // Subscribe: the server refuses the script-bearing pack; the one-time
  // confirm dialog names the scripts; confirming retries with confirm=true.
  await page.getByTestId("pack-subscribe").click();
  const gate = page.getByTestId("pack-script-confirm");
  await expect(gate).toBeVisible({ timeout: 10_000 });
  await expect(gate).toContainText("scripts/hello.py");
  await page.getByTestId("pack-script-confirm-ok").click();

  // The report discloses fileCount + scriptFiles on the skill row.
  await expect(page.getByTestId("pack-install-report")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`pack-report-files-${PACK_SKILL}`)).toContainText(/2 auxiliary files/i);
  await expect(page.getByTestId(`pack-report-files-${PACK_SKILL}`)).toContainText("scripts/hello.py");

  // The pack-owned tree materialized under the pack root.
  const dir = packSkillDir(published.id);
  expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain("whenToUse: 路线规划时");
  expect(readFileSync(path.join(dir, "references", "routing.md"), "utf8")).toBe(packageFiles(PACK_SKILL)["references/routing.md"]);
  expect(readFileSync(path.join(dir, "scripts", "hello.py"), "utf8")).toBe(packageFiles(PACK_SKILL)["scripts/hello.py"]);
});
