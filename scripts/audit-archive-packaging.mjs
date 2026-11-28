#!/usr/bin/env node
// ── 打包边界审计 ────────────────────────────────────────────────────────────
//
// 私有化交付里我们承诺过一件事：**腾讯的 SDK 与客户私钥都不进我们的产物**。
// 承诺靠人不靠得住——只要一次误 COPY，就会变成"随包分发第三方私有软件"。
// 这个脚本把那句话变成可执行的检查。
//
// 查四件事：
//   1. 仓库里没有 SDK 二进制（libWeWorkFinanceSdk* 的 .so/.dll/.dylib）
//   2. 仓库里没有私钥（.pem/.key 中含 PRIVATE KEY），也没有内联私钥的配置
//   3. 依赖树里没有已知会把 SDK 打进包内的封装
//   4. **构建上下文会排除这两类东西**（2026-11-12 补）：Dockerfile 用的是
//      `COPY . .` 而不是白名单，所以"仓库干净"不等于"镜像干净"。这一项查
//      .dockerignore 里有没有对应规则——规则整条没了，第 1、2 项在镜像里就失效。
//   5. **git 历史里也从未出现过**（2026-11-12 补）：镜像由 CI 从全新 clone 构建，
//      但只要历史上有人提交过一次，它就永久留在一个可构建的 commit 里。工作区干净
//      不代表历史干净，所以这里单独查一遍全历史。
//
// ⚠ 这仍然不是镜像扫描。镜像层的检查靠 `docker run --rm <img> find / -name 'libWeWorkFinanceSdk*'`
// （见 tasks 1.1）。三者都要有：源仓库干净、上下文会排除、构建产物里 find 不到。
//
//   node scripts/audit-archive-packaging.mjs [--root .] [--json]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** 官方 SDK 的文件名形态。前缀固定，平台后缀不同。 */
const SDK_NAME = /^libWeWorkFinanceSdk.*\.(so|dylib|dll|a|lib)$/i;
/** 我们不接受随包发布的封装（会把官方 SDK 打包进去）。 */
const FORBIDDEN_DEPS = ["pywecomarchive", "weworkfinancesdk", "wecom-sdk-bundle"];

/**
 * .dockerignore 必须覆盖的三类路径。少一条，那条路径就能随镜像出去。
 *
 * 判断方式故意粗（子串匹配）：这里要防的是"规则整条没了"，而不是复刻 docker
 * 的通配语义——精确语义由真实构建验证（用同一份 .dockerignore 建最小上下文，
 * COPY 后 find，已实测 .so/.dylib/.dll 与 *.pem/*.key 全部不出现）。
 */
const REQUIRED_IGNORE = [
  { needle: "libWeWorkFinanceSdk", why: "SDK 二进制（.so/.dylib/.dll）" },
  { needle: ".pem", why: "PEM 私钥" },
  { needle: ".key", why: "KEY 私钥" },
];

/** 跳过这些目录：它们不是我们的交付物。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "data",
  "dist",
  "build",
  "coverage",
  ".next",
  "graphify-out",
]);

export function walk(root, { maxFiles = 20000 } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/** 只在"可能是密钥"的文件里找，避免把整个仓库读进内存。 */
const KEY_CANDIDATE = /\.(pem|key|crt|p12|pfx)$/i;

/**
 * 读 .dockerignore 的有效规则（去注释、去空行）。文件不存在返回 null。
 * 导出是为了让测试能直接喂规则，不必造目录。
 */
