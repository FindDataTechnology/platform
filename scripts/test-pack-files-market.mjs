#!/usr/bin/env node
// ── Facet market line for skill packages (add-packaged-skills, tasks 3.1-3.4)─
//
// Route-level contract over a real registry + registerPackRoutes:
//   3.1 a >1mb files-bearing publish passes the route's jsonLimit (24mb)
//   3.2 detail projects files to a path inventory; the per-file endpoint
//       serves contents under the stored-version visibility (anonymous for
//       public packs, not-found for strangers on private packs, no escapes)
//   3.3 PACK_FILES_ENABLED gates files-bearing publishes only (default off)
//   3.4 the raw-md single-document endpoint refuses tree skills fail-loud
//
//   node --test scripts/test-pack-files-market.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test, after } from "node:test";

delete process.env.PACK_FILES_ENABLED; // per-request gate; default under test
const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const tmpRoot = mkdtempSync(path.join(tmpdir(), "pack-files-market-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const TREE_MANIFEST = (name = "复杂技能包", visibility) => ({
  name,
  description: "带辅助文件",
  ...(visibility ? { visibility } : {}),
  skills: [
    {
      name: "tree-skill",
      description: "多文件技能",
      content: "# 正文\n见 references/。",
      files: {
        "references/x.md": "# 参考 X\n",
        "references/deep/y.md": "# 参考 Y\n",
        "scripts/run.py": "print('hi')\n",
      },
      frontmatter: { whenToUse: "复杂任务时" },
    },
    { name: "doc-skill", description: "单文档", content: "# 纯文稿\n" },
  ],
  mcpServers: [],
  agents: [],
});

const PLAIN_MANIFEST = {
  name: "普通包",
  skills: [{ name: "doc-skill", description: "d", content: "c" }],
  mcpServers: [],
  agents: [],
};

async function boot({ user = { email: "author@x", groups: ["creators"] }, anonymousRead = true } = {}) {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: (req) => {
      // The header seam stands in for the session: absent = anonymous.
      const who = req.headers["x-test-user"];
      return who ? user : null;
    },
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth required" }),
    creatorGroups: ["creators"],
    adminGroups: [],
    anonymousRead,
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, init = {}) =>
    fetch(`${base}${p}`, init).then(async (r) => ({
      status: r.status,
      text: await r.text(),
      headers: r.headers,
      body: null,
    })).then(async (r) => {
      if (r.headers.get("content-type")?.includes("application/json")) {
        try { r.body = JSON.parse(r.text); } catch { /* keep text */ }
      }
      return r;
    });
  const publish = (manifest, extraHeaders = {}) =>
    call("/api/packs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user": "1", ...extraHeaders },
      body: JSON.stringify({ manifest }),
    });
  return {
    registry, call, publish,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      registry.close();
    },
  };
}

test.after(() => {
  delete process.env.PACK_FILES_ENABLED;
});

test("3.3 gate off: files-bearing publish refused with the gate named; files-free publish unaffected", async () => {
  const h = await boot();
  try {
    delete process.env.PACK_FILES_ENABLED;
    const refused = await h.publish(TREE_MANIFEST("被门挡的包"));
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "pack-files-disabled");
    assert.match(refused.body.error, /PACK_FILES_ENABLED/);
    assert.equal(h.registry.list({ viewer: { email: "author@x" } }).packs.length, 0, "nothing stored");

    const plain = await h.publish(PLAIN_MANIFEST);
    assert.equal(plain.status, 200, "files-free publish is never gated");
    assert.ok(plain.body.id);
  } finally {
    await h.close();
  }
});

