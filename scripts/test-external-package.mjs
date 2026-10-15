#!/usr/bin/env node
// ── External package fetch + parse (add-external-skill-install 2.1–2.4) ─────
//
// Exercises the package layer with injected fetch stubs — no network:
//   · safePackagePath / parsePackage: traversal refusal, junk filtering, text
//     vs binary vs oversized classification, limits fail closed, no-SKILL.md
//   · outboundFetchBytes: manual redirect following with a host allowlist
//   · SkillHub fetchPackage: download endpoint → zip unpack → parse
//   · Smithery fetchPackage: gitUrl parse, contents-API walk, intermediate
//     symlink resolution, upstream-404 fail-closed
//   · registry package cache: TTL/size/error-not-cached
//
//   node --test scripts/test-external-package.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";

import {
  PACKAGE_LIMITS,
  parsePackage,
  safePackagePath,
  resolveRepoPath,
  parseGitTreeUrl,
  createSkillhubAdapter,
  createSmitheryAdapter,
  createExternalSourceRegistry,
} from "../external-sources.js";

// ── parsePackage ─────────────────────────────────────────────────────────────

test("safePackagePath refuses traversal, absolute, drive, backslash and NUL", () => {
  assert.equal(safePackagePath("scripts/x.py"), "scripts/x.py");
  assert.equal(safePackagePath("./a/b.txt"), "a/b.txt");
  for (const bad of ["../x", "a/../../x", "/abs/x", "C:/x", "a\\b", "a\0b", "", "..", "."]) {
    assert.equal(safePackagePath(bad), null, `must refuse ${JSON.stringify(bad)}`);
  }
});

test("parsePackage extracts body + frontmatter + text files, filters junk", () => {
  const p = parsePackage({
    "SKILL.md": Buffer.from("---\nname: up\nwhenToUse: w\n---\n\n# Body\n"),
    "scripts/run.py": Buffer.from("print(1)\n"),
    "_meta.json": Buffer.from("{}"),
    "__MACOSX/._SKILL.md": Buffer.from("junk"),
    ".DS_Store": Buffer.from("junk"),
    "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
  });
  assert.equal(p.frontmatter.name, "up");
  assert.ok(p.body.startsWith("\n# Body"));
  assert.deepEqual(Object.keys(p.files).sort(), ["_meta.json", "scripts/run.py"]);
  const byPath = Object.fromEntries(p.inventory.map((i) => [i.path, i]));
  assert.equal(byPath["scripts/run.py"].script, true);
  assert.equal(byPath["logo.png"].action, "omitted-binary");
  assert.ok(!("__MACOSX/._SKILL.md" in byPath), "junk never enters the inventory");
});

test("parsePackage refuses packages without SKILL.md", () => {
  assert.throws(() => parsePackage({ "readme.md": "hi" }), /no SKILL\.md/);
});

test("parsePackage fails closed on auxiliary file-count limit", () => {
  const files = { "SKILL.md": "---\nname: x\n---\nbody" };
  for (let i = 0; i <= PACKAGE_LIMITS.maxAuxFiles; i += 1) files[`f${i}.md`] = "x";
  assert.throws(() => parsePackage(files), /auxiliary files/);
});

test("parsePackage fails closed on body-length limit", () => {
  const big = "x".repeat(PACKAGE_LIMITS.maxBodyChars + 1);
  assert.throws(() => parsePackage({ "SKILL.md": `---\nname: y\n---\n${big}` }), /body exceeds/);
});

test("oversized descriptor rows surface as omitted-large, never bytes", () => {
  const p = parsePackage({
    "SKILL.md": "---\nname: z\n---\nbody",
    "scripts/huge.py": { oversized: true, size: 10_000_000 },
  });
  const row = p.inventory.find((i) => i.path === "scripts/huge.py");
  assert.equal(row.action, "omitted-large");
  assert.equal(row.script, true);
  assert.ok(!("scripts/huge.py" in p.files));
});

// ── URL parsing ──────────────────────────────────────────────────────────────

