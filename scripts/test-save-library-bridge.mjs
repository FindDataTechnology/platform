// The `save_to_library` dsh plugin (dsh-profile-template/platform-save-library-bridge.js)
// and its profile patch, against a FAKE loopback route
// (openspec: add-save-to-library-tool, task 2.1).
//
// The tool is a thin client — argument shaping and per-path rendering only —
// so the tests pin exactly those: the JSON-text/array argument forms, the
// early refusals the route would otherwise have to answer, and that the
// rendered result tells the model what to say per path. The gate itself is
// server-side and covered by test-resources-api.mjs.

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const TEMPLATE_DIR = path.resolve(new URL(".", import.meta.url).pathname, "../dsh-profile-template");
const REPO_ROOT = path.resolve(TEMPLATE_DIR, "..");

// Load the plugin the way the generated profile does: beside the real
// @deepseek-ai/dsh-tools so defineTool resolves.
async function loadPlugin() {
  const tmp = mkdtempSync(path.join(tmpdir(), "save-library-bridge-"));
  copyFileSync(
    path.join(TEMPLATE_DIR, "platform-save-library-bridge.js"),
    path.join(tmp, "platform-save-library-bridge.js"),
  );
  mkdirSync(path.join(tmp, "node_modules", "@deepseek-ai"), { recursive: true });
  symlinkSync(
    path.dirname(require.resolve("@deepseek-ai/dsh-tools")),
    path.join(tmp, "node_modules", "@deepseek-ai", "dsh-tools"),
  );
  const mod = await import(pathToFileURL(path.join(tmp, "platform-save-library-bridge.js")).href);
  return { mod, tmp };
}