test("3.1+3.3 gate on: a >1mb files-bearing publish passes the raised jsonLimit and stores", async () => {
  const h = await boot();
  try {
    process.env.PACK_FILES_ENABLED = "1";
    // ~1.5MiB of auxiliary content — comfortably past the old 1mb wall, split
    // across files to respect the per-file cap (aggregate stays under 2MiB).
    const big = TREE_MANIFEST("大包");
    for (let i = 0; i < 3; i++) {
      big.skills[0].files[`references/big${i}.md`] = "# 大文件\n" + "x".repeat(500 * 1024);
    }
    const r = await h.publish(big);
    assert.equal(r.status, 200, `publish failed: ${r.text.slice(0, 200)}`);
    const id = r.body.id;

    // The stored VERSION read (install channel) carries the full manifest.
    const ver = await h.call(`/api/packs/${id}/versions/1`);
    assert.equal(ver.status, 200);
    assert.match(ver.body.manifest.skills[0].files["references/big0.md"], /大文件/);

    // 3.2 The DETAIL view compresses files to a sorted path inventory.
    const detail = await h.call(`/api/packs/${id}`, { headers: { "x-test-user": "1" } });
    assert.equal(detail.status, 200);
    const projected = detail.body.manifest.skills[0].files;
    assert.deepEqual(projected, [
      "references/big0.md", "references/big1.md", "references/big2.md",
      "references/deep/y.md", "references/x.md", "scripts/run.py",
    ]);
    assert.ok(!JSON.stringify(detail.body).includes("print('hi')"), "no auxiliary content rides the detail payload");
    assert.deepEqual(detail.body.manifest.skills[0].frontmatter, { whenToUse: "复杂任务时" }, "frontmatter rides untouched");

    // 3.2 Per-file reads: nested path 200 + exact content, anonymous included.
    const anon = await h.call(`/api/packs/${id}/versions/1/skills/tree-skill/files/references/deep/y.md`);
    assert.equal(anon.status, 200);
    assert.equal(anon.text, "# 参考 Y\n");

    // Path escapes are 404, never a traversal.
    const escapeProbe = await h.call(`/api/packs/${id}/versions/1/skills/tree-skill/files/${encodeURIComponent("../../etc/passwd")}`);
    assert.equal(escapeProbe.status, 404);
    const missing = await h.call(`/api/packs/${id}/versions/1/skills/tree-skill/files/references/nope.md`);
    assert.equal(missing.status, 404);
    const foreign = await h.call(`/api/packs/${id}/versions/1/skills/doc-skill/files/any.md`);
    assert.equal(foreign.status, 404, "single-doc skill has no files surface");

    // 3.4 Raw-md: the tree skill refuses fail-loud; the single-doc skill serves.
    const treeRaw = await h.call(`/api/packs/${id}/versions/1/skills/tree-skill.md`);
    assert.equal(treeRaw.status, 400);
    assert.match(treeRaw.text, /auxiliary files/);
    const docRaw = await h.call(`/api/packs/${id}/versions/1/skills/doc-skill.md`);
    assert.equal(docRaw.status, 200);
    assert.match(docRaw.text, /# 纯文稿/);
  } finally {
    delete process.env.PACK_FILES_ENABLED;
    await h.close();
  }
});

test("3.2 visibility: a private pack's files are not-found to a stranger, readable to the author", async () => {
  const author = { email: "author@x", groups: ["creators"] };
  const h = await boot({ user: author });
  try {
    process.env.PACK_FILES_ENABLED = "1";
    const pub = await h.publish(TREE_MANIFEST("私包", "private"));
    assert.equal(pub.status, 200);
    const id = pub.body.id;

    const stranger = await h.call(`/api/packs/${id}/versions/1/skills/tree-skill/files/references/x.md`);
    assert.equal(stranger.status, 404, "anonymous caller: private pack answers not-found");

    const owner = await h.call(`/api/packs/${id}/versions/1/skills/tree-skill/files/references/x.md`, { headers: { "x-test-user": "1" } });
    assert.equal(owner.status, 200);
    assert.equal(owner.text, "# 参考 X\n");
  } finally {
    delete process.env.PACK_FILES_ENABLED;
    await h.close();
  }
});
