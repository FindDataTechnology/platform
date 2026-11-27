// 页面集注册 ↔ 落盘 ↔ app.config 三处一致性（change: guard-pageset-mounting）。
//
// 真树必须零问题；另外用 fixture 造四种红，证明这条守卫**能红**——否则它只是
// 一段永远为真的断言（本仓有过教训：空转断言比没有断言更糟）。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PAGESETS } from "./registry.ts";
import { checkMounting } from "./mounting.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..");

/** 四个业务面下带 index.tsx 的页面目录（相对 miniapp/src）。 */
function pageDirs() {
  const out = [];
  for (const surface of ["ue", "se", "sp", "cp"]) {
    const base = join(srcDir, "pages", surface);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `pages/${surface}/${entry.name}`;
      if (existsSync(join(srcDir, rel, "index.tsx"))) out.push(rel);
    }
  }
  return out;
}

/** app.config.ts 里以 pages/ 开头的静态登记（注释里的路径不算，注释行先剔掉）。 */
function declaredPages() {
  const path = join(srcDir, "app.config.ts");
  assert.ok(existsSync(path), "app.config.ts 必须在 miniapp/src 下");
  const code = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return [...code.matchAll(/"(pages\/[^"]+)"/g)].map((m) => m[1]);
}

test("真树：页面集入口三处一致（registry / 落盘 / app.config）", () => {
  const dirs = pageDirs();
  const problems = checkMounting({
    pagesets: PAGESETS,
    declaredPages: declaredPages(),
    pageDirs: dirs,
    configuredDirs: dirs.filter((d) => existsSync(join(srcDir, d, "index.config.ts"))),
  });
  assert.deepEqual(problems, []);
  assert.ok(dirs.length >= 38, `落盘页面目录数异常：${dirs.length}`);
});

test("红证 1：registry 有页面、目录不存在", () => {
  const problems = checkMounting({
    pagesets: [{ key: "supply-chain.se", pages: [{ id: "se-ghost", path: "pages/se/ghost" }] }],
    declaredPages: ["pages/se/ghost"],
    pageDirs: [],
    configuredDirs: [],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\[未落盘\]/);
});

test("红证 2：页面落盘但没在 app.config 登记（Taro 找不到）", () => {
  const problems = checkMounting({
    pagesets: [{ key: "supply-chain.se", pages: [{ id: "se-x", path: "pages/se/x" }] }],
    declaredPages: [],
    pageDirs: ["pages/se/x"],
    configuredDirs: ["pages/se/x"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\[未登记\]/);
});

test("红证 3：页面目录存在但没有任何页面集注册（永远进不去）", () => {
  const problems = checkMounting({
    pagesets: [{ key: "supply-chain.se", pages: [] }],
    declaredPages: [],
    pageDirs: ["pages/se/orphan"],
    configuredDirs: ["pages/se/orphan"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\[孤儿页面\]/);
});

test("红证 4：缺 index.config.ts", () => {
  const problems = checkMounting({
    pagesets: [{ key: "supply-chain.se", pages: [{ id: "se-y", path: "pages/se/y" }] }],
    declaredPages: ["pages/se/y"],
    pageDirs: ["pages/se/y"],
    configuredDirs: [],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\[缺页面配置\]/);
});

test("底座页面（chat/login/cron 等）不参与页面集对账——只查四个业务面前缀", () => {
  const problems = checkMounting({
    pagesets: [{ key: "supply-chain.ue", pages: [] }],
    declaredPages: ["pages/chat/index", "pages/login/index"],
    pageDirs: ["pages/chat/index", "pages/login/index"],
    configuredDirs: ["pages/chat/index", "pages/login/index"],
  });
  assert.deepEqual(problems, []);
});
