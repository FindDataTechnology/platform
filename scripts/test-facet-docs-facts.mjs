#!/usr/bin/env node
// ── Facet docs facts: single-source drift guard (add-facet-docs-view) ───────
//
// The #/docs view renders per-target skills directories and native MCP config
// paths from facet/web/src/cliFacts.ts. The CLI (facet/cli/facet.js) owns the
// real behavior. This suite imports BOTH and asserts they agree: target set,
// every skills directory (via targetDir with a fake FACET_HOME), and every
// MCP config path (via MCP_TARGETS[target].userFile()). Change one side
// without the other and this goes red — the documentation cannot drift from
// the shipped CLI.
//
//   node --test scripts/test-facet-docs-facts.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "facet-docs-facts-"));
process.env.FACET_HOME = home; // must be set BEFORE importing the CLI module
test.after(() => rmSync(home, { recursive: true, force: true }));

const cli = await import("../facet/cli/facet.js");
const facts = await import("../facet/web/src/cliFacts.ts");

const tilde = (p) => p.replace(home, "~");

test("docs target set equals the CLI's target set", () => {
  const cliTargets = Object.keys(cli.SKILLS_SUBDIR).sort();
  const docTargets = facts.FACET_TARGETS.map((t) => t.id).sort();
  assert.deepEqual(docTargets, cliTargets);
  // MCP_TARGETS carries the same five (no target has skills without an MCP
  // story, or vice versa).
  assert.deepEqual(Object.keys(cli.MCP_TARGETS).sort(), cliTargets);
});

test("every skills directory matches targetDir() under a fake home", () => {
  for (const row of facts.FACET_TARGETS) {
    const { dir } = cli.targetDir({ target: row.id, project: null });
    assert.equal(tilde(dir), row.skillsDir, `skills dir drift for ${row.id}`);
  }
});

test("every native MCP config path matches the CLI's userFile()", () => {
  for (const row of facts.FACET_TARGETS) {
    const file = cli.MCP_TARGETS[row.id].userFile();
    assert.equal(tilde(file), row.mcpFile, `MCP config path drift for ${row.id}`);
  }
});

test("command constants carry the published package and subcommands", () => {
  assert.ok(facts.FACET_INSTALL_COMMAND.includes(facts.FACET_CLI_PACKAGE));
  assert.ok(facts.FACET_INSTALL_COMMAND.includes("install"));
  assert.ok(facts.FACET_CONNECT_COMMAND.includes(facts.FACET_CLI_PACKAGE));
  assert.ok(facts.FACET_CONNECT_COMMAND.includes("connect"));
  assert.ok(facts.FACET_HELP_COMMAND.includes("help"));
});

test("default market and registry URLs match the CLI defaults", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../facet/cli/facet.js", import.meta.url), "utf8"),
  );
  assert.ok(src.includes(`"${facts.FACET_MARKET_URL}"`), "market URL drift");
  assert.ok(src.includes(`"${facts.FACET_REGISTRY_URL}"`), "registry URL drift");
});

test("deep-guide URLs point into the public repository docs tree", () => {
  assert.ok(facts.FACET_CREATING_GUIDE_URL.endsWith("/docs/creating-packs.md"));
  assert.ok(facts.FACET_CREATING_GUIDE_URL.startsWith("https://github.com/FindDataTechnology/platform/blob/main/"));
  for (const row of facts.FACET_TARGETS) {
    const url = facts.FACET_CLIENT_GUIDE_URL(row.id);
    assert.ok(url.endsWith(`/docs/ecosystem/${row.id}.md`), `guide URL shape for ${row.id}`);
  }
});

// ── Capability matrix mirror (add-facet-client-matrix, F2.2) ────────────────
test("capability table mirrors MCP_TARGETS project-file presence", async () => {
  const { MCP_TARGETS } = await import("../facet/cli/facet.js");
  const fsp = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const repoRoot = pathMod.resolve(new URL("..", import.meta.url).pathname);
  const ts = await fsp.readFile(pathMod.join(repoRoot, "facet/web/src/cliFacts.ts"), "utf8");
  const capBlock = ts.slice(ts.indexOf("FACET_CAPABILITIES"));
  for (const [id, def] of Object.entries(MCP_TARGETS)) {
    const hasProject = typeof def.projectFile === "function";
    const row = capBlock.slice(capBlock.indexOf(`id: "${id}"`));
    const cell = row.split("\n")[0];
    const claimsProject = !cell.includes("mcpProjectFile: null");
    assert.equal(claimsProject, hasProject, `${id}: matrix says project MCP=${claimsProject}, CLI has projectFile=${hasProject}`);
  }
});
