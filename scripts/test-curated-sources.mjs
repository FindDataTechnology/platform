#!/usr/bin/env node
// ── 精选外部技能源（adopt-curated-external-skills 1.x–3.x）─────────────────
//
// 全离线：fetch 用桩实现 GitHub contents / raw 两端，按 pin 的 sha 出内容。
// 覆盖四件事：
//   · 清单本身的结构守卫（pin 必须是 commit sha、禁入条目一个都不许在）
//   · adapter 的货架契约（list/get 归一化、originUrl 钉死、镜像许可态恒 unknown）
//   · 取包即取 pin（parsePackage + LICENSE 随包，供许可门读原文）
//   · 许可裁决与转正（Apache 准入 / 专有拒绝并点名轴 / 无许可拒绝）
//
//   node --test scripts/test-curated-sources.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { createExternalSourceRegistry } from "../external-sources.js";
import {
  CURATED_SOURCES,
  createCuratedAdapter,
  createCuratedAdapters,
  curatedOriginUrl,
} from "../lib/curated-sources.js";
import { adoptExternalSkill, previewAdoption, ADOPTED_AGENT_ID } from "../lib/adoption.js";
import { evaluateLicense } from "../lib/license-gate.js";
import { validatePackManifest } from "../lib/pack-manifest.js";

// ── 上游原文（真实措辞的节选）────────────────────────────────────────────────

const APACHE_TEXT = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION`;

// anthropics/skills 的 pdf/docx/pptx/xlsx 四条就是这一份原文（节选其要害句）。
const PROPRIETARY_TEXT = `© 2025 Anthropic, PBC. All rights reserved.

ADDITIONAL RESTRICTIONS: Notwithstanding anything in the Agreement to the
contrary, users may not:

- Extract these materials from the Services or retain copies of these
  materials outside the Services
- Reproduce or copy these materials
- Create derivative works based on these materials
- Distribute, sublicense, or transfer these materials to any third party`;

const APACHE_PIN = CURATED_SOURCES[0];
const SHA = APACHE_PIN.ref;

// ── GitHub 桩：contents（列举/单文件）+ raw（下载）────────────────────────────

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

function textRes(text, status = 200) {
  const buf = Buffer.from(text, "utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    headers: new Headers(),
  };
}

// repo = { owner, repo, ref, skills: { slug: { body, license?, aux? } } }
function makeGithub(repo) {
  const fileAt = (relPath) => {
    const segs = relPath.split("/");
    const slug = segs[1];
    const name = segs.slice(2).join("/");
    const skill = repo.skills[slug];
    if (!skill) return null;
    if (name === "SKILL.md") return skill.body;
    if (name === "LICENSE.txt") return skill.license ?? null;
    if (skill.aux && Object.hasOwn(skill.aux, name)) return skill.aux[name];
    return null;
  };

  return async function fetchImpl(url) {
    const u = new URL(String(url));

    if (u.hostname === "raw.githubusercontent.com") {
      const rel = u.pathname.split("/").slice(4).join("/"); // 去掉 owner/repo/ref
      const text = fileAt(rel);
      return text == null ? textRes("not found", 404) : textRes(text);
    }

    if (u.hostname !== "api.github.com") return jsonRes({ message: "unexpected host" }, 500);

    const m = /^\/repos\/([^/]+)\/([^/]+)\/contents\/?(.*)$/.exec(u.pathname);
    if (!m) return jsonRes({ message: "not found" }, 404);
    const target = decodeURIComponent(m[3]);

    if (target === "skills") {
      return jsonRes(
        Object.keys(repo.skills).map((slug) => ({
          name: slug,
          path: `skills/${slug}`,
          type: "dir",
          size: 0,
          target: null,
          download_url: null,
        })),
      );
    }

    // 目录列举：skills/<slug>
    const dirSlug = target.replace(/^skills\//, "");
    if (target.startsWith("skills/") && repo.skills[dirSlug]) {
      const skill = repo.skills[dirSlug];
      const names = ["SKILL.md", ...(skill.license != null ? ["LICENSE.txt"] : []), ...Object.keys(skill.aux ?? {})];
      return jsonRes(
        names.map((name) => ({
          name,
          path: `skills/${dirSlug}/${name}`,
          type: "file",
          size: 10,
          target: null,
          download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.ref}/skills/${dirSlug}/${name}`,
        })),
      );
    }

    // 单文件（许可门取原文走这条）
    const text = fileAt(target);
    return text == null ? jsonRes({ message: "Not Found" }, 404) : textRes(text);
  };
}

