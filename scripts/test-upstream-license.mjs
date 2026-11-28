// ── Upstream license evidence tests (add-official-adopted-agents task 2.2) ────
//
// 采集器的契约：永不抛、按可信度顺序返回证据、取不到就是空数组（fail-closed
// 交给许可门）。用假 fetchImpl 钉住三条路径与三条失败路径。
//
//   node --test scripts/test-upstream-license.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { collectUpstreamLicenseEvidence, licenseEvidenceFromPackage } from "../lib/upstream-license.js";

const MIT_TEXT = `MIT License

Copyright (c) 2024 Someone

Permission is hereby granted, free of charge, to any person obtaining a copy.`;

// 一个最小 GitHub contents API 假实现：按 URL 返回目录列表或原文。
function fakeGithub(routes) {
  return async (url, opts = {}) => {
    const wantsRaw = opts?.headers?.Accept === "application/vnd.github.raw";
    for (const [pattern, payload] of Object.entries(routes)) {
      if (!url.includes(pattern)) continue;
      if (payload == null) return { ok: false, status: 404, text: async () => "", json: async () => null };
      if (wantsRaw || typeof payload === "string") {
        const body = typeof payload === "string" ? payload : JSON.stringify(payload);
        return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => null };
  };
}

test("package evidence: LICENSE file inside the package is picked up with zero extra requests", () => {
  const ev = licenseEvidenceFromPackage({
    files: { "LICENSE": MIT_TEXT, "scripts/x.py": "print(1)" },
    frontmatter: {},
  });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].source, "package:LICENSE");
  assert.match(ev[0].text, /MIT/);
});

test("package evidence: frontmatter license is a fallback source", () => {
  const ev = licenseEvidenceFromPackage({ files: {}, frontmatter: { license: "Apache-2.0" } });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].source, "package:frontmatter");
});

test("repo evidence: LICENSE at the skill directory wins over repo root", async () => {
  const fetchImpl = fakeGithub({
    // githubResolveDir 逐段解析：先 skills，再 skills/demo（每段都要是数组）
    "/contents/skills?ref=main": [{ name: "demo", path: "skills/demo", type: "dir", size: 0 }],
    "/contents/skills/demo?ref=main": [
      { name: "LICENSE", path: "skills/demo/LICENSE", type: "file", size: 100 },
      { name: "SKILL.md", path: "skills/demo/SKILL.md", type: "file", size: 10 },
    ],
    "/contents/skills%2Fdemo%2FLICENSE?ref=main": MIT_TEXT,
  });
  const ev = await collectUpstreamLicenseEvidence(
    {
      source: "smithery",
      slug: "demo",
      entry: { originUrl: "https://github.com/owner/repo/tree/main/skills/demo" },
    },
    { fetchImpl },
  );
  assert.ok(ev.some((e) => e.source === "repo:skills/demo/LICENSE"), "skill-dir LICENSE must be found");
  assert.match(ev.find((e) => e.source.startsWith("repo:")).text, /MIT/);
});

test("repo evidence: falls back to repository root when the skill dir has no LICENSE", async () => {
  const fetchImpl = fakeGithub({
    "/contents/skills?ref=main": [{ name: "demo", path: "skills/demo", type: "dir", size: 0 }],
    "/contents/skills/demo?ref=main": [{ name: "SKILL.md", path: "skills/demo/SKILL.md", type: "file", size: 10 }],
    "/contents/?ref=main": [{ name: "LICENSE.md", path: "LICENSE.md", type: "file", size: 100 }],
    "/contents/LICENSE.md?ref=main": MIT_TEXT,
  });
  const ev = await collectUpstreamLicenseEvidence(
    { source: "smithery", slug: "demo", entry: { originUrl: "https://github.com/owner/repo/tree/main/skills/demo" } },
    { fetchImpl },
  );
  assert.ok(ev.some((e) => e.source === "repo:LICENSE.md"), "repo root LICENSE must be the fallback");
});

test("metadata fallback: package.json license is used only when no LICENSE file was found", async () => {
  const fetchImpl = fakeGithub({
    "/contents/skills?ref=main": [{ name: "demo", path: "skills/demo", type: "dir", size: 0 }],
    "/contents/skills/demo?ref=main": [{ name: "SKILL.md", path: "skills/demo/SKILL.md", type: "file", size: 10 }],
    "/contents/?ref=main": [],
    "/contents/skills%2Fdemo%2Fpackage.json?ref=main": JSON.stringify({ license: "MIT" }),
  });
  const ev = await collectUpstreamLicenseEvidence(
    { source: "smithery", slug: "demo", entry: { originUrl: "https://github.com/owner/repo/tree/main/skills/demo" } },
    { fetchImpl },
  );
  assert.ok(ev.some((e) => e.source.startsWith("package.json:")));
});

test("failures are never fatal: every fetch failing yields an empty evidence set", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const ev = await collectUpstreamLicenseEvidence(
    { source: "smithery", slug: "demo", entry: { originUrl: "https://github.com/owner/repo/tree/main/skills/demo" } },
    { fetchImpl },
  );
  assert.deepEqual(ev, [], "empty evidence → the gate will fail closed, not throw here");
});

test("non-github origin (market page) still yields package evidence only", async () => {
  const fetchImpl = async () => {
    throw new Error("should not be called");
  };
  const ev = await collectUpstreamLicenseEvidence(
    {
      source: "skillhub",
      slug: "demo",
      entry: { originUrl: "https://skillhub.cn/skills/demo" },
      pack: { files: { LICENSE: MIT_TEXT }, frontmatter: {} },
    },
    { fetchImpl },
  );
  assert.equal(ev.length, 1);
  assert.equal(ev[0].source, "package:LICENSE");
});
