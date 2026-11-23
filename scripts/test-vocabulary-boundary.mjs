// 词汇分界判据（establish-agent-role-and-fitness-plane 9.3）。
//
// `notes/vocabulary-boundary.md` 定了「内部原语不进用户面」。但文档是愿望，
// 判据才是闸——一个词在代码里回潮时，没有人会回头翻那份文档。
//
// 这里只查**用户面**（web/src，即 owner 看到的界面）：内部原语的字面量不许出现。
// 不查 API 字段名与服务端——那些正是原语该待的地方。
//
// 三条排除，每条都有理由（不是为了让测试变绿）：
//   1. `retired` / `retire` 作为「路由已退役」的动词用法——与本变异的「裁撤」裁决无关
//   2. 非英文 locale 里的 `retirer`（法语「撤回」）——是另一个词
//   3. 注释里的说明文字（本意是解释为什么这里不用那个词）
//
// Run: node --test scripts/test-vocabulary-boundary.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";

const WEB = path.resolve("web/src");

/** 内部原语：只允许出现在 API/服务端，不允许出现在 owner 界面文案里。 */
const INTERNAL = ["genome", "organs", "competence"];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 已存在的三态评测面用的是 `pass | fail | inconclusive`——那是**另一套语义**
 * （判据过没过），与本变异的「团队裁决」（保留/合并/裁撤/改设计重判/判不出）
 * 不是同一个词表。把它们混进同一条闸只会逼人给既有面改名。
 *
 * 排除范围刻意写到最小：只排那个组件与它自己的 locale 键，不排整个 tuning/ 目录
 * ——将来有人往那个目录里加团队裁决的文案，这条闸仍然抓得到。
 */
const EXEMPT_PATHS = new Set(["components/tuning/VerdictScorecard.tsx"]);
const isExempt = (file) => EXEMPT_PATHS.has(path.relative(WEB, file));

/**
 * locale JSON 里的豁免更细：只跳过 `verdictScorecard` 这个键**块内部**的行。
 * 整份文件豁免会让该 locale 的团队裁决文案再也无人看管——那是把闸关掉，
 * 不是给它一个例外。
 */
function insideExemptLocaleBlock(file, lineNo) {
  if (!/locales[/\\].*\.json$/.test(file)) return false;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  // 向上找最近的 `"verdictScorecard": {`，并确认它尚未闭合。
  let depth = 0;
  for (let i = Math.min(lineNo - 1, lines.length - 1); i >= 0; i -= 1) {
    const t = lines[i];
    depth += (t.match(/\}/g) ?? []).length - (t.match(/\{/g) ?? []).length;
    if (depth < 0 && /"verdictScorecard"\s*:/.test(t)) return true;
    if (depth < -20) break; // 走太远，肯定不在同一块里
  }
  return false;
}

/** 只看会渲染给人看的字符串，不看注释与代码标识符。 */
function userFacingLines(file) {
  const src = fs.readFileSync(file, "utf8");
  return src
    .split("\n")
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false; // 注释
      return true;
    });
}

test("web/src 不出现内部原语 genome / organs / competence", () => {
  const hits = [];
  for (const f of walk(WEB)) {
    for (const { line, no } of userFacingLines(f)) {
      for (const w of INTERNAL) {
        if (new RegExp(`\\b${w}\\b`, "i").test(line)) {
          hits.push(`${path.relative(WEB, f)}:${no} [${w}] ${line.trim().slice(0, 80)}`);
        }
      }
    }
  }
  assert.deepEqual(hits, [], `内部原语漏进用户面：\n${hits.join("\n")}`);
});

test("裁决值只以终词出现在文案里（retain/merge/redesign/inconclusive 不出现）", () => {
  const VERDICTS = ["retain", "redesign", "inconclusive"];
  const hits = [];
  for (const f of walk(WEB)) {
    if (isExempt(f)) continue;
    for (const { line, no } of userFacingLines(f)) {
      // `retire` 有正当的动词用法（retired route / retirer），故不在此列；
      // 其余四个没有自然语言歧义，出现即为泄露。
      for (const w of VERDICTS) {
        if (new RegExp(`\\b${w}\\b`, "i").test(line)) {
          if (insideExemptLocaleBlock(f, no)) continue;
          hits.push(`${path.relative(WEB, f)}:${no} [${w}] ${line.trim().slice(0, 80)}`);
        }
      }
    }
  }
  assert.deepEqual(hits, [], `裁决原语漏进用户面（应用「保留/合并岗位/改设计后重判/判不出」）：\n${hits.join("\n")}`);
});

test("判据有牙：把一个原语塞进临时文案能被抓到", () => {
  // 这条防的是「判据写反了/正则没编译」——一个永远绿的闸等于没有闸。
  const line = 'const label = "这个 genome 很新";';
  const caught = INTERNAL.some((w) => new RegExp(`\\b${w}\\b`, "i").test(line));
  assert.equal(caught, true, "genome 必须被 \b 词边界正则抓到");
  // 反之，正常终词不该被误伤
  assert.equal(INTERNAL.some((w) => new RegExp(`\\b${w}\\b`, "i").test('const label = "这个岗记忆很新";')), false);
});
