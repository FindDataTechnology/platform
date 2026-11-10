// ── Draft ↔ published relation (complete-creator-loop 3.x) ──────────────────
//
//   node --test scripts/test-draft-relation.mjs
//
// 钉住的契约：
//   · 关系由清单结构性比较得出，不依赖任何脏标记；
//   · 键序无关（服务端把清单原文存库，序列化顺序不可信）；
//   · 只在结构完全相等时报「与线上一致」——任何差异都报「有未发布改动」
//     （假「有改动」只是多建议发布一次；假「一致」会藏掉真实工作）。

import assert from "node:assert/strict";
import { test } from "node:test";

const { canonicalize, draftRelation } = await import("../web/src/lib/draftRelation.ts");

test("canonicalize is key-order independent", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
});

test("canonicalize keeps array order (guide steps, skill lists)", () => {
  assert.notEqual(canonicalize([{ t: "a" }, { t: "b" }]), canonicalize([{ t: "b" }, { t: "a" }]));
});

test("an absent key equals an explicitly undefined one", () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
});

test("no published version → never published", () => {
  assert.deepEqual(draftRelation({ version: null, publishedManifest: null, draftManifest: { a: 1 } }), {
    state: "never-published",
  });
  assert.deepEqual(draftRelation({ version: 0, publishedManifest: {}, draftManifest: {} }), {
    state: "never-published",
  });
});

test("identical manifests report same, with the live version", () => {
  const manifest = { name: "x", tags: ["a"], guide: { steps: [{ title: "t", body: "b" }] } };
  assert.deepEqual(
    draftRelation({ version: 3, publishedManifest: manifest, draftManifest: { ...manifest, tags: [...manifest.tags] } }),
    { state: "same", version: 3 },
  );
});

test("a single field change reports ahead", () => {
  const published = { name: "x", description: "old" };
  assert.deepEqual(
    draftRelation({ version: 3, publishedManifest: published, draftManifest: { name: "x", description: "new" } }),
    { state: "ahead", version: 3 },
  );
});

test("an added reference reports ahead", () => {
  assert.deepEqual(
    draftRelation({
      version: 7,
      publishedManifest: { mcpServers: [] },
      draftManifest: { mcpServers: [{ registryName: "srv" }] },
    }),
    { state: "ahead", version: 7 },
  );
});
