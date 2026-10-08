#!/usr/bin/env node
// ── Pack registry unit tests (add-pack-marketplace, tasks 1.1/1.2/1.6) ───────
//
// Exercises the gateway pack registry module directly — storage CRUD
// round-trip with two versions, manifest validation rejection classes, and
// the per-author publish rate limiter. The HTTP contract on top of these
// lives in test-pack-marketplace.mjs.
//
//   node --test scripts/test-pack-registry.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createPackRegistry,
  createPublishRateLimiter,
  validateManifest,
} from "../gateway/packs.js";

function validManifest(overrides = {}) {
  return {
    name: "法律-合同",
    description: "合同审查工作流",
    tags: ["法律", "合同"],
    skills: [
      {
        name: "legal-contract-workflow",
        description: "五阶段合同审查",
        content: "# 合同审查\n按阶段推进，不编造法条。",
      },
    ],
    mcpServers: [{ registryName: "law-bench" }],
    agents: [
      { id: "pack-contract-reviewer", name: "合同审查官", persona: "你是严谨的合同审查官。" },
    ],
    ...overrides,
  };
}

test("registry round-trips a pack with two immutable versions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-registry-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  try {
    const author = "author@example.com";
    const { id, version } = reg.publish({ email: author, manifest: validManifest() });
    assert.equal(version, 1);
    assert.match(id, /^[A-Za-z0-9_-]{22}$/); // 16 bytes base64url, 128 bits

    const got = reg.get(id);
    assert.equal(got.name, "法律-合同");
    assert.equal(got.authorEmail, author);
    assert.deepEqual(got.tags, ["法律", "合同"]);
    assert.equal(got.manifest.skills[0].name, "legal-contract-workflow");

    // Second publish appends v2; v1 stays retrievable and unchanged.
    const next = reg.publishVersion({
      email: author,
      id,
      manifest: validManifest({ name: "法律-合同 v2", tags: ["法律"] }),
    });
    assert.equal(next.version, 2);
    assert.equal(reg.get(id).version, 2);
    assert.equal(reg.get(id).name, "法律-合同 v2");
    const v1 = reg.getVersion(id, 1);
    assert.equal(v1.manifest.name, "法律-合同");

    // Another author cannot publish to this pack.
    assert.equal(reg.publishVersion({ email: "other@example.com", id, manifest: validManifest() }).error, "forbidden");
    assert.equal(reg.publishVersion({ email: author, id: "no-such-pack", manifest: validManifest() }).error, "not_found");
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("list, search, and tag filter see only live packs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-registry-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  try {
    const a = reg.publish({ email: "a@example.com", manifest: validManifest({ name: "合同包", tags: ["法律"] }) });
    reg.publish({ email: "b@example.com", manifest: validManifest({ name: "股票包", tags: ["金融"] }) });

    let listing = reg.list({});
    assert.equal(listing.total, 2);
    assert.ok(listing.packs.some((p) => p.id === a.id));

    assert.equal(reg.list({ search: "股票" }).total, 1);
    assert.equal(reg.list({ tag: "法律" }).total, 1);
    assert.equal(reg.list({ tag: "不存在" }).total, 0);

    // Unlisting hides the pack from browse but keeps versions fetchable and
    // does not touch subscriptions.
    reg.subscribe({ email: "sub@example.com", id: a.id });
    assert.ok(reg.setUnlisted({ email: "a@example.com", id: a.id }));
    assert.equal(reg.list({}).total, 1);
    assert.equal(reg.get(a.id), null);
    assert.ok(reg.get(a.id, { includeUnlisted: true }));
    assert.equal(reg.getVersion(a.id, 1).manifest.name, "合同包");
    assert.equal(reg.subscriberCount(a.id), 1);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("subscribe records the latest version; unsubscribe is explicit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-registry-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  try {
    const { id } = reg.publish({ email: "a@example.com", manifest: validManifest() });
    const sub = reg.subscribe({ email: "sub@example.com", id });
    assert.equal(sub.version, 1);
    assert.equal(sub.manifest.skills.length, 1);
    assert.ok(reg.subscription("sub@example.com", id));
    assert.equal(reg.subscriberCount(id), 1);

    // New versions do not rewrite existing subscription records.
    reg.publishVersion({ email: "a@example.com", id, manifest: validManifest({ name: "v2" }) });
    assert.equal(reg.subscription("sub@example.com", id).version, 1);

    // Resubscribe records the then-current version.
    const resub = reg.subscribe({ email: "sub@example.com", id });
    assert.equal(resub.version, 2);

    assert.ok(reg.unsubscribe({ email: "sub@example.com", id }));
    assert.equal(reg.subscription("sub@example.com", id), null);
    assert.equal(reg.subscriberCount(id), 0);
    assert.equal(reg.subscribe({ email: "sub@example.com", id: "missing" }), null);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateManifest enforces the v1 content boundary", () => {
  // Valid baseline passes.
  assert.deepEqual(validateManifest(validManifest()), []);

  // MCP entries must be registry references only — no endpoints or commands.
  const withUrl = validateManifest(validManifest({ mcpServers: [{ registryName: "x", url: "https://evil.example" }] }));
  assert.equal(withUrl.length, 1);
  assert.match(withUrl[0].error, /registry servers/);
  assert.equal(withUrl[0].entry, "mcpServers[0]");

  const withCommand = validateManifest(validManifest({ mcpServers: [{ registryName: "x", command: "curl" }] }));
  assert.match(withCommand[0].error, /registry servers/);

  // Agent entries are persona-only — no endpoints, models, or credentials.
  const withBaseUrl = validateManifest(
    validManifest({ agents: [{ id: "x", name: "X", persona: "p", baseUrl: "https://x", model: "m" }] }),
  );
  assert.match(withBaseUrl[0].error, /persona-only/);
  assert.equal(withBaseUrl[0].entry, "agents[0]");

  // Skill shape: name format, unique within the pack, bounded content.
  assert.ok(validateManifest(validManifest({ skills: [{ name: "bad name!", description: "d", content: "c" }] })).length > 0);
  const dup = validManifest({
    skills: [
      { name: "same", description: "d", content: "c" },
      { name: "same", description: "d", content: "c" },
    ],
  });
  assert.ok(validateManifest(dup).some((e) => /duplicate skill name/.test(e.error)));
  assert.ok(validateManifest(validManifest({ skills: [{ name: "ok", description: "d", content: "x".repeat(64 * 1024 + 1) }] })).length > 0);

  // A pack must have at least one part; counts and tags are capped.
  assert.ok(validateManifest({ name: "empty", skills: [], mcpServers: [], agents: [] }).length > 0);
  assert.ok(validateManifest(validManifest({ mcpServers: Array.from({ length: 6 }, () => ({ registryName: "x" })) })).length > 0);
  assert.ok(validateManifest(validManifest({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).length > 0);
  assert.ok(validateManifest({ name: 42 }).length > 0);
});

test("publish rate limiter is per-author and windowed", () => {
  const allow = createPublishRateLimiter({ windowMs: 1000, max: 2 });
  assert.ok(allow("a@example.com"));
  assert.ok(allow("a@example.com"));
  assert.equal(allow("a@example.com"), false);
  assert.ok(allow("b@example.com")); // independent bucket
});
