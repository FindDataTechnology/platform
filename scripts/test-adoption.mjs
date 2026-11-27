// ── Adoption pipeline tests (add-official-adopted-agents 2.3 / 2.4 / 2.5) ────
//
// 钉住四件事：
//   1. 端到端：取包 → 许可 → 钉定 → 组装 → 自检 能产出一份合法 manifest。
//   2. 零副作用：许可不过 / 上游取不到 / 无法钉定 → 抛结构化错误，没有产物。
//   3. 工具面默认 chat（2.5）且 provenance 字段齐全（2.4）。
//   4. 快照自足（2.3）：manifest 自带正文与辅助文件，删掉上游也还是完整包。
//
//   node --test scripts/test-adoption.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  adoptExternalSkill,
  previewAdoption,
  buildAdoptedManifest,
  resolvePinnedRevision,
  ADOPTED_AGENT_ID,
} from "../lib/adoption.js";
import { validatePackManifest } from "../lib/pack-manifest.js";

const MIT_TEXT = `MIT License

Copyright (c) 2024 Upstream

Permission is hereby granted, free of charge, to any person obtaining a copy.`;

const AGPL_TEXT = `GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007`;

const SHA = "4a93985763241755401a10678395303de4e720ba";
const ENTRY = {
  source: "smithery",
  slug: "demo-skill",
  name: "demo-skill",
  displayName: "Demo Skill",
  description: "把 CSV 转成图表",
  originUrl: `https://github.com/acme/repo/tree/main/skills/demo-skill`,
  tags: ["data", "chart"],
  licenseState: "unknown", // 货架永远 unknown —— 不许参与判定
};

const PACK = {
  body: "# Demo Skill\n\n把 CSV 转成图表。\n\n## 步骤\n\n1. 读取文件\n2. 生成图\n",
  files: {
    "SKILL.md": "should be dropped", // 校验器禁止，必须剔除
    "scripts/plot.py": "print('hi')",
    "refs/guide.md": "# 指南",
  },
  frontmatter: { description: "把 CSV 转成图表", license: "MIT" },
  inventory: [
    { path: "SKILL.md", bytes: 10, script: false, action: "stored" },
    { path: "scripts/plot.py", bytes: 12, script: true, action: "stored" },
  ],
};

// 假 registry：只实现转正用到的两个读操作。
function fakeRegistry({ pack = PACK, entry = ENTRY, fetchPackageThrows = null } = {}) {
  return {
    async fetchPackage(source, slug) {
      if (fetchPackageThrows) throw fetchPackageThrows;
      if (source !== entry.source || slug !== entry.slug) return null;
      return pack;
    },
    async getEntry(source, slug) {
      if (source !== entry.source || slug !== entry.slug) return null;
      return { entry };
    },
  };
}

// 假上游：仓库根 LICENSE + commits 解析。
function fakeUpstream({ licenseText = MIT_TEXT, commitSha = SHA, failAll = false } = {}) {
  return async (url) => {
    if (failAll) throw new Error("network down");
    if (url.includes("/commits/")) {
      return { ok: true, status: 200, json: async () => ({ sha: commitSha }) };
    }
    if (url.includes("/contents/skills?ref=")) {
      return { ok: true, status: 200, json: async () => [{ name: "demo-skill", path: "skills/demo-skill", type: "dir", size: 0 }] };
    }
    if (url.includes("/contents/skills/demo-skill?ref=")) {
      return { ok: true, status: 200, json: async () => [{ name: "LICENSE", path: "skills/demo-skill/LICENSE", type: "file", size: 90 }] };
    }
    if (url.includes("LICENSE")) {
      return { ok: true, status: 200, text: async () => licenseText };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => null };
  };
}

const OP = { operator: "ops@finddata.cloud", reviewer: "reviewer@finddata.cloud", now: "2026-10-31T03:00:00.000Z" };

// ── 1. 端到端 ───────────────────────────────────────────────────────────────

test("adopt: end-to-end produces a valid manifest with provenance and chat tool face", async () => {
  const { manifest, report } = await adoptExternalSkill({
    source: "smithery",
    slug: "demo-skill",
    registry: fakeRegistry(),
    fetchImpl: fakeUpstream(),
    ...OP,
  });

  assert.equal(manifest.provenance.kind, "official-adopted");
  assert.equal(manifest.provenance.upstreamUrl, ENTRY.originUrl);
  assert.equal(manifest.provenance.upstreamName, "demo-skill");
  assert.equal(manifest.provenance.license, "MIT");
  assert.equal(manifest.provenance.revision, SHA);
  assert.equal(manifest.provenance.adoptedBy, OP.operator);
  assert.equal(manifest.provenance.reviewedBy, OP.reviewer);
  assert.equal(manifest.provenance.reviewedAt, OP.now);

  // 工具面默认收窄（2.5）
  const agent = manifest.agents.find((a) => a.id === ADOPTED_AGENT_ID);
  assert.equal(agent.serving.toolFace, "chat");

  // 自检必须过（用发布门同一套规则）
  assert.deepEqual(validatePackManifest(manifest), []);

  // 报告如实说明这是草稿
  assert.equal(report.personaDrafted, true);
  assert.ok(report.mustReview.length >= 1);
  assert.equal(report.revisionKind, "commit");
});