// A loopback stand-in for the platform's save-declared route.
function fakeRoute({ respond = null } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      received.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
      const answer = respond
        ? respond(received[received.length - 1])
        : { ok: true, results: [{ path: "a.txt", status: "saved", id: "r1" }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  return {
    received,
    async listen() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    close() {
      return new Promise((r) => server.close(r));
    },
  };
}

function register(mod) {
  let registered = null;
  mod.apply({ tools: { register: (def) => (registered = def) } });
  assert.ok(registered, "save_to_library was not registered");
  return registered;
}

// The execute result is the output VALUE; its rendered form comes from the
// tool's output.render(args, value). The local refusal path returns the
// already-rendered blocks instead (the route was never called, so there is no
// value to project).
function textOf(tool, value) {
  const blocks = value?._render ?? tool.output.render({}, value);
  return (blocks ?? []).map((b) => b?.text ?? "").join("\n");
}

test("the plugin registers one save tool with an array paths parameter", async () => {
  const { mod, tmp } = await loadPlugin();
  try {
    assert.equal(mod.name, "save-library-bridge");
    assert.deepEqual(mod.inject, ["tools"]);
    const tool = register(mod);
    assert.equal(tool.name, "save_to_library");
    assert.equal(tool.parameters.properties.paths.type, "array");
    assert.deepEqual(tool.parameters.required, ["paths"]);
    assert.match(tool.description, /same turn/i);
    assert.match(tool.description, /deduplicated|already in the library/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("execute rejects a JSON-text paths argument before any code runs", async () => {
  const { mod, tmp } = await loadPlugin();
  try {
    const tool = register(mod);
    // defineTool validates against the declared schema before execute: a JSON
    // text string is not an array, so the call throws at the harness boundary.
    await assert.rejects(() => tool.execute({ paths: '["a.txt"]' }), (err) => /must be an array/.test(err.message));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a save lands: the posted body carries the paths; results render per path", async () => {
  const bridge = fakeRoute({
    respond: () => ({
      ok: true,
      results: [
        { path: "reports/周报.pdf", status: "saved", id: "r1" },
        { path: "data.csv", status: "already-saved", id: "r2" },
        { path: "big.bin", status: "refused", reason: "file_too_large", message: "文件超过 20MB 上限，无法存入资源" },
      ],
    }),
  });
  const url = await bridge.listen();
  const previous = process.env.SAVE_BRIDGE_URL;
  process.env.SAVE_BRIDGE_URL = url;
  const { mod, tmp } = await loadPlugin();
  try {
    const tool = register(mod);
    const value = await tool.execute({ paths: ["reports/周报.pdf", "data.csv", "big.bin"] });
    assert.equal(bridge.received.length, 1);
    assert.deepEqual(bridge.received[0].body, { paths: ["reports/周报.pdf", "data.csv", "big.bin"] });

    const text = textOf(tool, value);
    assert.match(text, /Saved to the library: reports\/周报\.pdf/);
    assert.match(text, /Already in the library[^:]*: data\.csv/);
    assert.match(text, /Not saved — big\.bin: 文件超过 20MB 上限/);
    assert.match(text, /成果/);
  } finally {
    process.env.SAVE_BRIDGE_URL = previous;
    await bridge.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("an unparsable or empty paths argument is refused locally without a round-trip", async () => {
  const bridge = fakeRoute();
  await bridge.listen();
  const previous = process.env.SAVE_BRIDGE_URL;
  process.env.SAVE_BRIDGE_URL = bridge.url;
  const { mod, tmp } = await loadPlugin();
  try {
    const tool = register(mod);
    for (const bad of [[], [""], ["   "]]) {
      const value = await tool.execute({ paths: bad });
      assert.match(textOf(tool, value), /paths.*must be a non-empty list/i, `argument ${JSON.stringify(bad)} is refused`);
    }
    // A non-string item is rejected one layer earlier, by the declared schema.
    await assert.rejects(() => tool.execute({ paths: ["ok.txt", 42] }), (err) => /must be a string/.test(err.message));
    assert.equal(bridge.received.length, 0, "nothing reached the route");
  } finally {
    process.env.SAVE_BRIDGE_URL = previous;
    await bridge.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the eleventh path is refused early with the cap reason", async () => {
  const bridge = fakeRoute({
    respond: (req) => ({
      ok: true,
      results: req.body.paths.map((p) => ({ path: p, status: "saved", id: "x" })),
    }),
  });
  await bridge.listen();
  const previous = process.env.SAVE_BRIDGE_URL;
  process.env.SAVE_BRIDGE_URL = bridge.url;
  const { mod, tmp } = await loadPlugin();
  try {
    const tool = register(mod);
    const paths = Array.from({ length: 12 }, (_, i) => `f${i}.txt`);
    const value = await tool.execute({ paths });
    const text = textOf(tool, value);
    // The first ten went over the wire; the last two were refused locally.
    assert.equal(bridge.received[0].body.paths.length, 10);
    assert.match(text, /每次调用最多 10 个路径/);
    assert.equal((text.match(/每次调用最多/g) ?? []).length, 2, "each excess path gets its own refusal");
  } finally {
    process.env.SAVE_BRIDGE_URL = previous;
    await bridge.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("an unreachable route refuses every path with a reason the model can relay", async () => {
  const previous = process.env.SAVE_BRIDGE_URL;
  process.env.SAVE_BRIDGE_URL = "http://127.0.0.1:1"; // nothing listens here
  const { mod, tmp } = await loadPlugin();
  try {
    const tool = register(mod);
    const value = await tool.execute({ paths: ["a.txt"] });
    const text = textOf(tool, value);
    assert.match(text, /Not saved — a\.txt/);
    assert.match(text, /保存通道不可达/);
  } finally {
    process.env.SAVE_BRIDGE_URL = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the profile patch writer lands the plugin and the overlay row", () => {
  // Source-level: the writer copies the plugin beside the patch and inserts
  // exactly one row. (The full write path runs in dsh-contracts against a real
  // DSH home; this pins the shape.)
  const profile = readFileSync(path.join(REPO_ROOT, "dsh-profile.js"), "utf8");
  assert.match(profile, /platform-save-library-bridge\.js/);
  assert.match(profile, /save-library\.patch\.yml/);
  assert.match(profile, /id: "save-library-bridge"/);
});
