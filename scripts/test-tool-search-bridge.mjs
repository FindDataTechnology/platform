// Unit tests for the `tool_search` dsh plugin (dsh-profile-template/
// platform-tool-search-bridge.js) against a FAKE tool registry — the same
// contract the real dsh ToolRuntime exposes (schemas(scope), register).
// Run: node --test scripts/test-tool-search-bridge.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// The plugin imports `@deepseek-ai/dsh-tools` and `./tool-discovery.js`.
// Resolve dsh-tools from the developer's dsh profile home (the same tree the
// child uses); copy tool-discovery.js next to the plugin so the relative
// import resolves exactly as it will in the generated profile.
const require = createRequire(import.meta.url);

function thisFilePath() {
  return pathToFileURL(process.argv[1]).pathname;
}

const TEMPLATE_DIR = path.resolve(path.dirname(thisFilePath()), "../dsh-profile-template");

test("plugin registers a read-only tool_search scoped to the agent view", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tool-search-bridge-"));
  fs.copyFileSync(
    path.join(TEMPLATE_DIR, "platform-tool-search-bridge.js"),
    path.join(tmp, "platform-tool-search-bridge.js"),
  );
  fs.copyFileSync(
    path.resolve(TEMPLATE_DIR, "../server/tool-discovery.js"),
    path.join(tmp, "tool-discovery.js"),
  );
  // The plugin resolves `@deepseek-ai/dsh-tools` by walking node_modules from
  // its own directory — mirror the profile layout (node_modules beside the
  // plugin file) the same way the generated profile does.
  fs.mkdirSync(path.join(tmp, "node_modules", "@deepseek-ai"), { recursive: true });
  fs.symlinkSync(
    path.dirname(require.resolve("@deepseek-ai/dsh-tools")),
    path.join(tmp, "node_modules", "@deepseek-ai", "dsh-tools"),
  );
  const mod = await import(pathToFileURL(path.join(tmp, "platform-tool-search-bridge.js")).href);

  const visibleSchemas = [
    {
      name: "mcp__fd-open-data-mcp__list_concepts",
      description: "List economic concepts.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "mcp__fd-find-data-business-mcp__wb_search_indicators",
      description: "Search World Bank indicators such as GDP.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    // NOT visible: a restricted/foreign server's tool.
    {
      name: "mcp__secret-server__internal_probe",
      description: "Hidden from this scope.",
      parameters: { type: "object", properties: {} },
    },
  ];

  let registered = null;
  const fakeCtx = {
    tools: {
      register: (def) => {
        registered = def;
      },
      schemas: (scope) => {
        // Scope-aware fake: the "agent" sees only the two effective tools.
        assert.equal(scope, "agent-scope-1");
        return visibleSchemas.slice(0, 2);
      },
    },
  };

  assert.equal(mod.name, "tool-search-bridge");
  assert.deepEqual(mod.inject, ["tools"]);
  mod.apply(fakeCtx);

  assert.ok(registered, "tool_search was not registered");
  assert.equal(registered.name, "tool_search");
  // defineTool projects the declarative parameter map onto a JSON schema:
  // `{ parameters: { query: {...} } }` becomes
  // `{ type: "object", properties: { query: {...} }, required: [...] }`.
  assert.ok(registered.parameters.required.includes("query"), "query must be required");

  const exec = { agent: "agent-scope-1" };
  const value = await registered.execute({ query: "list_concepts" }, exec);
  assert.equal(value.count, 1);
  assert.equal(value.results[0].name, "mcp__fd-open-data-mcp__list_concepts");
  assert.equal(value.results[0].origin, "mcp");

  // Renderer states the exact name and the read-only contract. The renderer
  // returns a plain string[] (snapshot-projected as text content).
  const blocks = registered.output.render({ query: "list_concepts" }, value);
  const text = blocks.map((b) => (typeof b === "string" ? b : b?.text)).join("\n");
  assert.match(text, /EXACT NAME: mcp__fd-open-data-mcp__list_concepts/);
  assert.match(text, /Nothing was executed|never executes/i);

  // No-candidate path stays honest.
  const none = await registered.execute({ query: "zzz_unrelated" }, exec);
  assert.equal(none.count, 0);
  const noneBlocks = registered.output.render({ query: "zzz_unrelated" }, none);
  const noneText = noneBlocks.map((b) => (typeof b === "string" ? b : b?.text)).join("\n");
  assert.match(noneText, /No effective tool matches/);
  assert.doesNotMatch(noneText, /EXACT NAME/);

  // Limit is bounded and respected ("mcp" normalizes away, so use a real
  // token both visible tools match — the leaf-less server filter won't do
  // here since only two tools exist; query "concepts OR indicators" hits one
  // each, capped at 1).
  const limited = await registered.execute({ query: "concepts indicators", limit: 1 }, exec);
  assert.equal(limited.count, 1);

  fs.rmSync(tmp, { recursive: true, force: true });
});
