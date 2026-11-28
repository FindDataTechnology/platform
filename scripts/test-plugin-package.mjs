// Unit tests — pack projection → Agent Plugins 1.0 package
// (openspec: add-pack-raven-export).
// Run: node --test scripts/test-plugin-package.mjs
//
// The exporter is the FOURTH envelope of server/pack-projection.js, so the tests
// enter where the other envelopes' tests enter: boundary → IR → envelope. A test
// that skipped the IR would be asserting a path no caller uses.
//
// The two cases that carry the most weight:
//   · two runs are byte-identical (determinism is the whole point of a
//     projection — otherwise "exported from the same pack" stops being a claim);
//   · the self-check goes red on each kind of damage (a green checker that
//     cannot fail is decoration).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  droppedSections,
  projectManifestToIR,
  toAgentPluginsPackage,
  toDshBundle,
  validateProjectionBoundary,
} from "../server/pack-projection.js";
import { resolvePackId } from "../lib/pack-identity.js";
import { writePluginPackage } from "../server/plugin-package-write.js";
import { zipPluginPackage } from "../server/offline-bundle.js";

const PKG_ROOT = path.resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(path.join(tmpdir(), "plugin-package-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const scratch = () => path.join(tmp, `case-${++seq}`);

function manifest(overrides = {}) {
  return {
    name: "CRM Desk Suite",
    description: "客服台套件",
    version: 3,
    skills: [
      { name: "crm-desk-reception", description: "前台接待", content: "# 接待\n\n按顺序问三件事。" },
      { name: "crm-desk-merchant", description: "商户对接", content: "# 商户" },
    ],
    mcpServers: [
      { registryName: "wire-build-mcp", fullSurface: true, fullSurfaceReason: "需要全工具面" },
    ],
    agents: [
      { id: "desk", name: "前台", persona: "你是前台。" },
      { id: "clerk", name: "文员", persona: "你是文员。" },
    ],
    ...overrides,
  };
}

/** The three steps every caller takes. */
function exportPackage(subject = manifest(), options = {}) {
  const boundary = validateProjectionBoundary(subject);
  assert.deepEqual(boundary, [], "boundary refused the fixture");
  return toAgentPluginsPackage(projectManifestToIR(subject), {
    dropped: droppedSections(subject),
    ...options,
  });
}

function filesToDisk(files, dir) {
  for (const [rel, value] of Object.entries(files)) {
    const destination = path.join(dir, rel);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, value, "utf8");
  }
  return dir;
}

function runCheck(dir) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(PKG_ROOT, "scripts/check-plugin-package.mjs"), dir],
      { encoding: "utf8" },
    );
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// ── 产物形状 ─────────────────────────────────────────────────────────────

test("skill content lands byte-for-byte in its own directory", () => {
  const { files } = exportPackage();
  // The IR normalises trailing whitespace/newlines, so the assertion is made
  // against the IR's own value rather than the fixture's literal.
  const ir = projectManifestToIR(manifest());
  const expected = ir.skills.find((s) => s.name === "crm-desk-reception").content;
  assert.equal(files["skills/crm-desk-reception/SKILL.md"].includes(expected.trim()), true);
});

test("plugin.json declares skills as a path, not as an inline array", () => {
  // Measured against the one manifest schema in this workspace (.zcode-plugin),
  // and the .claude-plugin form it mirrors: `"skills": "./skills"`. An inline array
  // is rejected by a schema-validated loader, and no test here could see that.
  const plugin = JSON.parse(exportPackage().files["plugin.json"]);
  assert.equal(plugin.skills, "./skills");
  assert.ok(Array.isArray(plugin["x-finddata"].skills), "the inventory must still be readable");
});

test("plugin.json points at mcp.json instead of relying on a bare filename", () => {
  const plugin = JSON.parse(exportPackage().files["plugin.json"]);
  assert.equal(plugin.mcpServers, "./mcp.json");
});

test("a package with no MCP references declares neither the pointer nor the file", () => {
  const built = exportPackage(manifest({ mcpServers: [] }));
  const plugin = JSON.parse(built.files["plugin.json"]);
  assert.equal(plugin.mcpServers, undefined);
  assert.equal("mcp.json" in built.files, false);
  assert.equal(runCheck(filesToDisk(built.files, scratch())).code, 0);
});

test("a pointer without its file is a violation, and so is an undeclared file", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  rmSync(path.join(dir, "mcp.json"));
  const missing = runCheck(dir);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /points at '\.\/mcp\.json' but the file is absent/);

  const other = filesToDisk(exportPackage(manifest({ mcpServers: [] })).files, scratch());
  writeFileSync(path.join(other, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2));
  const stray = runCheck(other);
  assert.equal(stray.code, 1);
  assert.match(stray.stdout, /does not declare mcpServers/);
});

