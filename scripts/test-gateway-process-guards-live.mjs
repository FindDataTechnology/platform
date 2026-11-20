// 进程级回归：真的复现 2026-11-19 打死生产的那次崩溃形状。
//
// 现场堆栈（原样）：
//   Error: aborted
//     at abortIncoming (node:_http_server:851:17)
//     at socketOnClose  (node:_http_server:845:3)
//     at Socket.emit (node:events:521:24)
//     at TCP.<anonymous> (node:net:350:12)
//
// 形状：handler 里有一个**没人 catch 的 async 任务**，它在客户端中途断开时
// 因 `req` 的 "aborted"（或 Node 内部把请求体读中断）而 reject。Node 25/26 默认
// 把这个未捕获 rejection 当成致命错误退出进程。
//
// 这条测试起真的 HTTP 服务、真的让客户端在请求体中途断开，断言：
//   ① 装了兜底 → 进程活着且还能继续服务；
//   ② 没装兜底 → 进程确实会死（红证，证明这条测试不是摆设）。

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const GUARDS = fileURLToPath(new URL("../gateway/process-guards.js", import.meta.url));

/** Boot a child server that reproduces the crash shape. */
function boot({ withGuards }) {
  const script = `
    ${withGuards ? `import { installProcessGuards } from ${JSON.stringify(GUARDS)}; installProcessGuards();` : ""}
    import http from "node:http";
    const srv = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => res.end("ok"));
      // The production shape: background async work with no catch. On a client
      // hang-up Node rejects it ("aborted") and, uncaught, exits the process.
      (async () => {
        await new Promise((_, rej) => {
          req.on("aborted", () => rej(new Error("aborted")));
        });
      })();
    });
    srv.listen(0, "127.0.0.1", () => console.log("PORT=" + srv.address().port));
    process.on("SIGTERM", () => process.exit(0));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.setEncoding("utf8").on("data", (d) => { out += d; });
  child.stderr.setEncoding("utf8").on("data", (d) => { err += d; });
  let exited = false;
  child.on("exit", () => { exited = true; });
  const portOf = () => { const m = /PORT=(\d+)/.exec(out); return m ? Number(m[1]) : null; };
  return { child, portOf, isExited: () => exited, stderr: () => err };
}

/** Declare a body, send part of it, hang up — the exact production shape. */
async function hangUpMidBody(port) {
  await new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write("POST /x HTTP/1.1\r\nHost: t\r\nContent-Length: 100\r\n\r\npartial");
      setTimeout(() => { sock.destroy(); resolve(); }, 120);
    });
    sock.on("error", () => resolve());
  });
  // Let the rejection surface (or not).
  await new Promise((r) => setTimeout(r, 800));
}

async function waitPort(h) {
  for (let i = 0; i < 120 && !h.portOf(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(h.portOf(), `server booted; stderr=${h.stderr()}`);
}

test("WITH the guards: a client hang-up leaves the process serving", async () => {
  const h = boot({ withGuards: true });
  try {
    await waitPort(h);
    await hangUpMidBody(h.portOf());
    assert.equal(h.isExited(), false, `process must survive; stderr=${h.stderr()}`);
    // And it still answers.
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: h.portOf(), path: "/", method: "POST" }, (res) => {
        let b = ""; res.setEncoding("utf8");
        res.on("data", (d) => { b += d; });
        res.on("end", () => resolve(b));
      });
      req.on("error", reject);
      req.end("hi");
    });
    assert.match(body, /^ok/, "still serves after the hang-up");
  } finally {
    h.child.kill("SIGTERM");
  }
});

test("WITHOUT the guards the same hang-up kills the process (this is why they exist)", async () => {
  const h = boot({ withGuards: false });
  try {
    await waitPort(h);
    await hangUpMidBody(h.portOf());
    assert.equal(h.isExited(), true, "uncaught rejection exits the process — the 2026-11-19 failure");
  } finally {
    h.child.kill("SIGKILL");
  }
});
