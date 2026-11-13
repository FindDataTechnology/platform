#!/usr/bin/env node
// ── 从零部署演练（任务 7.2）────────────────────────────────────────────────
//
// 目的：不是"再跑一遍单测"，而是**按部署文档的顺序，用命令行把整条通道从零建起来**，
// 每一关的判据都是真实产出（进程退出码 / 库里的行 / 导出的清单），不是"函数返回了 true"。
//
// 顺序刻意如此——第一关必须**红**：
//
//   1. 空库上 `activate --check` → 退出码 1，blockers 含 `never_checked`
//      这一关证明的是"从零不会被报成就绪"。若这里绿了，说明就绪判定把"还没拉过"
//      当成了"没问题"。
//   2. `pull` → 真走 Node → python helper → C 桩库 → 解密 → 同意闸门 → 入库
//   3. `activate --check` → 现在退出码 0（有数据、滞后新鲜）
//   4. `patrol` → 退出码 0，且不投递（没有告警）
//   5. `consent-event`（Status=0 撤回同意）→ 库里 agree_state=disagree
//   6. 再 `pull`（同一批消息）→ 全部被同意闸门拒掉，入库数不变
//      ← 这一关是合规主线：撤回后不得继续写
//   7. `export --dir` → 清单里 integrity=ok，且**只含仍同意的会话**
//
// 替换掉的两件真东西（必须说清，否则这份"绿"是假的）：
//   • SDK：用 tools/archive-sdk-stub 的桩库（ABI 已按官方头文件对齐，见
//     scripts/test-archive-sdk-abi.mjs），不是腾讯的 .so；
//   • 企业微信接口：用本地假 qyapi（只实现 gettoken 与 check_room_agree），
//     不是真企业凭据。
// 除此之外的代码路径与生产完全一致：同一个 cli.mjs、同一个 helper、同一份 schema。
//
//   node scripts/rehearse-archive-from-zero.mjs [--keep]

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "server", "archive", "cli.mjs");
const STUB = path.join(ROOT, "tools", "archive-sdk-stub", "build", "libWeWorkFinanceSdk_C.dylib");
const KEEP = process.argv.includes("--keep");