test("the package carries plugin.json, mcp.json and the not-projected note", () => {
  const { files } = exportPackage();
  for (const required of ["plugin.json", "mcp.json", "NOT-PROJECTED.md"]) {
    assert.ok(required in files, `${required} missing`);
  }
});

test("a manifest with no skills still produces a valid package", () => {
  const { files } = exportPackage(manifest({ skills: [] }));
  assert.ok("plugin.json" in files);
  assert.ok("mcp.json" in files);
  assert.equal(Object.keys(files).filter((p) => p.startsWith("skills/")).length, 0);
  assert.equal(runCheck(filesToDisk(files, scratch())).code, 0);
});

test("skill auxiliary files ride along under the skill's directory", () => {
  const built = exportPackage(
    manifest({
      skills: [
        {
          name: "with-aux",
          description: "带附件",
          content: "# 主文件",
          files: { "references/notes.md": "# 笔记" },
        },
      ],
    }),
  );
  const keys = Object.keys(built.files);
  assert.ok(keys.includes("skills/with-aux/references/notes.md"), keys.join(", "));
});

// ── 确定性 ───────────────────────────────────────────────────────────────

test("two runs over the same manifest are byte-identical", () => {
  const a = exportPackage();
  const b = exportPackage();
  assert.deepEqual(Object.keys(a.files), Object.keys(b.files), "file sets differ");
  for (const [key, value] of Object.entries(a.files)) assert.equal(b.files[key], value, `${key} differs`);
});

test("the package carries no timestamp, host or absolute path", () => {
  const { files } = exportPackage();
  const year = String(new Date().getFullYear());
  for (const [key, value] of Object.entries(files)) {
    assert.ok(!value.includes(year), `${key} carries the current year`);
    assert.ok(!value.includes(PKG_ROOT), `${key} carries an absolute path`);
    assert.ok(!/\r\n/.test(value), `${key} uses CRLF`);
  }
});

test("the same manifest in another working directory produces the same bytes", () => {
  const before = process.cwd();
  const a = exportPackage();
  process.chdir(tmpdir());
  try {
    const b = exportPackage();
    for (const [key, value] of Object.entries(a.files)) assert.equal(b.files[key], value);
  } finally {
    process.chdir(before);
  }
});

test("the IR sorts skills and mcp refs, so authored order cannot leak", () => {
  const reversed = manifest();
  reversed.skills = [...reversed.skills].reverse();
  reversed.mcpServers = [
    { registryName: "zeta", fullSurface: true, fullSurfaceReason: "全" },
    { registryName: "alpha", fullSurface: true, fullSurfaceReason: "全" },
  ];
  const straight = manifest();
  straight.mcpServers = [
    { registryName: "alpha", fullSurface: true, fullSurfaceReason: "全" },
    { registryName: "zeta", fullSurface: true, fullSurfaceReason: "全" },
  ];
  const a = exportPackage(reversed);
  const b = exportPackage(straight);
  assert.deepEqual(Object.keys(JSON.parse(a.files["mcp.json"]).mcpServers), ["crm-desk-suite__alpha", "crm-desk-suite__zeta"]);
  assert.equal(a.files["plugin.json"], b.files["plugin.json"], "authored order changed the bytes");
});

// ── MCP 命名 ─────────────────────────────────────────────────────────────

test("mcp server names are prefixed with the normalized package name", () => {
  const { files } = exportPackage();
  const mcp = JSON.parse(files["mcp.json"]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["crm-desk-suite__wire-build-mcp"]);
});

test("the reverse mapping survives a registryName that itself contains '__'", () => {
  const built = exportPackage(
    manifest({ mcpServers: [{ registryName: "acme__tools", fullSurface: true, fullSurfaceReason: "全" }] }),
  );
  const mcp = JSON.parse(built.files["mcp.json"]);
  const [name] = Object.keys(mcp.mcpServers);
  const recorded = JSON.parse(built.files["plugin.json"])["x-finddata"].mcpServers[0];
  assert.equal(name, "crm-desk-suite__acme__tools");
  assert.equal(recorded.registryName, "acme__tools");
  // Structural, not string-splitting: `__` may appear inside the original.
  assert.equal(name.slice(name.indexOf("__") + 2), recorded.registryName);
});

