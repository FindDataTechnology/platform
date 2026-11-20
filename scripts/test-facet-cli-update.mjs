#!/usr/bin/env node
// ── CLI install-record + update tests (add-facet-cli-update, F2.3) ───────────
//
// Runs the real CLI against a stub facet market in an isolated FACET_HOME:
// install lands the record; update's three verdicts (已最新 / v旧→v新 /
// vanished pack) and its zero-subscription write path are asserted from the
// files on disk.
//
//   node --test scripts/test-facet-cli-update.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const tmp = mkdtempSync(path.join(tmpdir(), "facet-update-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const CLI = path.resolve("facet/cli/facet.js");

// A stub facet market: pack detail (version switchable) + skill md endpoint.
function stubMarket() {
  const state = { packs: {} }; // id → { detail | null }  (null = unpublished)
  const app = express();
  app.get("/api/packs/:id", (req, res) => {
    const p = state.packs[req.params.id];
    if (!p) return res.status(404).json({ error: "Pack not found" });
    res.json(p.detail);
  });
  app.get("/api/packs/:id/versions/:v/skills/:name.md", (req, res) => {
    const p = state.packs[req.params.id];
    if (!p) return res.status(404).end();
    res.set("Content-Type", "text/markdown").send(`---\nname: "${req.params.name}"\ndescription: "v${req.params.v} body"\n---\n\n# ${req.params.name} v${req.params.v}\n`);
  });
  const server = http.createServer(app).listen(0);
  return {
    state,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

const packV = (id, version, name = `pack ${id}`) => ({
  id, name, version, visibility: "public",
  manifest: { skills: [{ name: `${id}-skill`, description: "d" }] },
});

function newHome() {
  return path.join(tmp, `home-${Math.random().toString(36).slice(2)}`);
}

async function facet(args, { expectFail = false, home = newHome() } = {}) {
  const env = { ...process.env, FACET_HOME: home };
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env });
    return { code: 0, stdout, home };
  } catch (e) {
    if (!expectFail) throw e;
    return { code: e.code ?? 1, stdout: String(e.stdout || ""), stderr: String(e.stderr || ""), home };
  }
}

const skillFile = (home, target, name) =>
  readFileSync(path.join(home, { "claude-code": ".claude", cursor: ".cursor", zcode: ".zcode", codex: ".codex", "gemini-cli": ".gemini" }[target], "skills", name, "SKILL.md"), "utf8");