const SKILL_BODY = `---
name: webapp-testing
description: Toolkit for interacting with and testing local web applications using Playwright.
license: Complete terms in LICENSE.txt
---

# Web app testing

用 Playwright 驱动本地 Web 应用：启动、点、读、截图。
`;

function apacheRepo() {
  return {
    owner: APACHE_PIN.owner,
    repo: APACHE_PIN.repo,
    ref: SHA,
    skills: {
      "webapp-testing": { body: SKILL_BODY, license: APACHE_TEXT, aux: { "REFERENCE.md": "# 参考" } },
      "frontend-design": { body: SKILL_BODY.replace(/webapp-testing/g, "frontend-design"), license: APACHE_TEXT },
    },
  };
}

function customPin({ id = "test-pin", skills = {} } = {}) {
  return {
    id,
    displayName: "Test Pin",
    owner: "acme",
    repo: "repo",
    ref: "4a93985763241755401a10678395303de4e720ba",
    entries: Object.keys(skills).map((slug) => ({
      slug,
      path: `skills/${slug}`,
      summaryZh: "测试条目",
      description: "test entry",
      tags: ["test"],
    })),
  };
}

function registryFor(pin, fetchImpl) {
  return createExternalSourceRegistry({
    env: { EXTERNAL_SKILL_SOURCES: pin.id },
    fetchImpl,
    extraAdapters: [createCuratedAdapter(pin, { fetchImpl })],
  });
}

// ── 清单结构守卫 ─────────────────────────────────────────────────────────────

test("curated manifest pins a commit sha, never a branch", () => {
  for (const pin of CURATED_SOURCES) {
    assert.match(pin.ref, /^[0-9a-f]{40}$/, `${pin.id} must pin a 40-hex commit sha (got ${pin.ref})`);
    assert.ok(pin.owner && pin.repo, "owner/repo required");
  }
});

