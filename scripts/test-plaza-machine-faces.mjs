// ── Plaza root machine faces land as a complete set ────────────────────────
//
//   node --test scripts/test-plaza-machine-faces.mjs
//
// 钉住的契约（fix-supply-machine-faces / agent-materials-plaza "Machine
// surfaces are generated from the registries' own public faces"）：
//   · 落位后站点根有四个机器面：llms.txt / llms-full.txt / catalog.json /
//     robots.txt，且前三份与 generated/ 逐字节相同；
//   · catalog.json 可解析且带 schema + generatedAt（机器面自带生成时间）；
//   · 导出物缺一份时落位失败，且站点根**保持上一版**（不成半套）——
//     这是「原子落位」的判据本体，不是脚本自报成功。
//
// 这里跑的是 deploy-plaza.sh 通过 ssh 送出的同一个 scripts/plaza-stage.sh。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(import.meta.dirname, "..");
const SITE = path.join(ROOT, "site-plaza");
const STAGE_SH = path.join(ROOT, "scripts", "plaza-stage.sh");
const GENERATED = path.join(SITE, "generated");

const HAVE_EXPORT = fs.existsSync(path.join(GENERATED, "catalog.json"));

/** Build a bundle the way deploy-plaza.sh does (same file list, same flags). */
function makeBundle({ dropExport = null } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-bundle-"));
  const src = path.join(work, "site-plaza");
  fs.cpSync(SITE, src, { recursive: true });
  if (dropExport) fs.rmSync(path.join(src, "generated", dropExport), { force: true });
  const tar = path.join(work, "site.tar.gz");
  execFileSync(
    "tar",
    ["--no-xattrs", "-czf", tar, "-C", src, "index.html", "style.css", "script.js", "locales", "generated", "deploy"],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  return { work, tar };
}

function stage(tar) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-stage-"));
  const dir = path.join(work, "site");
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("bash", [STAGE_SH, tar, dir], { stdio: "pipe" });
  return { work, dir };
}

test("the four root machine faces land, byte-identical to the export", { skip: !HAVE_EXPORT }, () => {
  const { tar } = makeBundle();
  const { dir } = stage(tar);

  for (const f of ["llms.txt", "llms-full.txt", "catalog.json", "robots.txt"]) {
    const p = path.join(dir, f);
    assert.ok(fs.existsSync(p), `${f} must land at the site root`);
    assert.ok(fs.statSync(p).size > 0, `${f} must not be empty`);
  }

  for (const f of ["llms.txt", "llms-full.txt", "catalog.json"]) {
    assert.ok(
      fs.readFileSync(path.join(dir, f)).equals(fs.readFileSync(path.join(GENERATED, f))),
      `${f} at root must be the generated file, byte for byte`,
    );
  }

  const catalog = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json"), "utf8"));
  assert.match(String(catalog.schema), /yizuo-agent-materials-plaza\/catalog@/);
  assert.ok(catalog.generatedAt, "catalog.json must carry its generation timestamp");

  assert.match(fs.readFileSync(path.join(dir, "robots.txt"), "utf8"), /llms\.txt/);

  // the site body moved too (pages + generated), so the faces are not alone
  assert.ok(fs.existsSync(path.join(dir, "index.html")), "index.html lands");
  assert.ok(fs.existsSync(path.join(dir, "generated", "counts.json")), "generated/ lands");
});

test("a bundle missing one export refuses to land and leaves the previous set intact", { skip: !HAVE_EXPORT }, () => {
  // First good deploy establishes a complete set.
  const { dir } = stage(makeBundle().tar);
  const before = fs.readFileSync(path.join(dir, "llms.txt"));

  // Then a bundle whose catalog is missing must fail...
  const { tar: broken } = makeBundle({ dropExport: "catalog.json" });
  let failed = false;
  try {
    execFileSync("bash", [STAGE_SH, broken, dir], { stdio: "pipe" });
  } catch {
    failed = true;
  }
  assert.equal(failed, true, "staging must exit non-zero when an export is missing");

  // ...and must not have disturbed the live set.
  assert.ok(fs.readFileSync(path.join(dir, "llms.txt")).equals(before), "previous llms.txt untouched");
  assert.ok(fs.existsSync(path.join(dir, "catalog.json")), "previous catalog.json still in place");
});