test("parseGitTreeUrl handles tree and blob shapes", () => {
  assert.deepEqual(parseGitTreeUrl("https://github.com/o/r/tree/main/skills/x"), {
    owner: "o", repo: "r", ref: "main", subPath: "skills/x",
  });
  assert.deepEqual(parseGitTreeUrl("https://github.com/o/r/blob/v2/skills/x/SKILL.md"), {
    owner: "o", repo: "r", ref: "v2", subPath: "skills/x",
  });
  assert.equal(parseGitTreeUrl("https://gitlab.com/o/r/tree/main/x"), null);
  assert.equal(parseGitTreeUrl("https://github.com/o/r"), null);
});

test("resolveRepoPath normalizes without escaping", () => {
  assert.equal(resolveRepoPath(".claude", "../.agents/skills"), ".agents/skills");
  assert.equal(resolveRepoPath("a/b", "c/./d"), "a/b/c/d");
  assert.equal(resolveRepoPath("", "../../etc"), null);
});

// ── fetch stubs ──────────────────────────────────────────────────────────────

function jsonRes(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj)),
    headers: new Headers(),
  };
}

function redirectRes(location, status = 302) {
  return {
    ok: false,
    status,
    headers: new Headers({ location }),
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function binRes(buf) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => JSON.parse(buf.toString("utf8")),
    text: async () => buf.toString("utf8"),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

// ── SkillHub adapter ─────────────────────────────────────────────────────────

async function makeZip(entries) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("skillhub fetchPackage: download endpoint → redirect → zip → parsed", async () => {
  const zipBuf = await makeZip({
    "SKILL.md": "---\nname: demo\nversion: 9\n---\n\n# Demo",
    "scripts/a.py": "print('a')",
  });
  const calls = [];
  const adapter = createSkillhubAdapter({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("/download")) return redirectRes("https://bucket.cos.accelerate.myqcloud.com/x.zip");
      if (url.includes("myqcloud.com")) return binRes(zipBuf);
      throw new Error(`unexpected url ${url}`);
    },
  });
  const p = await adapter.fetchPackage("demo");
  assert.equal(calls.length, 2);
  assert.equal(p.frontmatter.name, "demo");
  assert.deepEqual(Object.keys(p.files), ["scripts/a.py"]);
  assert.ok(p.body.includes("# Demo"));
});

test("skillhub fetchPackage refuses a redirect off the allowed hosts", async () => {
  const adapter = createSkillhubAdapter({
    fetchImpl: async () => redirectRes("https://evil.example.com/x.zip"),
  });
  await assert.rejects(() => adapter.fetchPackage("demo"), /redirect left the allowed hosts/);
});

// ── Smithery adapter ─────────────────────────────────────────────────────────