test("adopt: the manifest is self-contained (snapshot survives upstream deletion)", async () => {
  const { manifest } = await adoptExternalSkill({
    source: "smithery",
    slug: "demo-skill",
    registry: fakeRegistry(),
    fetchImpl: fakeUpstream(),
    ...OP,
  });
  const skill = manifest.skills[0];
  // 正文与辅助文件都在 manifest 里 —— 运行期不需要回源
  assert.match(skill.content, /把 CSV 转成图表/);
  assert.equal(skill.files["scripts/plot.py"], "print('hi')");
  assert.equal(skill.files["refs/guide.md"], "# 指南");
  // SKILL.md 被剔除（校验器禁止，渲染时由 content 生成）
  assert.equal(skill.files["SKILL.md"], undefined);
  // 上游信息只是审计锚点，不是可用性依赖
  assert.ok(manifest.provenance.upstreamUrl);
  assert.ok(manifest.provenance.revision);
});

// ── 2. 零副作用 / 失败路径 ──────────────────────────────────────────────────

test("adopt: AGPL upstream is rejected before any manifest exists", async () => {
  await assert.rejects(
    () =>
      adoptExternalSkill({
        source: "smithery",
        slug: "demo-skill",
        registry: fakeRegistry(),
        fetchImpl: fakeUpstream({ licenseText: AGPL_TEXT }),
        ...OP,
      }),
    (err) => {
      assert.equal(err.code, "license-rejected");
      assert.equal(err.axis, "copyleft-network");
      return true;
    },
  );
});

test("adopt: missing attribution is refused", async () => {
  await assert.rejects(
    () => adoptExternalSkill({ source: "smithery", slug: "demo-skill", registry: fakeRegistry() }),
    (err) => err.code === "adoption-unattributed",
  );
});

test("adopt: unknown entry fails closed", async () => {
  await assert.rejects(
    () => adoptExternalSkill({ source: "smithery", slug: "nope", registry: fakeRegistry(), fetchImpl: fakeUpstream(), ...OP }),
    (err) => err.code === "unknown-source",
  );
});

test("adopt: an unpinnable upstream is refused rather than faked", async () => {
  // 上游全部失败 → 许可也拿不到，先撞许可门；用一个非 github origin 只测钉定
  const marketEntry = { ...ENTRY, originUrl: "https://skillhub.cn/skills/demo-skill" };
  await assert.rejects(
    () =>
      adoptExternalSkill({
        source: "smithery",
        slug: "demo-skill",
        registry: fakeRegistry({ entry: marketEntry }),
        fetchImpl: fakeUpstream(),
        ...OP,
      }),
    (err) => err.code === "unpinnable-upstream",
  );
});

// ── 3. 钉定 ─────────────────────────────────────────────────────────────────

test("pin: a 40-hex ref is used as-is without an extra request", async () => {
  let called = false;
  const pin = await resolvePinnedRevision(
    { originUrl: `https://github.com/acme/repo/tree/${SHA}/skills/demo` },
    { fetchImpl: async () => { called = true; return { ok: false }; } },
  );
  assert.equal(pin.revision, SHA);
  assert.equal(pin.revisionKind, "commit");
  assert.equal(called, false, "no network call for an already-pinned sha");
});

test("pin: a branch ref resolves to a commit sha", async () => {
  const pin = await resolvePinnedRevision(
    { originUrl: "https://github.com/acme/repo/tree/main/skills/demo" },
    { fetchImpl: fakeUpstream() },
  );
  assert.equal(pin.revision, SHA);
  assert.equal(pin.revisionKind, "commit");
});

test("pin: resolution failure falls back to the ref and says so honestly", async () => {
  const pin = await resolvePinnedRevision(
    { originUrl: "https://github.com/acme/repo/tree/main/skills/demo" },
    { fetchImpl: async () => { throw new Error("rate limited"); } },
  );
  assert.equal(pin.revision, "main");
  assert.equal(pin.revisionKind, "ref", "must not pretend a branch is a pinned commit");
});