// ── 包身份 ───────────────────────────────────────────────────────────────
//
// Every fixture above has an ASCII name, which is exactly the blind spot: a name
// like "CRM Desk Suite" slugs to "crm-desk-suite", so a local fallback literal
// (the code used to be `slugFromName(name) || "pack"`) never fired in tests while
// every real official pack — 柏讯助手, 萬星机群助手, 谦面助手 — exported as "pack".

test("a CJK-only name resolves to draft-pack, not a literal", () => {
  const built = exportPackage(
    manifest({
      name: "柏讯助手",
      mcpServers: [{ registryName: "wire-build-mcp", fullSurface: true, fullSurfaceReason: "全" }],
    }),
  );
  const plugin = JSON.parse(built.files["plugin.json"]);
  assert.equal(built.packageName, "draft-pack");
  assert.equal(plugin.name, "draft-pack");
  assert.equal(plugin["x-finddata"].packageName, "draft-pack");
  assert.deepEqual(Object.keys(JSON.parse(built.files["mcp.json"]).mcpServers), [
    "draft-pack__wire-build-mcp",
  ]);
});

test("an explicit packId wins over the derived one, in both envelopes", () => {
  const subject = manifest({ name: "柏讯助手" });
  const ir = projectManifestToIR(subject);
  const plugin = toAgentPluginsPackage(ir, {
    dropped: droppedSections(subject),
    packId: "wire-assistant",
  });
  assert.equal(plugin.packageName, "wire-assistant");
  assert.equal(JSON.parse(plugin.files["plugin.json"]).name, "wire-assistant");

  const bundle = toDshBundle(ir, { packId: "wire-assistant" });
  assert.equal(bundle.packageJson.name, "@pack/wire-assistant");
  assert.deepEqual(bundle.packageJson.dsh.profile.bundles, ["@pack/wire-assistant"]);
});

test("the dsh envelope derives from the same rule, so neither can drift", () => {
  // Same CJK name, no explicit id: the two envelopes must agree with each other
  // AND with the platform. Before this fix each carried its own `|| "pack"`.
  const subject = manifest({ name: "萬星机群助手" });
  const ir = projectManifestToIR(subject);
  const bundle = toDshBundle(ir);
  const plugin = toAgentPluginsPackage(ir, { dropped: droppedSections(subject) });
  assert.equal(bundle.packageJson.name, "@pack/draft-pack");
  assert.equal(plugin.packageName, "draft-pack");
  assert.equal(resolvePackId(subject.name), "draft-pack");
  // And an ASCII name is unchanged by the fix: `crm-desk-suite`, as before.
  assert.equal(resolvePackId("CRM Desk Suite"), "crm-desk-suite");
});