const steps = [];
function record(name, detail, ok) {
  steps.push({ name, ok, detail });
  process.stdout.write(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}
function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * 跑一条 CLI 命令。**必须异步**：本脚本自己在同一个进程里跑着假 qyapi，
 * `spawnSync` 会堵住事件循环，假服务就无法 accept，子进程的请求会一直等到超时
 * （表现为 `网络失败：The operation was aborted due to timeout`，而且假服务
 * 一个请求都收不到——第一次演练就是栽在这上面）。
 */
function runCli(args, env, { stdin = "" } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* 有的命令输出不是 JSON，或输出为空 */
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

function makeKeys(dir) {
  const priv = path.join(dir, "private.pem");
  const pub = path.join(dir, "public.pem");
  execFileSync("openssl", ["genrsa", "-out", priv, "2048"], { stdio: "ignore" });
  execFileSync("openssl", ["rsa", "-in", priv, "-pubout", "-out", pub], { stdio: "ignore" });
  const encrypt = (name) => {
    const plainFile = path.join(dir, `${name}.txt`);
    const outFile = path.join(dir, `${name}.bin`);
    writeFileSync(plainFile, `aes-key-${name}`);
    execFileSync(
      "openssl",
      ["pkeyutl", "-encrypt", "-pubin", "-inkey", pub, "-pkeyopt", "rsa_padding_mode:pkcs1",
       "-in", plainFile, "-out", outFile],
      { stdio: "ignore" },
    );
    return readFileSync(outFile).toString("base64");
  };
  return { priv, enc1: encrypt("k1"), enc2: encrypt("k2") };
}

/** 假 qyapi：只实现这条通道真正会打的两个接口。 */
function startFakeQyapi({ agreeRooms = new Set(["room1"]) } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: url.pathname, body });
      const json = (o) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url.pathname === "/cgi-bin/gettoken") {
        return json({ errcode: 0, errmsg: "ok", access_token: "T".repeat(40), expires_in: 7200 });
      }
      if (url.pathname === "/cgi-bin/msgaudit/check_room_agree") {
        let room = "";
        try {
          room = JSON.parse(body)?.info?.[0]?.roomid || "";
        } catch {
          /* 形状不对就按不同意处理 */
        }
        return json({
          errcode: 0,
          errmsg: "ok",
          agree_status: agreeRooms.has(room) ? "Agree" : "Disagree",
        });
      }
      return json({ errcode: 404, errmsg: `未实现：${url.pathname}` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, seen, agreeRooms, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const now = Date.now();

function writeStubConfig(dir, keys) {
  // 两条真实形状的消息：一条文本、一条图片（带媒体）。
  // msgtime 用**当前时间**：lag 判定是拿最后一條消息与 now 比，用常量时间会直接判成 lost。
  const plain1 = JSON.stringify({
    msgid: "m1", seq: 1, from: "wmCUST", roomid: "room1",
    msgtime: now - 5000, msgtype: "text", text: { content: "帮我报个价，明早见客户" },
  });
  const plain2 = JSON.stringify({
    msgid: "m2", seq: 2, from: "wmCUST", roomid: "room1",
    msgtime: now - 4000, msgtype: "image", image: { sdkfileid: "FID1", filesize: 6 },
  });
  const batch = JSON.stringify([
    { msgid: "m1", seq: 1, publickey_ver: 3, encrypt_random_key: keys.enc1, encrypt_chat_msg: "ct1" },
    { msgid: "m2", seq: 2, publickey_ver: 3, encrypt_random_key: keys.enc2, encrypt_chat_msg: "ct2" },
  ]);
  const cfg = [
    `BATCH\t1\t${batch}`,
    `PLAIN\tct1\t${plain1}`,
    `PLAIN\tct2\t${plain2}`,
    `MEDIA\tFID1\t0\t${Buffer.from("abc").toString("hex")}`,
    `MEDIA\tFID1\t1\t${Buffer.from("def").toString("hex")}`,
  ].join("\n");
  const file = path.join(dir, "stub.cfg");
  writeFileSync(file, `${cfg}\n`, "utf8");
  return file;
}

/** 往桩配置里追加第三条消息（撤回同意之后才出现），用来验证"新消息也被拒"。 */
function appendThirdBatch(cfgFile, keys) {
  const plain = JSON.stringify({
    msgid: "m3", seq: 3, from: "wmCUST", roomid: "room1",
    msgtime: Date.now() - 3000, msgtype: "text", text: { content: "撤回同意之后又来一条" },
  });
  const batch = JSON.stringify([
    { msgid: "m3", seq: 3, publickey_ver: 3, encrypt_random_key: keys.enc1, encrypt_chat_msg: "ct3" },
  ]);
  const extra = `\nBATCH\t3\t${batch}\nPLAIN\tct3\t${plain}\n`;
  writeFileSync(cfgFile, readFileSync(cfgFile, "utf8") + extra, "utf8");
}

const dir = mkdtempSync(path.join(tmpdir(), "archive-rehearsal-"));
const cleanup = () => {
  if (!KEEP) execFileSync("rm", ["-rf", dir]);
  else process.stdout.write(`\n工作目录保留在：${dir}\n`);
};

const fake = await startFakeQyapi();
const dbFile = path.join(dir, "archive.db");

try {
  must(existsSync(STUB), `桩库不存在：${STUB}（先跑 tools/archive-sdk-stub/build.sh）`);
  const keys = makeKeys(dir);
  const stubCfg = writeStubConfig(dir, keys);

  const env = {
    ARCHIVE_DB: dbFile,
    ARCHIVE_ENABLED: "1",
    ARCHIVE_CORPID: "ww-rehearsal",
    ARCHIVE_SECRET: "s".repeat(40),
    ARCHIVE_PRIVATE_KEY: keys.priv,
    ARCHIVE_SEAT_SCOPE: "zhangsan",
    ARCHIVE_SDK_PATH: STUB,
    ARCHIVE_EGRESS_IP: "1.2.3.4",
    ARCHIVE_STUB_CONFIG: stubCfg,
    ARCHIVE_API_BASE: fake.base,
    ARCHIVE_PATROL_STATE: path.join(dir, "patrol.json"),
  };

  // ① 空库：必须不通过（把"还没拉过"报成就绪是最坏的假绿）
  {
    const r = await runCli(["activate", "--check"], env);
    must(r.code === 1, `空库上 activate --check 应为 1，实际 ${r.code}：${r.stderr}`);
    must(
      (r.json?.blockers || []).includes("never_checked"),
      `blockers 应含 never_checked，实际 ${JSON.stringify(r.json?.blockers)}`,
    );
    record("① 空库 activate --check 拒绝就绪", `blockers=${r.json.blockers.join(",")}`, true);
  }

  // ② 拉一轮
  let pulled = 0;
  {
    const r = await runCli(["pull"], env);
    must(r.code === 0, `pull 应成功，实际 ${r.code}：${r.stderr || r.stdout}`);
    pulled = r.json?.admitted ?? -1;
    must(pulled === 2, `应入库 2 条，实际 ${pulled}`);
    must(r.json?.errors?.length === 0, `不应有错误：${JSON.stringify(r.json?.errors)}`);
    record("② pull 拉取入库", `admitted=${pulled} mediaQueued=${r.json.mediaQueued}`, true);
  }

  // ③ 有数据后：就绪
  {
    const r = await runCli(["activate", "--check"], env);
    must(r.code === 0, `有数据后 activate --check 应为 0，实际 ${r.code}：${r.stdout}`);
    record("③ 有数据后 activate --check 通过", r.json?.verdict || "", true);
  }

  // ④ 巡检：新鲜 → ok
  {
    const r = await runCli(["patrol"], env);
    must(r.code === 0, `patrol 应为 0，实际 ${r.code}：${r.stdout}`);
    must((r.json?.opened || []).length === 0, `不应有告警：${JSON.stringify(r.json?.opened)}`);
    record("④ patrol 判定 ok 且无告警", `level=${r.json?.verdict?.level}`, true);
  }

  // ⑤ 撤回同意（回调）
  {
    const xml = "<xml><Event>msg_audit_approved</Event><ChatId>room1</ChatId><Status>0</Status></xml>";
    const r = await runCli(["consent-event"], env, { stdin: xml });
    must(r.code === 0, `consent-event 应 0，实际 ${r.code}：${r.stderr}`);
    must(r.json?.handled === true, `应处理成功：${r.stdout}`);
    const db = new DatabaseSync(dbFile);
    const row = db.prepare("SELECT agree_state FROM archive_conversation WHERE conversation_id='room1'").get();
    db.close();
    must(row?.agree_state === "disagree", `库里应为 disagree，实际 ${row?.agree_state}`);
    // 真实世界里回调与接口是同一事实的两面：客户撤回后，check_room_agree 也应报 Disagree。
    // 只改库不改接口，下一轮就会从接口重新问回 Agree，这一关会变成假绿。
    fake.agreeRooms.delete("room1");
    record("⑤ 回调撤回同意 → 库内 disagree", "", true);
  }

  // ⑥ 撤回后再拉：**新到的**消息也不得入库（合规主线）
  //
  // 造一条新批次（seq 3）再拉。否则游标停在 2，"没写库"只是因为没东西可拉——
  // 那种断言是空转，看着绿其实什么都没验。
  {
    appendThirdBatch(stubCfg, keys);
    const before = (() => {
      const db = new DatabaseSync(dbFile);
      const n = db.prepare("SELECT COUNT(*) c FROM archive_message").get().c;
      db.close();
      return Number(n);
    })();
    const r = await runCli(["pull"], env);
    must(r.code === 0, `pull 应 0，实际 ${r.code}：${r.stderr}`);
    const after = (() => {
      const db = new DatabaseSync(dbFile);
      const n = db.prepare("SELECT COUNT(*) c FROM archive_message").get().c;
      db.close();
      return Number(n);
    })();
    must(after === before, `撤回同意后不得再写入：前 ${before} 后 ${after}`);
    must(
      (r.json?.rejectedConsent ?? 0) >= 1,
      `新消息必须被同意闸门拒掉（rejectedConsent=${r.json?.rejectedConsent}）；` +
        "为 0 说明这关根本没拉到东西，断言是空转",
    );
    record(
      "⑥ 撤回后新消息被拒、库内行数不变",
      `messages=${after} rejectedConsent=${r.json.rejectedConsent}`,
      true,
    );
  }

  // ⑦ 导出：客户随时能拿走
  {
    const out = path.join(dir, "export");
    const r = await runCli(["export", "--dir", out], env);
    must(r.code === 0, `export 应为 0，实际 ${r.code}：${r.stderr}`);
    must(r.json?.integrity === "ok", `导出清单 integrity 应为 ok：${r.json?.integrity}`);
    record("⑦ export 导出并自检", `messages=${r.json?.counts?.messages}`, true);
  }

  process.stdout.write(`\n全链演练通过：${steps.filter((s) => s.ok).length} 关\n`);
  process.stdout.write(
    "\n注意：SDK 用的是已对齐 ABI 的桩库、企业微信接口是本地假服务；" +
      "其余路径与生产一致（同一个 cli/helper/schema）。\n",
  );
} catch (err) {
  record("演练中断", err.message, false);
  process.exitCode = 1;
} finally {
  fake.server.close();
  cleanup();
}