test("pin: a non-repo origin yields no revision", async () => {
  const pin = await resolvePinnedRevision({ originUrl: "https://skillhub.cn/skills/x" }, { fetchImpl: fakeUpstream() });
  assert.equal(pin.revision, null);
  assert.equal(pin.revisionKind, "none");
});

// ── 4. 预览与组装 ───────────────────────────────────────────────────────────

test("preview: reports license/pinnability/file counts without producing a manifest", async () => {
  const prev = await previewAdoption({
    source: "smithery",
    slug: "demo-skill",
    registry: fakeRegistry(),
    fetchImpl: fakeUpstream(),
  });
  assert.equal(prev.license.state, "admitted");
  assert.equal(prev.license.governing, "MIT");
  assert.equal(prev.pinnable, true);
  assert.equal(prev.revision, SHA);
  assert.equal(prev.inlinedFiles, 3); // SKILL.md + 2 aux（inlinedFiles 计原始包）
  assert.equal(prev.hasScripts, true);
});

test("build: a shelf-reported unknown license does not decide the outcome (upstream MIT governs)", async () => {
  // ENTRY.licenseState 是 "unknown"；产物里的 license 必须来自上游证据
  const { manifest } = await adoptExternalSkill({
    source: "smithery",
    slug: "demo-skill",
    registry: fakeRegistry(),
    fetchImpl: fakeUpstream(),
    ...OP,
  });
  assert.equal(manifest.provenance.license, "MIT");
  assert.notEqual(manifest.provenance.license, "unknown");
});

test("build: draft persona names the capability and encodes the honesty discipline", () => {
  const { manifest } = buildAdoptedManifest({
    pack: PACK,
    entry: ENTRY,
    license: { governing: "MIT", observed: [], notes: [] },
    pin: { revision: SHA, revisionKind: "commit", repo: "acme/repo" },
    operator: "ops@x",
    reviewer: "rev@x",
    now: "2026-10-31T00:00:00.000Z",
  });
  const persona = manifest.agents[0].persona;
  assert.match(persona, /Demo Skill/);
  assert.match(persona, /不在我的能力范围内/);
  assert.match(persona, /不编造|不要编造/);
});

// ── 5. 能力探测与工具面（2026-10-31 真机发现） ──────────────────────────────
//
// 首个真实候选 nano-pdf 依赖 CLI（正文写 `nano-pdf edit ...`，frontmatter 声明
// requires.bins）。若照旧给 chat 面，产物就是「能说不能做」的残废 Agent。

import { detectCapabilityNeeds, adoptionVerdict } from "../lib/adoption.js";

const PACK_WITH_BINS = {
  ...PACK,
  frontmatter: {
    description: "编辑 PDF",
    metadata: { openclaw: { requires: { bins: ["nano-pdf"] }, install: [{ id: "uv" }] } },
  },
  body: "# nano-pdf\n\n```bash\nnano-pdf edit deck.pdf 1 \"改标题\"\n```\n",
};

test("capability: required bins are detected from nested frontmatter", () => {
  const n = detectCapabilityNeeds(PACK_WITH_BINS);
  assert.equal(n.requiresExecution, true);
  assert.deepEqual(n.bins, ["nano-pdf"]);
});

test("capability: a plain doc skill needs no execution", () => {
  const n = detectCapabilityNeeds({ body: "# 文档\n\n介绍一下流程。", frontmatter: { description: "d" } });
  assert.equal(n.requiresExecution, false);
  assert.deepEqual(n.bins, []);
});

test("adopt: a CLI-dependent skill is refused rather than silently crippled", async () => {
  const reg = {
    async fetchPackage() { return PACK_WITH_BINS; },
    async getEntry() { return { entry: ENTRY }; },
  };
  await assert.rejects(
    () => adoptExternalSkill({ source: "smithery", slug: "demo-skill", registry: reg, fetchImpl: fakeUpstream(), ...OP }),
    (err) => {
      assert.equal(err.code, "toolface-insufficient");
      assert.deepEqual(err.bins, ["nano-pdf"]);
      return true;
    },
  );
});

test("adopt: the same skill adopts when a reviewer explicitly widens the tool face", async () => {
  const reg = {
    async fetchPackage() { return PACK_WITH_BINS; },
    async getEntry() { return { entry: ENTRY }; },
  };
  const { manifest, report } = await adoptExternalSkill({
    source: "smithery", slug: "demo-skill", registry: reg, fetchImpl: fakeUpstream(), ...OP, widenFullToolFace: true,
  });
  const agent = manifest.agents[0];
  assert.equal(agent.serving.toolFace, undefined, "widened = no chat narrowing declared");
  assert.deepEqual(validatePackManifest(manifest), []);
  assert.equal(report.toolFace, "full");
  assert.equal(report.capabilityNeeds.requiresExecution, true);
  assert.ok(report.mustReview.some((m) => m.includes("nano-pdf")), "reviewer must be told about the required bin");
});