test("curated manifest never carries a non-redistributable upstream entry", () => {
  // 这四条是 Proprietary（"may not distribute / create derivative works"），
  // doc-coauthoring 没有 LICENSE 文件也不许进——结构性排除，不靠运行时门去挡。
  const forbidden = new Set(["pdf", "docx", "pptx", "xlsx", "doc-coauthoring"]);
  const slugs = CURATED_SOURCES.flatMap((p) => p.entries.map((e) => e.slug));
  for (const slug of forbidden) {
    assert.ok(!slugs.includes(slug), `${slug} must never be listed: it is proprietary/undeclared upstream`);
  }
  assert.equal(new Set(slugs).size, slugs.length, "slugs must be unique");
  for (const pin of CURATED_SOURCES) {
    for (const e of pin.entries) {
      assert.match(e.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${e.slug} must match the dsh skill grammar`);
      assert.ok(e.path.startsWith("skills/"), `${e.slug} path must live under skills/`);
    }
  }
});

// ── Adapter 契约 ─────────────────────────────────────────────────────────────

test("adapter lists and resolves curated entries with a pinned originUrl", async () => {
  const pin = customPin({ skills: { "webapp-testing": { body: SKILL_BODY, license: APACHE_TEXT } } });
  const adapter = createCuratedAdapter(pin, { fetchImpl: makeGithub({ ...pin, skills: { "webapp-testing": { body: SKILL_BODY, license: APACHE_TEXT } } }) });

  const all = await adapter.list("", 50);
  assert.equal(all.length, 1);
  const entry = all[0];
  assert.equal(entry.source, pin.id);
  assert.equal(entry.originUrl, `https://github.com/acme/repo/tree/${pin.ref}/skills/webapp-testing`);
  // 货架镜像态恒 unknown —— 判定权在许可门，不在清单
  assert.equal(entry.licenseState, "unknown");
  assert.equal(entry.extras.pinnedRevision, pin.ref);
  assert.equal(entry.extras.curated, true);

  assert.equal((await adapter.get("webapp-testing"))?.name, "webapp-testing");
  assert.equal(await adapter.get("nope"), null);
});

test("adapter search matches slug, Chinese summary and tags", async () => {
  const pin = customPin({ skills: { "webapp-testing": { body: SKILL_BODY, license: APACHE_TEXT } } });
  const adapter = createCuratedAdapter(pin, {
    fetchImpl: makeGithub({ ...pin, skills: { "webapp-testing": { body: SKILL_BODY, license: APACHE_TEXT } } }),
  });
  assert.equal((await adapter.list("webapp", 10)).length, 1);
  assert.equal((await adapter.list("测试", 10)).length, 1, "summaryZh is searchable");
  assert.equal((await adapter.list("test", 10)).length, 1, "tags are searchable");
  assert.equal((await adapter.list("zzz", 10)).length, 0);
});

test("fetchPackage reads the pinned directory and carries the LICENSE for the gate", async () => {
  const repo = apacheRepo();
  const adapter = createCuratedAdapter(APACHE_PIN, { fetchImpl: makeGithub(repo) });
  const pack = await adapter.fetchPackage("webapp-testing");

  assert.match(String(pack.body), /Playwright/);
  assert.equal(pack.frontmatter?.name, "webapp-testing");
  assert.equal(pack.files["LICENSE.txt"], APACHE_TEXT, "LICENSE must ride inside the package");
  assert.equal(pack.files["REFERENCE.md"], "# 参考");
  assert.ok(!Object.hasOwn(pack.files, "SKILL.md"), "the body is not repeated into aux files");
});

test("fetchPackage fails closed for a slug that is not in the pin", async () => {
  const adapter = createCuratedAdapter(APACHE_PIN, { fetchImpl: makeGithub(apacheRepo()) });
  await assert.rejects(
    () => adapter.fetchPackage("pdf"),
    (e) => e.code === "upstream-not-found" && /not a curated entry/.test(e.message),
  );
});

test("registry exposes the curated source through the injected adapters", async () => {
  const fetchImpl = makeGithub(apacheRepo());
  const registry = createExternalSourceRegistry({
    env: { EXTERNAL_SKILL_SOURCES: APACHE_PIN.id },
    fetchImpl,
    extraAdapters: createCuratedAdapters({ fetchImpl }),
  });
  assert.equal(registry.isEnabled(APACHE_PIN.id), true);
  assert.equal(registry.isEnabled("skillhub"), false, "env selection still narrows the source set");
  const pack = await registry.fetchPackage(APACHE_PIN.id, "webapp-testing");
  assert.match(String(pack.body), /Playwright/);
});

// ── 许可裁决 ─────────────────────────────────────────────────────────────────

test("license gate: a proprietary upstream license is rejected on its own axis, not called absent", () => {
  const r = evaluateLicense([{ source: "package:LICENSE.txt", text: PROPRIETARY_TEXT, tier: "primary" }]);
  assert.equal(r.state, "rejected");
  assert.equal(r.axis, "proprietary", "an all-rights-reserved license IS declared — the axis must say so");
  assert.equal(r.observed.length, 1, "the exact upstream text must stay on the record");
  assert.equal(r.observed[0].proprietary, true);
});

test("license gate: permissive boilerplate mentioning 'all rights reserved' still admits", () => {
  const mitWithBoilerplate = `MIT License\n\nCopyright (c) 2024 Someone\nAll rights reserved.\n\nPermission is hereby granted, free of charge...`;
  const r = evaluateLicense([{ source: "LICENSE", text: mitWithBoilerplate, tier: "primary" }]);
  assert.equal(r.state, "admitted");
  assert.equal(r.governing, "MIT");
});

test("license gate: absent license stays not-declared and is never guessed", () => {
  const r = evaluateLicense([]);
  assert.equal(r.state, "not-declared");
  assert.equal(r.axis, "license-absent");
});

// ── 转正 ─────────────────────────────────────────────────────────────────────

test("preview admits an Apache curated entry and pins the revision", async () => {
  const repo = apacheRepo();
  const registry = registryFor(APACHE_PIN, makeGithub(repo));
  const preview = await previewAdoption({
    source: APACHE_PIN.id,
    slug: "webapp-testing",
    registry,
    fetchImpl: makeGithub(repo),
  });
  assert.equal(preview.license.state, "admitted");
  assert.equal(preview.license.governing, "Apache-2.0");
  assert.equal(preview.revision, SHA);
  assert.equal(preview.revisionKind, "commit");
  assert.ok(preview.inlinedFiles >= 2, "LICENSE + REFERENCE must be inlined");
  assert.match(preview.verdict, /可转正/);
});

test("preview refuses a proprietary pin, naming the axis", async () => {
  const skills = { "demo-proprietary": { body: SKILL_BODY, license: PROPRIETARY_TEXT } };
  const pin = customPin({ id: "proprietary-pin", skills });
  const repo = { owner: pin.owner, repo: pin.repo, ref: pin.ref, skills };
  const fetchImpl = makeGithub(repo);

  const preview = await previewAdoption({
    source: pin.id,
    slug: "demo-proprietary",
    registry: registryFor(pin, fetchImpl),
    fetchImpl,
  });
  assert.equal(preview.license.state, "rejected");
  assert.equal(preview.license.axis, "proprietary");
  assert.match(preview.verdict, /拒绝.*proprietary/);

  await assert.rejects(
    () => adoptExternalSkill({ source: pin.id, slug: "demo-proprietary", registry: registryFor(pin, fetchImpl), fetchImpl, operator: "op@x", reviewer: "rev@x" }),
    (e) => e.code === "license-rejected" && e.axis === "proprietary",
    "adoption must not create an asset from proprietary content",
  );
});

test("preview refuses an entry with no license file at all", async () => {
  const skills = { "demo-bare": { body: SKILL_BODY } };
  const pin = customPin({ id: "bare-pin", skills });
  const repo = { owner: pin.owner, repo: pin.repo, ref: pin.ref, skills };
  const fetchImpl = makeGithub(repo);
  const preview = await previewAdoption({
    source: pin.id,
    slug: "demo-bare",
    registry: registryFor(pin, fetchImpl),
    fetchImpl,
  });
  assert.equal(preview.license.state, "not-declared");
  assert.match(preview.verdict, /未声明许可/);
});

test("adoption produces a valid, self-contained, handless official asset", async () => {
  const repo = apacheRepo();
  const { manifest, report } = await adoptExternalSkill({
    source: APACHE_PIN.id,
    slug: "webapp-testing",
    registry: registryFor(APACHE_PIN, makeGithub(repo)),
    fetchImpl: makeGithub(repo),
    operator: "op@finddata",
    reviewer: "rev@finddata",
    now: "2026-11-03T00:00:00.000Z",
  });

  assert.equal(manifest.provenance?.kind, "official-adopted");
  assert.equal(manifest.provenance?.revision, SHA);
  assert.equal(manifest.provenance?.license, "Apache-2.0");
  assert.equal(manifest.provenance?.upstreamUrl, `https://github.com/anthropics/skills/tree/${SHA}/skills/webapp-testing`);

  const agent = manifest.agents.find((a) => a.id === ADOPTED_AGENT_ID);
  assert.equal(agent.serving.toolFace, "chat", "adopted assets ship handless by default");

  const skill = manifest.skills[0];
  assert.match(skill.content, /Playwright/);
  assert.equal(skill.files?.["LICENSE.txt"], APACHE_TEXT, "the snapshot is complete without upstream");
  assert.deepEqual(validatePackManifest(manifest), []);
  assert.equal(report.revisionKind, "commit");
});

test("adoption survives a frontmatter that sanitizes down to nothing", async () => {
  // 实测形态：上游 frontmatter 只有 name + description（两个键都由行owns），
  // 清洗后剩 null。旧实现直接 Object.keys(null) → TypeError，整条技能崩掉。
  const bare = `---\nname: bare-skill\ndescription: 只有两个键的技能\n---\n\n# Bare\n`;
  const skills = { "bare-skill": { body: bare, license: APACHE_TEXT } };
  const pin = customPin({ id: "bare-fm-pin", skills });
  const repo = { owner: pin.owner, repo: pin.repo, ref: pin.ref, skills };
  const fetchImpl = makeGithub(repo);

  const { manifest } = await adoptExternalSkill({
    source: pin.id,
    slug: "bare-skill",
    registry: registryFor(pin, fetchImpl),
    fetchImpl,
    operator: "op@finddata",
    reviewer: "rev@finddata",
    now: "2026-11-03T00:00:00.000Z",
  });

  assert.match(manifest.skills[0].content, /# Bare/);
  assert.equal(manifest.skills[0].frontmatter, undefined, "nothing to carry means no key at all");
  assert.deepEqual(validatePackManifest(manifest), []);
});

test("adoption without an operator/reviewer is refused", async () => {
  const repo = apacheRepo();
  await assert.rejects(
    () =>
      adoptExternalSkill({
        source: APACHE_PIN.id,
        slug: "webapp-testing",
        registry: registryFor(APACHE_PIN, makeGithub(repo)),
        fetchImpl: makeGithub(repo),
      }),
    (e) => e.code === "adoption-unattributed",
  );
});

test("curatedOriginUrl builds a sha-pinned tree URL", () => {
  const pin = CURATED_SOURCES[0];
  assert.equal(
    curatedOriginUrl(pin, { path: "skills/mcp-builder" }),
    `https://github.com/anthropics/skills/tree/${pin.ref}/skills/mcp-builder`,
  );
});