test("smithery fetchPackage: gitUrl → contents API walk → parsed", async () => {
  const calls = [];
  const adapter = createSmitheryAdapter({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("/skills?pageSize=")) {
        return jsonRes({
          skills: [{
            slug: "demo",
            displayName: "Demo",
            gitUrl: "https://github.com/o/r/tree/main/skills/demo",
          }],
        });
      }
      // githubResolveDir probes each path segment: "skills", then "skills/demo".
      if (url.includes("api.github.com/repos/o/r/contents/skills?")) {
        return jsonRes([{ name: "demo", path: "skills/demo", type: "dir", size: 0 }]);
      }
      if (url.includes("api.github.com/repos/o/r/contents/skills/demo")) {
        return jsonRes([
          { name: "SKILL.md", path: "skills/demo/SKILL.md", type: "file", size: 20, download_url: "https://raw.example/SKILL.md" },
        ]);
      }
      if (url === "https://raw.example/SKILL.md") {
        return binRes(Buffer.from("---\nname: demo\n---\n\n# Body"));
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  const p = await adapter.fetchPackage("demo");
  assert.equal(p.frontmatter.name, "demo");
  assert.ok(calls.some((c) => c.includes("contents/skills/demo")));
});

test("smithery fetchPackage resolves an INTERMEDIATE symlink path segment", async () => {
  const adapter = createSmitheryAdapter({
    fetchImpl: async (url) => {
      if (url.includes("/skills?pageSize=")) {
        return jsonRes({
          skills: [{ slug: "demo", gitUrl: "https://github.com/o/r/tree/main/.claude/skills/demo" }],
        });
      }
      // Probing ".claude" → a directory listing (so it resolves as a dir).
      if (url.includes("/contents/.claude?")) return jsonRes([{ name: "skills", path: ".claude/skills", type: "symlink", target: "../.agents/skills" }]);
      // Probing ".claude/skills" → a symlink entry (not an array).
      if (url.includes("/contents/.claude/skills?")) {
        return jsonRes({ type: "symlink", target: "../.agents/skills" });
      }
      // After resolution the real listing: ".agents/skills/demo".
      if (url.includes("/contents/.agents/skills/demo?")) {
        return jsonRes([
          { name: "SKILL.md", path: ".agents/skills/demo/SKILL.md", type: "file", size: 10, download_url: "https://raw.example/S.md" },
        ]);
      }
      if (url === "https://raw.example/S.md") return binRes(Buffer.from("---\nname: demo\n---\nbody"));
      throw new Error(`unexpected url ${url}`);
    },
  });
  const p = await adapter.fetchPackage("demo");
  assert.equal(p.frontmatter.name, "demo");
});

test("smithery fetchPackage fails closed when the upstream directory is gone", async () => {
  const adapter = createSmitheryAdapter({
    fetchImpl: async (url) => {
      if (url.includes("/skills?pageSize=")) {
        return jsonRes({
          skills: [{ slug: "stale", gitUrl: "https://github.com/o/r/tree/main/gone" }],
        });
      }
      return jsonRes({ message: "Not Found" }, 404);
    },
  });
  await assert.rejects(
    () => adapter.fetchPackage("stale"),
    (e) => e.code === "upstream-not-found" && /upstream directory not found/.test(e.message),
  );
});

// ── Registry package cache ───────────────────────────────────────────────────

// A stubbed registry whose one fetchable source counts zip downloads.
function cacheRegistry() {
  let zipDownloads = 0;
  const registry = createExternalSourceRegistry({
    env: { EXTERNAL_SKILL_SOURCES: "skillhub" },
    fetchImpl: async (url) => {
      if (url.includes("/download")) return redirectRes("https://b.myqcloud.com/x.zip");
      if (url.includes("myqcloud.com")) {
        zipDownloads += 1;
        const zip = await makeZip({ "SKILL.md": "---\nname: c\n---\nbody" });
        return binRes(zip);
      }
      return jsonRes({ results: [] });
    },
  });
  return { registry, downloads: () => zipDownloads };
}

test("registry fetchPackage serves repeats from cache, evicts past the cap", async () => {
  const { registry, downloads } = cacheRegistry();
  const a = await registry.fetchPackage("skillhub", "cached-demo");
  const b = await registry.fetchPackage("skillhub", "cached-demo");
  assert.equal(downloads(), 1, "second call must not re-download");
  assert.equal(a, b, "cached object identity");
  // Five more distinct slugs evict the first (cap 5) → refetch downloads again.
  for (let i = 0; i < 5; i += 1) await registry.fetchPackage("skillhub", `filler-${i}`);
  const before = downloads();
  assert.equal(before, 6, "each filler downloads once (1 initial + 5 fillers)");
  const again = await registry.fetchPackage("skillhub", "cached-demo");
  assert.notEqual(again, a, "entry past the cap must have been evicted");
  assert.equal(downloads(), before + 1, "evicted entry re-downloads");
});

test("registry fetchPackage never caches a failure", async () => {
  let attempts = 0;
  const failing = createExternalSourceRegistry({
    env: { EXTERNAL_SKILL_SOURCES: "smithery" },
    fetchImpl: async (url) => {
      if (url.includes("/skills?pageSize=")) {
        return jsonRes({ skills: [{ slug: "bad", gitUrl: "https://github.com/o/r/tree/main/nope" }] });
      }
      attempts += 1;
      return jsonRes({ message: "Not Found" }, 404);
    },
  });
  await assert.rejects(() => failing.fetchPackage("smithery", "bad"), (e) => e.code === "upstream-not-found");
  await assert.rejects(() => failing.fetchPackage("smithery", "bad"), (e) => e.code === "upstream-not-found");
  assert.ok(attempts >= 2, "failures must retry from scratch, not serve a remembered error");
});

test("registry fetchPackage resolves null for a disabled or unknown source", async () => {
  const registry = createExternalSourceRegistry({
    env: { EXTERNAL_SKILL_SOURCES: "skillhub" },
    fetchImpl: async () => jsonRes({}, 404),
  });
  assert.equal(await registry.fetchPackage("smithery", "x"), null, "disabled source → null");
  assert.equal(await registry.fetchPackage("nope", "x"), null, "unknown source → null");
});