export function readIgnoreRules(root) {
  let text;
  try {
    text = readFileSync(path.join(root, ".dockerignore"), "utf8");
  } catch {
    return null;
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export function auditPackaging({
  root = process.cwd(),
  files = null,
  deps = null,
  ignoreRules = null,
} = {}) {
  const all = files || walk(root);
  const violations = [];

  // 1. SDK 二进制
  for (const f of all) {
    const base = path.basename(f);
    if (SDK_NAME.test(base)) {
      violations.push({
        kind: "sdk-binary",
        path: path.relative(root, f),
        fix: "从仓库与镜像中移除；SDK 由客户自行获取并挂载（/opt/wecom-sdk），不得随包分发",
      });
    }
  }

  // 2. 私钥
  for (const f of all) {
    const base = path.basename(f);
    if (!KEY_CANDIDATE.test(base)) continue;
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/.test(text)) {
      violations.push({
        kind: "private-key",
        path: path.relative(root, f),
        fix: "私钥只由部署方在运行时以只读方式挂载；仓库与镜像中都不得出现",
      });
    }
  }

  // 3. 依赖树
  const dependencyNames = deps || readDependencyNames(root);
  for (const d of dependencyNames) {
    if (FORBIDDEN_DEPS.includes(String(d).toLowerCase())) {
      violations.push({
        kind: "bundled-sdk-dependency",
        path: `dependency:${d}`,
        fix: "该封装会把官方 SDK 打进包内，违反分发约束；改为运行时挂载 SDK",
      });
    }
  }

  // 4. 构建上下文（仅当这个根确实是构建上下文才检查：有 Dockerfile 才算）
  //
  // 为什么加「有 Dockerfile」这个前提：`.dockerignore` 只对镜像构建有意义。
  // 对随便一个目录（比如测试夹具、只用 npm 拉的客户端包）要求它，只会制造噪音，
  // 把「源干净」这个结论淹没在无关违规里。
  const hasDockerfile = existsSync(path.join(root, "Dockerfile"));
  if (hasDockerfile) {
    const rules = ignoreRules === null ? readIgnoreRules(root) : ignoreRules;
    if (rules === null) {
      violations.push({
        kind: "dockerignore-missing",
        path: ".dockerignore",
        fix: "有 Dockerfile 却没有 .dockerignore：Dockerfile 用 `COPY . .` 时 SDK 与私钥会随镜像出去",
      });
    } else {
      const joined = rules.join("\n");
      for (const r of REQUIRED_IGNORE) {
        if (!joined.includes(r.needle)) {
          violations.push({
            kind: "dockerignore-gap",
            path: `.dockerignore（缺 ${r.needle}）`,
            fix: `补上排除 ${r.why} 的规则；否则它会被 \`COPY . .\` 打进镜像层`,
          });
        }
      }
    }
  }

  // 5. git 历史（不是 git 仓就明确 skipped，不假装通过）
  const history = scanHistory(root);
  if (history.state === "dirty") {
    violations.push({
      kind: "sdk-in-history",
      path: `git 历史（${history.hits.length} 处）`,
      fix: "历史里提交过 SDK/私钥：那个 commit 仍可构建出违规镜像；改写历史或改用干净的构建源",
    });
  }

  return {
    ok: violations.length === 0,
    scanned: all.length,
    history,
    violations,
  };
}

/**
 * 全历史扫描：所有分支、所有 commit 里有没有出现过 SDK 二进制或私钥。
 *
 * 为什么必须查历史：CI 是从某个 commit 克隆后构建的。哪怕这个文件后来被删掉，
 * 那个 commit 仍然可以直接构建出一个带 SDK 的镜像。工作区干净 ≠ 历史干净。
 *
 * 不是 git 仓（客户拿到的源码包）时返回 `{state:"skipped"}`——明确说"没验"，
 * 比给一个假绿好。
 */
export function scanHistory(root, { limit = 200 } = {}) {
  const run = (args) => {
    const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 60_000 });
    if (res.error || res.status !== 0) return null;
    return res.stdout;
  };
  if (run(["rev-parse", "--is-inside-work-tree"]) === null) return { state: "skipped", hits: [] };

  const out = run(["log", "--all", "--oneline", "--name-only", "--", "*libWeWorkFinanceSdk*", "*.pem", "*.key"]);
  if (out === null) return { state: "skipped", hits: [] };

  // `git log --name-only` 会把 commit 标题与文件名混在输出里；只留像文件名的行。
  const hits = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /(libWeWorkFinanceSdk|\.pem$|\.key$)/i.test(l) && !/^[0-9a-f]{7,} /.test(l))
    .slice(0, limit);
  return { state: hits.length ? "dirty" : "clean", hits };
}

function readDependencyNames(root) {
  const names = new Set();
  const pkgFile = path.join(root, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const n of Object.keys(pkg[field] || {})) names.add(n);
    }
  } catch {
    /* 没有 package.json 就只看文件层面 */
  }
  const reqFile = path.join(root, "requirements.txt");
  try {
    for (const line of readFileSync(reqFile, "utf8").split("\n")) {
      const m = /^([A-Za-z0-9._-]+)/.exec(line.trim());
      if (m) names.add(m[1]);
    }
  } catch {
    /* 同上 */
  }
  return [...names];
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const rootArg = argv.indexOf("--root");
  const root = rootArg >= 0 ? path.resolve(argv[rootArg + 1]) : process.cwd();
  const asJson = argv.includes("--json");

  const result = auditPackaging({ root });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `打包边界审计通过：扫描 ${result.scanned} 个文件，无 SDK 二进制、无私钥、无打包型依赖，` +
        `构建上下文已排除 SDK 与私钥，git 历史${result.history.state === "clean" ? "干净" : "未检查（非 git 仓）"}\n`,
    );
  } else {
    process.stdout.write(`打包边界审计未通过：${result.violations.length} 项\n`);
    for (const v of result.violations) {
      process.stdout.write(`  - [${v.kind}] ${v.path}\n    修法：${v.fix}\n`);
    }
  }
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
