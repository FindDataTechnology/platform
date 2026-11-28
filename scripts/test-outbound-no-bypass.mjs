// 对外发送的结构性无旁路检查 (add-principal-disclosure-gate 1.2/1.3)
//
// 行为测试只能证明「走过的路有闸」；这个文件检查「没走过闸的路不存在凭据」。
// 两者缺一：前者漏旁路，后者漏行为。
//
// 断言三类事实：
//   1. 各渠道适配器的 sendText 把凭据作为**入参**接收（模块级不留令牌）；
//   2. 闸模块自己不发送任何东西（没有 fetch / http 客户端）；
//   3. 主动外发与回合回复都经过同一个门（源码层面钉住调用点）。
//
// Run: node --test scripts/test-outbound-no-bypass.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url).pathname;
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const ADAPTERS = readdirSync(path.join(root, "server/bots")).filter((f) => f.endsWith(".js") && f !== "adapter.js" && f !== "qr.js");

test("1.2 every channel adapter takes credentials per call, never from module scope", () => {
  for (const file of ADAPTERS) {
    const src = read(`server/bots/${file}`);
    if (!src.includes("sendText")) continue;
    assert.match(
      src,
      /sendText\s*\(\s*cred/,
      `${file}: sendText must take credentials as its first parameter (module-level tokens are a bypass source)`,
    );
    // 模块级凭据常量不该出现。这里允许一种已知形态：**派生令牌缓存**——它按
    // appId 分键、内容由调用时传入的凭据换取（feishu 的 tenant_access_token），
    // 不含调用方凭据本身。判据是「缓存键来自 cred」，不是「名字里有没有 token」。
    const moduleLevelSecret = /^(?:export\s+)?(?:const|let|var)\s+(\w*(?:TOKEN|SECRET|KEY)\w*)\s*=/gim.exec(src);
    if (moduleLevelSecret) {
      const name = moduleLevelSecret[1];
      const derivedCache = new RegExp(`const\\s+${name}\\s*=\\s*new Map\\(\\)`).test(src);
      // 一处**已审并判定保留**的例外：wecom.js 的令牌缓存持有 `{ cred, cache }`。
      // 它看着像"凭据留在模块作用域"，其实是有意的——`entry.cred = cred` 让轮换
      // 后的调用用新 secret 取 token，修掉的正是生产中"轮换后仍用旧 secret、
      // 持续 40001"的事故。去掉它要引入轮换失效协议，会让那个 bug 复现。
      //
      // 放行它但留一个具名理由，好过把断言整体放宽——后者会让下一次真正的留存
      // 悄悄混过去。判定记录在 change 的 1.2b。
      const REVIEWED_RETAINED = {
        "wecom.js": "cred held deliberately so rotation takes effect (fixes a prod 40001); see change 1.2b",
      };
      assert.ok(
        derivedCache || REVIEWED_RETAINED[file],
        `${file}: module-level "${moduleLevelSecret[0].trim()}" looks like a retained credential — only a per-cred cache is allowed`,
      );
    }
  }
});

test("1.2 the gate module sends nothing itself", () => {
  const src = read("lib/outbound-message.js");
  assert.ok(!/\bfetch\s*\(/.test(src), "the gate must not perform I/O — it judges, the caller sends");
  assert.ok(!/require\(["'](?:https?|net)["']\)/.test(src));
  assert.ok(!/from\s+["']node:(?:http|https|net)["']/.test(src));
});

test("1.3 both outbound call sites go through the gate", () => {
  const src = read("server/bots.js");
  // 回合回复
  assert.match(src, /const replyRaw = async \(body\) => \{\s*try \{ await gateAndSend\(body\); \}/, "turn replies must go through gateAndSend");
  // 主动外发
  const sendTo = src.slice(src.indexOf("export async function sendTo"));
  assert.ok(sendTo.includes("gateOutboundMessage("), "sendTo must consult the gate — it is the easiest bypass to forget");
  assert.ok(
    !/export async function sendTo[\s\S]{0,900}?entry\.adapter\.sendText\([^)]*\);\s*\}/.test(sendTo.slice(0, 200)),
    "sendTo must not send before the gate",
  );
});

test("1.3 a bypass attempt is recordable and never throws", async () => {
  const { noteBypassAttempt } = await import("../lib/outbound-message.js");
  const seen = [];
  noteBypassAttempt({ onRecord: (e) => seen.push(e), source: "probe" });
  assert.equal(seen.length, 1);
  assert.doesNotThrow(() => noteBypassAttempt({ onRecord: () => { throw new Error("x"); } }));
});
