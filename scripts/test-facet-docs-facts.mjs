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
  // Every target WITH an MCP story is in MCP_TARGETS and nothing else is —
  // except the skills-only ones declared in NO_MCP_TARGETS (trae ships markdown
  // for a harness that has no MCP config). The list is explicit on purpose: a
  // new skills-only target has to say so rather than drift in silently.
  const withMcp = cliTargets.filter((t) => !facts.NO_MCP_TARGETS.includes(t));
  assert.deepEqual(Object.keys(cli.MCP_TARGETS).sort(), withMcp);
});

test("every skills directory matches targetDir() under a fake home", () => {
  for (const row of facts.FACET_TARGETS) {
    const { dir } = cli.targetDir({ target: row.id, project: null });
    assert.equal(tilde(dir), row.skillsDir, `skills dir drift for ${row.id}`);
  }
});

test("every native MCP config path matches the CLI's userFile()", () => {
  for (const row of facts.FACET_TARGETS) {
    const def = cli.MCP_TARGETS[row.id];
    // A skills-only target has no MCP story at all — nothing to compare.
    if (!def) {
      assert.ok(facts.NO_MCP_TARGETS.includes(row.id), `${row.id}: no MCP_TARGETS entry and not declared skills-only`);
      continue;
    }
    // Some targets delegate the write to their own CLI (qoder runs
    // `qodercli mcp add-json`) and therefore have no userFile() in ours. The
    // docs row still has to name the path that CLI writes — but there is
    // nothing to compare it against here, and pretending otherwise would be
    // the fake mirror this test exists to prevent.
    if (typeof def.userFile !== "function") {
      assert.ok(row.mcpFile, `${row.id}: no userFile() in the CLI, so the docs row must still name the path`);
      continue;
    }
    assert.equal(tilde(def.userFile()), row.mcpFile, `MCP config path drift for ${row.id}`);
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

// The "Model key write (sk-)" row (auto-provision-caller-key) must not claim a
// target the CLI cannot actually write. writeLlmConfig only handles
// claude-code / codex / gemini-cli; every other target's llmConfig must be
// "none". A matrix cell that says ✅ where the CLI throws "不支持的目标" is the
// exact fake-green this change exists to prevent.
test("capability table's model-key row mirrors writeLlmConfig's real targets", async () => {
  const fsp = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const repoRoot = pathMod.resolve(new URL("..", import.meta.url).pathname);
  const cli = await fsp.readFile(pathMod.join(repoRoot, "facet/cli/facet.js"), "utf8");
  const fnStart = cli.indexOf("async function writeLlmConfig");
  const body = cli.slice(fnStart, cli.indexOf("\n}\n", fnStart));
  const wired = new Set([...body.matchAll(/target === "([\w-]+)"/g)].map((m) => m[1]));
  const ts = await fsp.readFile(pathMod.join(repoRoot, "facet/web/src/cliFacts.ts"), "utf8");
  const capBlock = ts.slice(ts.indexOf("FACET_CAPABILITIES"));
  for (const m of capBlock.matchAll(/id: "([\w-]+)"[^\n]*llmConfig: "(\w[\w-]*)"/g)) {
    const [, id, tier] = m;
    const claimsWritten = tier !== "none";
    assert.equal(claimsWritten, wired.has(id), `${id}: matrix says model-key write=${claimsWritten} (${tier}), CLI writeLlmConfig handles=${wired.has(id)}`);
  }
  assert.ok(wired.size >= 3, `writeLlmConfig wires at least claude-code/codex/gemini-cli (found ${[...wired]})`);
});

// ── Discovery subcommands are real and documented (fix-supply-machine-faces 5.4) ──
// The docs facts single-source the commands they print. A constant that names a
// subcommand the CLI does not carry would send a reader into "未知命令".
test("list / search facts name subcommands the CLI actually dispatches", async () => {
  const cliSource = await (await import("node:fs/promises")).readFile(
    new URL("../facet/cli/facet.js", import.meta.url),
    "utf8",
  );
  for (const [constant, sub] of [
    [facts.FACET_LIST_COMMAND, "list"],
    [facts.FACET_SEARCH_COMMAND, "search"],
  ]) {
    assert.ok(constant.endsWith(` ${sub}`), `${constant} names the ${sub} subcommand`);
    assert.ok(
      cliSource.includes(`opts.command === "${sub}"`),
      `the CLI dispatches ${sub} (otherwise the docs point at a dead command)`,
    );
    assert.ok(cliSource.includes(`facet ${sub} `), `facet help documents ${sub}`);
  }
});

// ── Native MCP snippet shape (overhaul-facet-shell-ia-and-space 5.3) ────────
// The docs render each client's configuration snippet from FACET_MCP_SHAPES.
// A hand-written snippet would eventually teach a shape the CLI does not
// write — the exact failure mode that sent readers to a dead GitHub link
// before. So the table is compared against MCP_TARGETS.entry(): the URL key,
// the declared transport flag, and the container path all have to agree.
test("native MCP snippet shapes mirror the CLI's entry() output", async () => {
  const { MCP_TARGETS } = await import("../facet/cli/facet.js");
  const url = "https://example.test/mcp";
  const headers = { Authorization: "Bearer test" };
  for (const [id, shape] of Object.entries(facts.FACET_MCP_SHAPES)) {
    const def = MCP_TARGETS[id];
    assert.ok(def, `${id}: shape declared for a target the CLI does not carry`);
    // CLI-delegated writers have no entry() of ours to mirror (see above).
    if (typeof def.entry !== "function") continue;
    assert.equal(shape.format, def.toml ? "toml" : "json", `${id}: format drift`);
    if (def.toml) {
      // The TOML writer builds the table name from the container key.
      const src = await (await import("node:fs/promises")).readFile(
        new URL("../facet/cli/facet.js", import.meta.url),
        "utf8",
      );
      assert.ok(src.includes(`[${shape.container[0]}.`), `${id}: TOML table name drift`);
      continue;
    }
    const entry = def.entry(url, headers);
    assert.deepEqual(
      Object.keys(entry).sort(),
      [...(shape.declaresType ? ["type"] : []), ...(shape.extraKeys ?? []), shape.urlKey, "headers"].sort(),
      `${id}: entry keys drift (the docs would print a shape the CLI never writes)`,
    );
    // The container path the snippet nests under must be the map the CLI edits.
    const doc = {};
    const node = def.json.container(doc);
    const containerKey = def.json.key;
    assert.equal(shape.container[shape.container.length - 1], containerKey, `${id}: container key drift`);
    assert.ok(node, `${id}: container() returned nothing`);
  }
});

test("every client carries an in-site snippet (no guide is repo-only)", () => {
  for (const row of facts.FACET_TARGETS) {
    if (facts.NO_MCP_TARGETS.includes(row.id)) continue; // skills-only: no MCP snippet to show
    const sample = facts.mcpSample(row.id);
    assert.ok(sample.length > 0, `${row.id}: empty snippet`);
    assert.ok(sample.includes(facts.FACET_MCP_SHAPES[row.id].urlKey), `${row.id}: snippet omits its URL key`);
    // The snippet must place the entry under the shape's own container path
    // and must never ship a real credential.
    assert.ok(sample.includes("wgk-"), `${row.id}: snippet does not show the caller-key placeholder`);
    assert.equal(/wgk-[A-Za-z0-9]{8,}/.test(sample), false, `${row.id}: snippet looks like it embeds a real key`);
  }
});

// ── Every target has docs copy (raw-key guard) ──────────────────────────────
// The install tabs iterate FACET_TARGETS, but the copy table listed only five
// clients for months: selecting WorkBuddy rendered the literal key
// "facetDocs.clients.workbuddy.label" into the page. Nothing caught it because
// no test walked the target table through the locale bundles.
test("every target carries a client copy entry in all five locales", async () => {
  const fs = await import("node:fs/promises");
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
  for (const locale of ["en", "zh-CN", "es", "fr", "ja"]) {
    const bundle = JSON.parse(
      await fs.readFile(path.join(repoRoot, "web/src/locales", locale, "common.json"), "utf8"),
    );
    const clients = bundle.facetDocs.clients;
    for (const row of facts.FACET_TARGETS) {
      const entry = clients[row.id];
      assert.ok(entry, `${locale}: facetDocs.clients.${row.id} missing (the tab would render a raw key)`);
      assert.ok(entry.label, `${locale}: facetDocs.clients.${row.id}.label missing`);
      assert.ok(entry.pitfall1 && entry.pitfall2, `${locale}: facetDocs.clients.${row.id} lacks in-site troubleshooting copy`);
    }
  }
});
