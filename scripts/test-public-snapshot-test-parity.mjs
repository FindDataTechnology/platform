#!/usr/bin/env node
// ── 快照排除清单 × 测试读路径：两边的判据必须对得上 ──────────────────────────
//
// 2026-11-14 实历：镜像仓（scs001/platform-image-verify）的 CI 从本轮第一次出片
// 起连续 5 轮红，而出片本身不需要 CI 绿（image-publish 与 CI 是两条 workflow），
// 于是「红着出片」两个多小时没人看见。原因不是产品缺陷，是**快照排除清单与测试
// 的读路径脱钩**：
//
//   - `scripts/probe-*.mjs` 按 GLOB 排除 → `test-agent-runner-identity.mjs` 无条件
//     readFileSync 这两个探针 ⇒ unit 分片 ENOENT；
//   - `services/ops-console/` 按 PREDIX 排除 → `test-ops-console-board.mjs` 无条件
//     import ⇒ 同一形态。
//
// 本地永远绿（本地有那两个文件/目录），所以这条只能靠「比对两张清单」判。判据刻意
// 保守：只认**字面量路径**（`path.join(ROOT, "a", "b")` / `new URL("../x",
// import.meta.url)` / `import("../x")`），且只在「这个路径在工作树里真实存在」时
// 才报——这样不会因为注释或拼出来的路径产生噪声。
//
// 例外只有一种：读之前有 `existsSync` 守卫（含 `crossRepoFixture()` 这类封装在
// 20 行内的形态）。守卫是合法的——「在场就必须一致，缺席即在此树不可判」正是
// 探针副本该有的判据；无条件读才是缺陷。
//
//   node --test scripts/test-public-snapshot-test-parity.mjs
//
// 判不出（解析不到排除清单）时 FAIL，不静默通过：清单改名/改形会让这条闸变成
// 「扫了 0 条规则所以绿」，那是比红更坏的形态。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const BUILDER = path.join(ROOT, "scripts", "make-public-snapshot.mjs");

/** 取出 `const NAME = new Set([ … ]);` / `const NAME = [ … ];` 里的双引号字面量。 */
function blockLiterals(src, name) {
  const start = src.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `make-public-snapshot.mjs 里找不到 ${name} —— 闸判不出，先修这里`);
  const open = src.indexOf("[", start);
  assert.ok(open > start);
  // 括号配平扫到对应的 `]`（字面量里没有方括号，注释里的也不会成对到失衡）。
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > open, `${name} 的数组没有闭合`);
  const body = src.slice(open + 1, end);
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

// builder 自己也在 EXCLUDE_PATHS 里（它写着内部拓扑）⇒ 公开快照里没有可比对的清单。
// 那种树上本闸不可判：显式 skip 并写明原因，不让它变成「扫了 0 条所以绿」。
const BUILDER_HERE = existsSync(BUILDER);
const builderSrc = BUILDER_HERE ? readFileSync(BUILDER, "utf8") : "";
// 解析必须在 builder 缺席时**不执行**：解析失败是 assert 抛错，而模块顶层的抛错会让
// 整个文件在公开快照里变成"测试文件加载失败"——本闸自己的第一次出片就这么红的
// （2026-11-14，镜像仓 shard 5/8）。缺席时下面两个用例整体 skip。
const EXCLUDE_PATHS = BUILDER_HERE ? new Set(blockLiterals(builderSrc, "EXCLUDE_PATHS")) : new Set();
const PREFIXES = BUILDER_HERE
  ? [...blockLiterals(builderSrc, "EXCLUDE_PREFIXES"), ...blockLiterals(builderSrc, "EXCLUDE_PREFIXES_EXTRA")]
  : [];
const GLOBS = (BUILDER_HERE ? blockLiterals(builderSrc, "EXCLUDE_GLOBS") : []).map((g) => {
  const src = g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(g.includes("**") ? ".*" : "[^/]*");
  return new RegExp(`^${src}$`);
});

function isExcluded(rel) {
  if (EXCLUDE_PATHS.has(rel)) return true;
  if (PREFIXES.some((p) => rel === p.replace(/\/$/, "") || rel.startsWith(p))) return true;
  if (GLOBS.some((re) => re.test(rel))) return true;
  return false;
}

// 解析到的规则条数必须够多——否则是「清单改形，闸扫了 0 条」的假绿。
const SKIP_NO_BUILDER = BUILDER_HERE
  ? false
  : "make-public-snapshot.mjs 本身被排除：公开快照里没有清单可比对（在此树不可判）";