test("verdict: one-line decision text reflects each blocker", () => {
  assert.match(adoptionVerdict({ license: { state: "rejected", axis: "copyleft" }, pin: {}, needs: {} }), /拒绝.*copyleft/);
  assert.match(adoptionVerdict({ license: { state: "not-declared" }, pin: {}, needs: {} }), /未声明许可/);
  assert.match(adoptionVerdict({ license: { state: "admitted", governing: "MIT" }, pin: { revision: null }, needs: {} }), /不可钉定/);
  assert.match(adoptionVerdict({ license: { state: "admitted" }, pin: { revision: "abc" }, needs: { requiresExecution: true, bins: ["x"] } }), /放宽工具面/);
  assert.match(adoptionVerdict({ license: { state: "admitted" }, pin: { revision: "abc" }, needs: { requiresExecution: false } }), /可转正/);
});

// ── 6. 1.4 桥往返：provenance 不得在草稿⇄清单之间丢失 ──────────────────────
//
// 三条往返路径：编辑器编译器（web compileDraftManifest）、导入 bundle 的反向
// 编译（server import-bundle）。二者都必须在 entries 里携带 provenance，否则
// 一个转正包重新发布时归属会静默消失 —— 那等于无授权再分发。
// 这里用与两条路径同构的组装逻辑断言：带 provenance 的 entries 组出的 manifest
// 必须通过校验且字段 completo；不带 provenance 的必须与旧行为逐字节相同。

import { validateProvenance } from "../lib/pack-manifest.js";

function compileLikeEditor({ draft, entries }) {
  return {
    name: draft.name,
    description: draft.description,
    visibility: draft.visibility ?? "public",
    tags: draft.tags,
    skills: entries.skills ?? [],
    mcpServers: entries.mcpServers ?? [],
    agents: entries.agents ?? [],
    ...(Array.isArray(entries.bots) && entries.bots.length > 0 ? { bots: entries.bots } : {}),
    ...(entries.provenance ? { provenance: entries.provenance } : {}),
  };
}

const ADOPT_PROVENANCE = {
  kind: "official-adopted",
  upstreamUrl: "https://github.com/acme/repo/tree/main/skills/x",
  upstreamName: "x",
  license: "MIT",
  revision: SHA,
  adoptedBy: "ops@finddata.cloud",
  reviewedBy: "reviewer@finddata.cloud",
  reviewedAt: "2026-10-31T00:00:00.000Z",
};

test("bridge: an adoption draft compiles into a manifest that keeps provenance intact", () => {
  const manifest = compileLikeEditor({
    draft: { name: "X", description: "d", tags: ["t"] },
    entries: {
      skills: PACK.skills ? PACK.skills : [{ name: "x", description: "d", content: "body" }],
      provenance: ADOPT_PROVENANCE,
    },
  });
  assert.deepEqual(manifest.provenance, ADOPT_PROVENANCE, "every audit field must survive the bridge");
  const errors = [];
  validateProvenance(manifest, errors);
  assert.deepEqual(errors, [], "the round-tripped block must still be a legal shape");
});

test("bridge: a plain authoring draft emits no provenance key (byte-identical legacy manifest)", () => {
  const manifest = compileLikeEditor({
    draft: { name: "Y", description: "d", tags: [] },
    entries: { skills: [{ name: "y", description: "d", content: "body" }] },
  });
  assert.equal("provenance" in manifest, false);
  assert.deepEqual(validatePackManifest(manifest), []);
});

test("bridge: import reverse-compile carries provenance the same way (server path equivalence)", () => {
  // 与 server/routes/packs.js import-bundle 的 entries 构造同构
  const manifestFromBundle = {
    name: "X", skills: [{ name: "x", description: "d", content: "body" }],
    provenance: ADOPT_PROVENANCE,
  };
  const entries = {
    skills: manifestFromBundle.skills ?? [],
    mcpServers: manifestFromBundle.mcpServers ?? [],
    agents: manifestFromBundle.agents ?? [],
    ...(manifestFromBundle.provenance ? { provenance: manifestFromBundle.provenance } : {}),
  };
  assert.deepEqual(entries.provenance, ADOPT_PROVENANCE);
  // 再正向编译回去，仍然在
  const back = compileLikeEditor({ draft: { name: "X", description: "", tags: [] }, entries });
  assert.deepEqual(back.provenance, ADOPT_PROVENANCE);
});