test("install records; update reports 已最新 / upgrades / vanished per pack", async () => {
  const market = await stubMarket();
  market.state.packs["pk-a"] = { detail: packV("pk-a", 1) };
  market.state.packs["pk-b"] = { detail: packV("pk-b", 2) };
  const base = ["--base", market.base];
  const home = newHome();

  // Install two packs into one isolated home (different targets prove the
  // record keys on target too).
  const i1 = await facet(["install", "pk-a", ...base], { home });
  assert.match(i1.stdout, /v1 → claude-code/);
  const i2 = await facet(["install", "pk-b", "--target", "zcode", ...base], { home });
  assert.match(i2.stdout, /v2 → zcode/);
  const rec = JSON.parse(readFileSync(path.join(home, ".facet", "installed.json"), "utf8"));
  assert.equal(rec.installs.length, 2);
  assert.deepEqual(rec.installs.map((r) => [r.packId, r.target, r.version]).sort(), [["pk-a", "claude-code", 1], ["pk-b", "zcode", 2]]);

  // Update with nothing changed: both 已最新, nothing rewritten.
  const up0 = await facet(["update", ...base], { home });
  assert.match(up0.stdout, /pk-a.*已最新 v1/);
  assert.match(up0.stdout, /pk-b.*已最新 v2/);
  assert.match(up0.stdout, /没有需要更新的安装/);
  assert.equal(skillFile(home, "claude-code", "pk-a-skill").includes("v1 body"), true);

  // Publish newer versions; one pack vanishes. update refreshes the former
  // with version reporting and reports the latter honestly.
  market.state.packs["pk-a"] = { detail: packV("pk-a", 3) };
  market.state.packs["pk-b"] = { detail: null };
  // 0.4.1 起「部分失败」的退出码为非零（一笔消失 ⇒ $? 必须能反映），
  // 所以这里按失败期望来取 stdout 并单独断言退出码。
  const up1 = await facet(["update", ...base], { home, expectFail: true });
  assert.equal(up1.code, 1, "有消失的包 ⇒ 退出码非零（0.4.1 行为）");
  assert.match(up1.stdout, /pk-a.*v1 → v3/);
  assert.match(up1.stdout, /1 笔更新/);
  assert.match(up1.stdout, /pk-b.*已不可解析/);
  assert.match(up1.stdout, /1 笔失败/, "并且如实报出失败笔数");
  assert.equal(skillFile(home, "claude-code", "pk-a-skill").includes("v3 body"), true, "skills rewrote to v3");
  const rec2 = JSON.parse(readFileSync(path.join(home, ".facet", "installed.json"), "utf8"));
  assert.deepEqual(rec2.installs.map((r) => [r.packId, r.version]).sort(), [["pk-a", 3], ["pk-b", 2]]);

  // A narrowed update by packRef + target.
  market.state.packs["pk-a"] = { detail: packV("pk-a", 4) };
  const up2 = await facet(["update", "pk-a", "--target", "claude-code", ...base], { home });
  assert.match(up2.stdout, /v3 → v4/);

  // Reinstall over the same target updates the record in place (no dupes).
  const again = await facet(["install", "pk-a", ...base], { home });
  void again;
  const rec3 = JSON.parse(readFileSync(path.join(home, ".facet", "installed.json"), "utf8"));
  assert.equal(rec3.installs.filter((r) => r.packId === "pk-a").length, 1);
  assert.equal(existsSync(path.join(home, ".facet", "credentials.json")), false, "update/install never touch credentials");

  await market.close();
});

test("a failed update exits non-zero (0.4.1: $? must reflect the ✗)", async () => {
  // 0.4.0 之前：打 ✗ 就 continue，退出码仍 0，脚本化调用会把失败当成功。
  // 这条钉住修复后的契约：只要有一笔失败，$? 必须非零，且文案说清几笔失败。
  const market = await stubMarket();
  market.state.packs["pk-gone"] = { detail: null }; // 下架/私有/网络 不可解析
  const base = ["--base", market.base];
  const home = newHome();

  await facet(["install", "pk-gone", ...base], { home }).catch(() => {}); // 装不上也没关系，下面手写记录
  const recPath = path.join(home, ".facet", "installed.json");
  const fsmod = await import("node:fs");
  fsmod.mkdirSync(path.dirname(recPath), { recursive: true });
  fsmod.writeFileSync(
    recPath,
    JSON.stringify({
      installs: [
        { packId: "pk-gone", name: "Gone", target: "claude-code", scope: "用户级", project: null, version: 2, base: market.base, installedAt: "2026-11-01T00:00:00Z" },
      ],
    }),
  );

  const out = await facet(["update", ...base], { home, expectFail: true });
  assert.equal(out.code, 1, "有一笔失败 ⇒ 退出码非零");
  assert.match(out.stdout, /已不可解析/);
  assert.match(out.stdout, /1 笔失败/, "文案如实报出失败笔数");

  // 全成功时仍必须是 0（别把修复做成「一律非零」）
  market.state.packs["pk-ok"] = { detail: packV("pk-ok", 5) };
  fsmod.writeFileSync(
    recPath,
    JSON.stringify({
      installs: [
        { packId: "pk-ok", name: "Ok", target: "claude-code", scope: "用户级", project: null, version: 4, base: market.base, installedAt: "2026-11-01T00:00:00Z" },
      ],
    }),
  );
  const ok = await facet(["update", ...base], { home });
  assert.equal(ok.code, 0, "全成功 ⇒ 退出码 0");
  assert.match(ok.stdout, /v4 → v5/);

  await market.close();
});

test("update with no records says so honestly", async () => {
  const market = await stubMarket();
  const out = await facet(["update", "--base", market.base]);
  assert.match(out.stdout, /本地无安装记录/);
  const out2 = await facet(["update", "pk-none", "--base", market.base]);
  void out2; // no records → the same honest line
  await market.close();
});