test("闸自检：排除清单解析得到足够条目", { skip: SKIP_NO_BUILDER }, () => {
  assert.ok(EXCLUDE_PATHS.size >= 20, `EXCLUDE_PATHS 只解析到 ${EXCLUDE_PATHS.size} 条`);
  assert.ok(PREFIXES.length >= 10, `前缀只解析到 ${PREFIXES.length} 条`);
  assert.ok(GLOBS.length >= 3, `GLOB 只解析到 ${GLOBS.length} 条`);
  // 正样本：今天是这几个；改动它们时这条跟着改，别默默放宽。
  for (const known of ["AGENTS.md", "services/ops-console/", "docs/adr/"]) {
    assert.ok(PREFIXES.includes(known) || EXCLUDE_PATHS.has(known), `${known} 不在排除清单里 —— 解析口径变了？`);
  }
  assert.ok(isExcluded("scripts/probe-deployment-secrets.mjs"), "GLOB scripts/probe-*.mjs 未生效");
});

const GUARD_WINDOW = 20;
const PATH_JOIN = /path\.(?:join|resolve)\(\s*(?:ROOT|REPO|ROOT_DIR|REPO_ROOT)\s*((?:,\s*"[^"]*")+)\s*\)/g;const URL_REL = /new URL\(\s*"((?:\.\.?\/)[^"]*)"\s*,\s*import\.meta\.url\s*\)/g;
const DYN_IMPORT = /(?:await\s+)?import\(\s*"(\.[^"]*)"\s*\)/g;

function candidates(src) {
  const out = [];
  for (const m of src.matchAll(PATH_JOIN)) {
    const segs = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    out.push({ index: m.index, rel: path.posix.normalize(segs.join("/")) });
  }
  for (const m of src.matchAll(URL_REL)) {
    // new URL 相对于本文件所在目录（scripts/）
    out.push({ index: m.index, rel: path.posix.normalize(path.posix.join("scripts", m[1])) });
  }
  for (const m of src.matchAll(DYN_IMPORT)) {
    out.push({ index: m.index, rel: path.posix.normalize(path.posix.join("scripts", m[1])) });
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

function guarded(src, index) {
  const lines = src.split("\n");
  const at = lineOf(src, index) - 1;
  const from = Math.max(0, at - GUARD_WINDOW);
  const to = Math.min(lines.length, at + GUARD_WINDOW);
  const window = lines.slice(from, to).join("\n");
  // 两种守卫都算：读之前的 existsSync，或 test(..., { skip: … }, …) 形态。
  if (/existsSync\s*\(/.test(window) || /\bskip:/.test(window)) return true;

  // 第三种（2026-11-16 补）：**同名常量在别处的守卫**。上面那个 ±20 行窗口是邻近性启发式，
  // 它把「先声明路径常量、几十行之后在取数函数里守一次」的写法判成无守卫——实历
  // `test-openspec-archive-hygiene.mjs`：读点在 48 行、守卫在 77 行（`if (!existsSync(CHANGES)) return []`），
  // 差 29 行落在窗口外，于是这条闸把一份**本来有守卫**的文件报成「镜像仓必红」。
  // 那是闸自己的假红：它会让一条正确的写法永远红下去，而常年红的闸会被无视。
  // 判据：读点这一行若在给某个名字赋值（`const X = path.join(…)`），全文件内出现
  // `existsSync(X` 即算守卫——检查的是同一个名字，不是相邻的行。
  const declared = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[at] ?? "");
  if (declared) {
    const name = declared[1].replace(/\$/g, "\\$");
    if (new RegExp(`existsSync\\s*\\(\\s*${name}\\b`).test(src)) return true;
  }
  return false;
}

// 自证两臂：这条判据（含上面第三种的放宽）必须能红，也必须不把「远端守卫」判成无守卫。
// 历史：第一版只认 ±20 行窗口 ⇒ test-openspec-archive-hygiene.mjs 的守卫在 29 行外，
// 于是把有守卫的写法报成必红（一条让正确写法永远红的假红）。
test("守卫判据自证：邻近 / 同名常量 / 无守卫 三态", () => {
  const near = ["const DIR = ROOT + '/x';", "if (!existsSync(DIR)) return;", "for (const f of readdirSync(DIR)) {}"].join("\n");
  assert.equal(guarded(near, near.indexOf("readdirSync(DIR)")), true, "邻近 existsSync 应算守卫");

  const far = [
    "const CHANGES = path.join(REPO, 'openspec', 'changes');",
    ...Array.from({ length: 30 }, (_, i) => `// filler ${i}`),
    "function list() {",
    "  if (!existsSync(CHANGES)) return [];",
    "  return readdirSync(CHANGES);",
    "}",
  ].join("\n");
  assert.equal(
    guarded(far, far.indexOf("path.join(REPO")),
    true,
    "同名常量在 30 行之外被 existsSync 守过，也算守卫（本条是 2026-11-16 的假红来源）",
  );

  const none = ["const DIR = path.join(ROOT, 'secret');", ...Array.from({ length: 30 }, (_, i) => `// filler ${i}`), "readdirSync(DIR);"].join("\n");
  assert.equal(guarded(none, none.indexOf("path.join(ROOT")), false, "没有守卫就必须是 false——否则这条闸什么也不挡");
});

// ── CI 安装步骤 × 快照排除：同一族缺陷的第二个面（2026-11-16 补）──────────────
//
// 上面那条只比对「测试读的路径」。但镜像仓的 unit job 会先跑
// `npm --prefix app ci --ignore-scripts` 与 `npm --prefix facet/web install`——这两条
// 读的是那两个目录的 package.json / package-lock.json。若哪天有人把 `app/` 或
// `facet/web/` 按前缀排除进快照，镜像仓 unit job 会死在 npm ci（lockfile 不在），
// 而**测试读路径一条都不涉及那两个目录**，于是上面那条闸照样绿。
// 判据：ci.yml 里每个 `npm --prefix <dir>` 的相对目录，其 package.json 与
// package-lock.json 都不许落在排除范围内。绝对路径/变量（`$HOME/.dsh-matrix`）跳过。
const CI_YML = path.join(ROOT, ".github", "workflows", "ci.yml");

function installPrefixes(yamlText) {
  const out = new Set();
  for (const m of yamlText.matchAll(/npm\s+--prefix\s+("[^"]+"|\S+)\s+(?:ci|install)\b/g)) {
    const dir = m[1].replace(/^"|"$/g, "").replace(/\/+$/, "");
    if (dir.startsWith("$") || dir.startsWith("/")) continue; // 不在快照里的绝对路径
    out.add(dir);
  }
  return [...out].sort();
}

/** 纯判据（便于自证）：返回「被快照排除、而 CI 要装」的文件清单。 */
function installPathViolations(yamlText, isExcl) {
  const bad = [];
  for (const dir of installPrefixes(yamlText)) {
    for (const f of ["package-lock.json", "package.json"]) {
      if (isExcl(`${dir}/${f}`)) bad.push(`${dir}/${f}`);
    }
  }
  return bad;
}

test("安装路径判据自证：排除清单盖住 app/ 时必须报出来", () => {
  const yml = [
    "run: npm --prefix app ci --ignore-scripts",
    "run: npm --prefix facet/web install --ignore-scripts",
    'run: npm --prefix "$HOME/.dsh-matrix" ci',
  ].join("\n");
  assert.deepEqual(installPrefixes(yml), ["app", "facet/web"], "绝对路径/变量形态不该进来");
  assert.deepEqual(
    installPathViolations(yml, (rel) => rel.startsWith("app/")),
    ["app/package-lock.json", "app/package.json"],
    "app/ 被排除时必须报出两个 lockfile 声明",
  );
  assert.deepEqual(installPathViolations(yml, () => false), [], "什么都没排除却报红 ⇒ 这条闸会常年红");
});

test("CI 安装步骤读的 lockfile 不许被快照排除", { skip: SKIP_NO_BUILDER }, () => {
  const yml = readFileSync(CI_YML, "utf8");
  const dirs = installPrefixes(yml);
  assert.ok(dirs.length >= 2, `只解析到 ${dirs.length} 个 --prefix 安装目录 —— 判不出，不是通过`);
  assert.ok(dirs.includes("app"), "ci.yml 里没解析到 `npm --prefix app` —— 解析口径变了？");

  const missing = dirs.filter((d) => !existsSync(path.join(ROOT, d, "package.json")));
  assert.deepEqual(missing, [], `CI 要装的目录在本树里没有 package.json：${missing.join(", ")}`);

  const bad = installPathViolations(yml, isExcluded);
  assert.deepEqual(
    bad,
    [],
    `这些文件被快照排除，而镜像仓 CI 的安装步骤要读它们（unit job 会死在 npm ci）：\n` +
      bad.map((r) => `  ${r}`).join("\n") +
      `\n修法：把该目录从 make-public-snapshot.mjs 的排除清单里去掉；确实不能进公开仓的，` +
      `就把 ci.yml 里那条安装步骤也一起去掉 —— 别只改一边。`,
  );
});

// ── 同族第三处声明：workflow 里的 `cache-dependency-path`（2026-11-16 补）────────
//
// `app-build.yml` / `app-e2e.yml` / `miniapp-ci.yml` 都随快照发布，它们用
// `actions/setup-node` 的 `cache-dependency-path` 指定 lockfile。路径解不出时 setup-node
// 直接失败（"Some specified paths were not resolved"），那种红看起来像「缓存坏了」，
// 而真正的原因是排除清单动了。glob（`**/package-lock.json`）不算——解不出具体文件。
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");

function cachePathDeclarations(yamlText) {
  const out = [];
  const lines = yamlText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)cache-dependency-path:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[2].trim();
    if (inline && inline !== "|" && inline !== ">") {
      out.push(...inline.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")));
      continue;
    }
    // 块标量（`|` / `>`）：后续比本行更深缩进的行才是值
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (!raw.trim()) continue;
      if (raw.search(/\S/) <= m[1].length) break;
      out.push(raw.trim().replace(/^["']|["']$/g, ""));
    }
  }
  return out.filter((p) => p && !p.includes("*"));
}

function cachePathViolations(yamlText, isExcl) {
  return cachePathDeclarations(yamlText).filter((p) => isExcl(p));
}

test("cache 路径判据自证：内联 / 块标量 / glob 三态", () => {
  const yml = [
    "          cache-dependency-path: miniapp/package-lock.json",
    "          cache-dependency-path: |",
    "            app/package-lock.json",
    "            package-lock.json",
    "          cache-dependency-path: '**/package-lock.json'",
    "      - name: next step",
  ].join("\n");
  assert.deepEqual(
    cachePathDeclarations(yml),
    ["miniapp/package-lock.json", "app/package-lock.json", "package-lock.json"],
    "块标量要逐行取、glob 要丢掉",
  );
  assert.deepEqual(
    cachePathViolations(yml, (rel) => rel.startsWith("app/")),
    ["app/package-lock.json"],
    "只报真的被排除的那一条",
  );
  assert.deepEqual(cachePathViolations(yml, () => false), [], "什么都不排除却报红 ⇒ 会常年红");
});

test("随快照发布的 workflow 里，cache 路径不许被排除", { skip: SKIP_NO_BUILDER }, () => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
  assert.ok(files.length >= 10, `只扫到 ${files.length} 个 workflow —— 判不出`);

  const shipped = files.filter((f) => !isExcluded(`.github/workflows/${f}`));
  assert.ok(shipped.length >= 3, `随快照发布的 workflow 只剩 ${shipped.length} 个 —— 判不出`);

  const bad = [];
  let declared = 0;
  for (const f of shipped) {
    const rel = `.github/workflows/${f}`;
    const decls = cachePathDeclarations(readFileSync(path.join(WORKFLOW_DIR, f), "utf8"));
    declared += decls.length;
    for (const p of decls) {
      if (isExcluded(p)) bad.push(`${rel} → ${p}（被快照排除）`);
      else if (!existsSync(path.join(ROOT, p))) bad.push(`${rel} → ${p}（本树里不存在）`);
    }
  }
  assert.ok(declared >= 3, `只解析到 ${declared} 条 cache 路径声明 —— 判不出，不是通过`);
  assert.deepEqual(bad, [], `这些 cache 路径活不过快照（镜像仓 setup-node 会红）：\n  ${bad.join("\n  ")}`);
});

test("快照排除清单与测试读路径不冲突（镜像仓 CI 不得因排除而红）", { skip: SKIP_NO_BUILDER }, () => {
  const files = readdirSync(HERE).filter((f) => f.startsWith("test-") && f.endsWith(".mjs")).sort();
  assert.ok(files.length >= 100, `只扫到 ${files.length} 个测试文件 —— 判不出`);

  const violations = [];
  let checked = 0;
  for (const file of files) {
    const relFile = `scripts/${file}`;
    if (isExcluded(relFile)) continue; // 测试自己就被排除 ⇒ 镜像仓里根本不存在
    if (relFile === "scripts/test-public-snapshot-test-parity.mjs") continue; // 本闸读 builder 就是它的职责
    const src = readFileSync(path.join(HERE, file), "utf8");
    for (const c of candidates(src)) {
      const outside = c.rel.startsWith("..");
      const excluded = !outside && isExcluded(c.rel);
      if (!outside && !excluded) continue;
      // 「在工作树里真实存在」才报：拼出来的名字、注释里的例子都不算。
      const full = path.join(ROOT, c.rel);
      if (!outside && !existsSync(full)) continue;
      checked++;
      if (guarded(src, c.index)) continue;
      violations.push({ file: relFile, line: lineOf(src, c.index), rel: c.rel, why: outside ? "在仓外（快照里必然没有）" : "被快照排除" });
    }
  }

  // 反空判：必须至少核过一个「确实落在排除范围/仓外」的读点，否则是扫空了。
  assert.ok(checked >= 1, "一个落在排除范围的读点都没核到 —— 解析口径可能失效（判不出，不是通过）");

  assert.deepEqual(
    violations,
    [],
    `以下测试在本地能读、在公开快照里读不到（镜像仓 unit 分片必红）：\n` +
      violations.map((v) => `  ${v.file}:${v.line}  ${v.rel}  —— ${v.why}`).join("\n") +
      `\n修法二选一：① 读之前用 existsSync 守卫（缺席即在此树不可判，别 skip 成通过）；` +
      `② 该测试本身是内部服务的测试，就把测试加进 make-public-snapshot.mjs 的 EXCLUDE_PATHS。`,
  );
});