test("the offline entry's --pack-id reaches plugin.json", () => {
  const dir = scratch();
  const manifestPath = path.join(dir, "manifest.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest({ name: "柏讯助手" })), "utf8");
  const out = path.join(dir, "out");
  execFileSync(
    process.execPath,
    [
      path.join(PKG_ROOT, "scripts/export-plugin-package.mjs"),
      manifestPath,
      out,
      "--pack-id",
      "wire-assistant",
    ],
    { encoding: "utf8" },
  );
  assert.equal(JSON.parse(readFileSync(path.join(out, "plugin.json"), "utf8")).name, "wire-assistant");
});

// ── 不投影层 ─────────────────────────────────────────────────────────────

test("the persona layer is declared not-projected in both places", () => {
  const { files, notProjected } = exportPackage();
  assert.ok(notProjected.some((entry) => entry.field === "personas"));
  const meta = JSON.parse(files["plugin.json"])["x-finddata"].notProjected;
  assert.ok(meta.some((entry) => entry.field === "personas"), "plugin.json does not declare personas");
  const note = files["NOT-PROJECTED.md"];
  assert.match(note, /personas/);
  assert.match(note, /不投影/);
  assert.match(note, /2 个角色/);
});

test("a manifest with no roles says so instead of staying silent", () => {
  const { files } = exportPackage(manifest({ agents: [] }));
  assert.match(files["NOT-PROJECTED.md"], /没有声明角色/);
});

test("personas never reach the skill inventory", () => {
  const { files } = exportPackage();
  const plugin = JSON.parse(files["plugin.json"]);
  for (const skill of plugin["x-finddata"].skills) {
    assert.ok(!["desk", "clerk"].includes(skill.name), `persona '${skill.name}' leaked into skills`);
  }
  assert.ok(!Object.keys(files).some((p) => p.startsWith("presets/")), "a preset file was written");
});

// ── 同一份边界 ───────────────────────────────────────────────────────────

test("the boundary refuses orchestration sections before the envelope runs", () => {
  const boundary = validateProjectionBoundary(manifest({ fleet: { template: "x" } }));
  assert.deepEqual(boundary.map((e) => e.code), ["projection_forbidden_section"]);
});

test("a hidden endpoint in the manifest is refused, not exported", () => {
  const boundary = validateProjectionBoundary(
    manifest({ mcpServers: [{ registryName: "crm", baseUrl: "https://example.invalid" }] }),
  );
  assert.ok(boundary.length > 0, "an endpoint key must be refused");
});

test("a skill directory collision fails and names both skills", () => {
  const subject = manifest({
    skills: [
      { name: "Desk", description: "a", content: "# a" },
      { name: "desk", description: "b", content: "# b" },
    ],
  });
  const ir = projectManifestToIR(subject);
  assert.throws(() => toAgentPluginsPackage(ir), (err) => {
    assert.equal(err.code, "projection_skill_dir_collision");
    assert.match(err.message, /Desk/);
    assert.match(err.message, /'desk'/);
    return true;
  });
});

// ── 容器层确定性 ─────────────────────────────────────────────────────────
//
// The Map comparison above proves the generator is deterministic. This proves the
// ARTIFACT is: JSZip stamps every entry with the current time unless told
// otherwise, so an identical file set can still produce different bytes.

test("two zips over the same files are byte-identical", async () => {
  const { files } = exportPackage();
  const a = await zipPluginPackage(files, { packId: "crm-desk-suite", version: 3 });
  const b = await zipPluginPackage(files, { packId: "crm-desk-suite", version: 3 });
  assert.equal(Buffer.from(a).toString("base64"), Buffer.from(b).toString("base64"));
});

test("the zip carries every package file and nothing else", async () => {
  const JSZip = (await import("jszip")).default;
  const { files } = exportPackage();
  const buffer = await zipPluginPackage(files, { packId: "p", version: 1 });
  const zip = await JSZip.loadAsync(Buffer.from(buffer));
  const entries = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
  assert.deepEqual(entries, Object.keys(files).sort());
});

// ── 落盘：不产生半成品 ───────────────────────────────────────────────────

test("write refuses a non-empty target instead of merging two exports", async () => {
  const dir = scratch();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "leftover.txt"), "x");
  const { files } = exportPackage();
  await assert.rejects(() => writePluginPackage(files, dir), /not empty/);
});

test("write accepts the envelope's Record and produces a self-checking package", async () => {
  const dir = scratch();
  mkdirSync(dir, { recursive: true });
  const { files } = exportPackage();
  await writePluginPackage(files, dir);
  assert.equal(runCheck(dir).code, 0);
  assert.deepEqual(readdirSync(dir).sort(), ["NOT-PROJECTED.md", "mcp.json", "plugin.json", "skills"]);
});

test("a failed write leaves no partial package behind", async () => {
  const dir = scratch();
  const { files } = exportPackage();
  const poisoned = { ...files, "../escape.txt": "nope" };
  await assert.rejects(() => writePluginPackage(poisoned, dir), /outside the package root/);
  assert.equal(readdirSync(tmp).includes(path.basename(dir)), false, "a partial target was left behind");
});

// ── 自检能红 ─────────────────────────────────────────────────────────────

test("the self-check passes on a freshly exported package", () => {
  const result = runCheck(filesToDisk(exportPackage().files, scratch()));
  assert.equal(result.code, 0, result.stdout);
});

test("the self-check goes red when a declared skill file is missing", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  rmSync(path.join(dir, "skills/crm-desk-merchant/SKILL.md"));
  const result = runCheck(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /crm-desk-merchant.*missing on disk/s);
});

test("the self-check goes red when a directory disagrees with plugin.json", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  mkdirSync(path.join(dir, "skills/renamed"));
  writeFileSync(path.join(dir, "skills/renamed/SKILL.md"), "# renamed\n");
  const result = runCheck(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /skills\/renamed\/SKILL\.md: on disk but not declared/);
});

test("a script under a skill is an asset: kept, disclosed, and the package still passes", () => {
  const subject = manifest({
    skills: [
      {
        name: "with-script",
        description: "带脚本",
        content: "# 主文件",
        files: { "scripts/run.sh": "#!/bin/sh\necho hi\n" },
      },
    ],
  });
  const built = exportPackage(subject);
  assert.ok("skills/with-script/scripts/run.sh" in built.files, "the asset was dropped");
  assert.deepEqual(JSON.parse(built.files["plugin.json"])["x-finddata"].scriptFiles, [
    "skills/with-script/scripts/run.sh",
  ]);
  assert.equal(runCheck(filesToDisk(built.files, scratch())).code, 0);
});

