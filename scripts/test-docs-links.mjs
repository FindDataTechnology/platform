// ── Docs-view deep links must resolve (fix-supply-machine-faces 7.4) ────────
//
//   node --test scripts/test-docs-links.mjs
//
// 钉住的契约：
//   · docs 视图发出的每个深链（六份客户端指南 + creating-packs + 能力矩阵）
//     都必须对应一份真实存在的文档；
//   · 矩阵链接必须来自 cliFacts 的单一常量，不得再出现「把 X 替换成 X」这种
//     看起来在修、实际什么都没做的表达式；
//   · 离线判定：仓库里这份 docs/ecosystem 就是公开仓的镜像来源，本地存在即
//     视为可发布（在线校验是脚本的可选加速，不是唯一依据）；
//   · 产品深链指向的文档不得出现在公开快照的排除清单里——排除管的是「下次发布
//     要不要带」，整树替换式发布会把被排除的文件从公开仓**删掉**（见 7.1 实证）。
//
// 判据本体是「链接指向的文件在不在」，不是「链接字符串长得对不对」。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI_FACTS = path.join(ROOT, "facet/web/src/cliFacts.ts");
const DOCS_VIEW = path.join(ROOT, "facet/web/src/DocsView.tsx");
const ECOSYSTEM = path.join(ROOT, "docs/ecosystem");

const facts = fs.readFileSync(CLI_FACTS, "utf8");
const view = fs.readFileSync(DOCS_VIEW, "utf8");

test("every client guide the docs view links exists", () => {
  // The target set comes from the single source the view renders from.
  const ids = [...new Set([...facts.matchAll(/id:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]))];
  assert.ok(ids.length >= 5, `expected the client target table, got ${ids.join(",")}`);
  const local = new Set(fs.readdirSync(ECOSYSTEM));
  const missing = ids.filter((id) => !local.has(`${id}.md`));
  assert.deepEqual(missing, [], `docs view links ${missing.join(", ")} but those guides are absent`);
});

test("the capability matrix guide exists and is linked from its own constant", () => {
  assert.ok(fs.existsSync(path.join(ECOSYSTEM, "client-matrix.md")), "client-matrix.md must exist");
  assert.ok(
    /export const FACET_CLIENT_MATRIX_URL = `\$\{DOCS_REPO_BASE\}\/ecosystem\/client-matrix\.md`;/.test(facts),
    "the matrix URL is its own single-source constant",
  );
  assert.ok(view.includes("href={FACET_CLIENT_MATRIX_URL}"), "the view uses that constant");
  // The fix that fixed nothing: replacing "client-matrix.md" with the same text.
  assert.equal(
    /\.replace\(\s*\/client-matrix\\\.md\$\//.test(view),
    false,
    "no no-op replace may build the matrix link",
  );
});

test("the creating-packs guide exists", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "docs/creating-packs.md")), "docs/creating-packs.md must exist");
  assert.ok(/FACET_CREATING_GUIDE_URL/.test(facts), "its URL is single-sourced");
});

test("the docs view states the self-hosted install form", () => {
  // A self-hoster following the page used to install from the official market.
  assert.ok(view.includes("docs-install-selfhost"), "the self-hosted form renders");
  assert.ok(view.includes("--base <your-facet-url>"), "and it actually shows the flag");
  assert.ok(facts.includes("FACET_INSTALL_COMMAND"), "the command is single-sourced");
});

test("no deep-linked guide is excluded from the public snapshot", () => {
  // 这条钉的是一次真实的误判（2026-11-10，7.1）：看到 client-matrix 在排除清单里，
  // 就当成「公开仓没有它、要同步」，实际它早就发布了、还和本地逐字节相同。
  // 反过来才是真陷阱：被排除的文件在整树替换式发布下会被**删掉**，所以「产品深链
  // 指向的文档」这一集合绝不允许落在排除清单里——那要么意味着线上 404，要么意味着
  // 下次发布把它从公开仓删掉。判据仍旧是同一个：链接指向的东西必须真的在公开面。
  const script = path.join(ROOT, "scripts/make-public-snapshot.mjs");
  if (!fs.existsSync(script)) return; // 快照产物里没有这个脚本（它把自己排除了）

  const src = fs.readFileSync(script, "utf8");
  const start = src.indexOf("const EXCLUDE_PATHS = new Set([");
  assert.ok(start > 0, "the exclusion list is where we expect it");
  const body = src.slice(start, src.indexOf("]);", start));
  const excluded = new Set([...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]));

  const ids = [...new Set([...facts.matchAll(/id:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]))];
  const linked = [
    ...ids.map((id) => `docs/ecosystem/${id}.md`),
    "docs/ecosystem/client-matrix.md",
    "docs/creating-packs.md",
  ];
  const banned = linked.filter((p) => excluded.has(p));
  assert.deepEqual(
    banned,
    [],
    `these docs are linked from the product but excluded from the public snapshot: ${banned.join(", ")}`,
  );
});
