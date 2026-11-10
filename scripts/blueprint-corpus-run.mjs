// 构造集驱动：把 CORPUS 逐条灌进真校验链，用 `expect` 判 pass/fail。
// 不烧模型、不写库、不碰生产 —— 只做「我以为会被拦的」vs「实际会被拦的」对齐。
//
//   node scripts/blueprint-corpus-run.mjs            # 全量
//   node scripts/blueprint-corpus-run.mjs 坏例         # 只跑名字含该串的
//   node scripts/blueprint-corpus-run.mjs --verbose   # 打印每条的错误原文
import { CORPUS } from "./blueprint-corpus.mjs";
import { validateBlueprint } from "../server/blueprint-validate.js";

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose");
const filter = argv.find((a) => !a.startsWith("--"));

let pass = 0;
let fail = 0;
const failures = [];

for (const c of CORPUS) {
  if (filter && !c.name.includes(filter)) continue;
  const out = validateBlueprint(c.content);
  const errs = out.errors ?? [];
  const entries = errs.map((e) => e.entry).filter(Boolean);
  const ok = c.expect === "valid" ? out.ok === true : out.ok === false;

  let entryOk = true;
  if (c.expect === "invalid" && c.expectEntry) {
    entryOk = entries.some((en) => String(en).startsWith(c.expectEntry));
  }

  const good = ok && entryOk;
  if (good) {
    pass += 1;
    console.log(`  ✓ ${c.name}${c.expect === "invalid" ? ` （拦于 ${c.expectEntry}）` : ""}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${c.name}`);
    console.log(`      expect=${c.expect}${c.expectEntry ? ` @${c.expectEntry}` : ""} got.ok=${out.ok}`);
    console.log(`      entries=${JSON.stringify(entries)}`);
    if (errs.length) console.log(`      errors=${JSON.stringify(errs.slice(0, 4))}`);
    failures.push(c.name);
  }
  if (verbose && errs.length) {
    for (const e of errs) console.log(`        · ${e.entry ?? "?"} :: ${e.error ?? e.message ?? JSON.stringify(e)}`);
  }
}

console.log(`\n${pass} 通过 / ${fail} 不符预期`);
if (failures.length) {
  console.log(`不符预期：${failures.join(" | ")}`);
  process.exitCode = 1;
}