test("an undisclosed skill script is a violation", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  writeFileSync(path.join(dir, "skills/crm-desk-merchant/run.sh"), "echo hi\n");
  const result = runCheck(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /script asset not disclosed/);
});

test("a disclosure that names a missing file is a violation", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  const plugin = JSON.parse(readFileSync(path.join(dir, "plugin.json"), "utf8"));
  plugin["x-finddata"].scriptFiles = ["skills/crm-desk-merchant/gone.sh"];
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(plugin, null, 2));
  const result = runCheck(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /is listed but not present/);
});

test("a package-level script is still refused", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  writeFileSync(path.join(dir, "index.js"), "export default {};\n");
  const result = runCheck(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /executable entry .* outside skills\//);
});

test("sections the IR drops are reported, not silently shipped", () => {
  const built = exportPackage(manifest({ bots: [{ id: "b", name: "B" }] }));
  const meta = JSON.parse(built.files["plugin.json"])["x-finddata"].notProjected;
  assert.ok(meta.some((entry) => entry.field === "bots"), "a dropped section went unreported");
  assert.match(built.files["NOT-PROJECTED.md"], /bots/);
});

test("the self-check goes red on an executable bit alone", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  chmodSync(path.join(dir, "NOT-PROJECTED.md"), 0o755);
  const result = runCheck(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /executable bit/);
});

test("the self-check goes red when mcp.json loses the package prefix", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  writeFileSync(
    path.join(dir, "mcp.json"),
    JSON.stringify({ mcpServers: { "wire-build-mcp": { registryName: "wire-build-mcp" } } }, null, 2),
  );
  const result = runCheck(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /not '<package>__<registryName>'/);
});

// 2026-11-15: the prefix was only pinned at its SUFFIX (`__<registryName>`), so a
// package could rename every key to another pack's id and still pass — measured on
// a real export (wire-assistant's keys rewritten to `totally-other-pack__*`: `ok`).
// The prefix is half of the naming rule, so it has to be judged too.
test("the self-check goes red when the prefix names a different package", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  const mcp = JSON.parse(readFileSync(path.join(dir, "mcp.json"), "utf8"));
  const renamed = {};
  for (const [key, entry] of Object.entries(mcp.mcpServers)) {
    renamed[key.replace(/^crm-desk-suite__/, "another-pack__")] = entry;
  }
  writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: renamed }, null, 2));
  const result = runCheck(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /prefixed with another package's id/);
});

test("the self-check goes red when the artifact names itself twice and disagrees", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  const plugin = JSON.parse(readFileSync(path.join(dir, "plugin.json"), "utf8"));
  plugin["x-finddata"].packageName = "draft-pack";
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(plugin, null, 2));
  const result = runCheck(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /disagrees with plugin\.json name/);
});

test("the self-check goes red when the not-projected note is missing", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  rmSync(path.join(dir, "NOT-PROJECTED.md"));
  const result = runCheck(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /NOT-PROJECTED\.md: missing/);
});

test("the self-check goes red when the note omits a field plugin.json claims", () => {
  const dir = filesToDisk(exportPackage().files, scratch());
  writeFileSync(path.join(dir, "NOT-PROJECTED.md"), "# nothing dropped\n");
  const result = runCheck(dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /does not mention 'personas'/);
});

// ── 离线入口 ─────────────────────────────────────────────────────────────

test("the offline entry produces the same bytes as the IR pipeline", () => {
  const manifestPath = `${scratch()}.json`;
  const dir = scratch();
  const subject = manifest();
  writeFileSync(manifestPath, JSON.stringify(subject, null, 2));
  execFileSync(
    process.execPath,
    [path.join(PKG_ROOT, "scripts/export-plugin-package.mjs"), manifestPath, dir],
    { encoding: "utf8" },
  );
  const built = exportPackage(subject);
  for (const [rel, value] of Object.entries(built.files)) {
    assert.equal(readFileSync(path.join(dir, rel), "utf8"), value, `${rel} differs on disk`);
  }
});

test("the offline entry refuses a manifest outside the boundary and writes nothing", () => {
  const manifestPath = `${scratch()}.json`;
  const dir = scratch();
  writeFileSync(manifestPath, JSON.stringify(manifest({ fleet: { template: "x" } })));
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [path.join(PKG_ROOT, "scripts/export-plugin-package.mjs"), manifestPath, dir],
      { encoding: "utf8", stdio: "pipe" },
    ),
  );
  assert.equal(readdirSync(tmp).includes(path.basename(dir)), false, "a directory was created for a refused manifest");
});
