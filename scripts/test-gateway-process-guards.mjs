// 进程存活兜底（2026-11-19 事故回归）：连接中断不该打死 gateway。
//
// 现场：客户端在请求体没读完时断开，Node 抛 `Error: aborted` (ECONNRESET)，
// 那个 rejection 没人接，进程整个退出 —— 所有用户的 cell 一起断。
//
// 这条测试守两件事，缺一不可：
//   ① 连接类错误**不**终止进程（否则一次 tab 关闭就停机）；
//   ② 其他未捕获异常**仍然**终止进程 —— 兜底不能变成掩盖缺陷。

import test from "node:test";
import assert from "node:assert/strict";
import { __testing } from "../gateway/process-guards.js";

const { isConnectionError } = __testing;

test("connection drops are recognised — and only those", () => {
  for (const code of ["ECONNRESET", "EPIPE", "ECANCELED", "ERR_STREAM_PREMATURE_CLOSE", "ABORT_ERR"]) {
    const e = new Error("x");
    e.code = code;
    assert.equal(isConnectionError(e), true, `${code} is a connection error`);
  }
  // Node's http server raises a bare `Error: aborted` with no code.
  assert.equal(isConnectionError(new Error("aborted")), true, "bare `aborted` is a connection error");

  // A real defect must NOT be mistaken for one, or the guard would swallow it.
  assert.equal(isConnectionError(new Error("resolver.resolve is not a function")), false);
  assert.equal(isConnectionError(new TypeError("x is not a function")), false);
  assert.equal(isConnectionError(new Error("request aborted by user policy")), false, "substring is not a match");
  assert.equal(isConnectionError(null), false);
  assert.equal(isConnectionError("aborted"), false);
});

test("the gateway installs the guards before it starts listening", async () => {
  // Wiring check by source: a guard installed AFTER listen() leaves a window
  // where an early rejection still kills the process, and a test that imports
  // the module cannot observe that ordering.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const src = await fs.readFile(path.resolve(import.meta.dirname, "..", "gateway/index.js"), "utf8");
  // Match the CALL, not a mention: a commented-out call still contains the
  // string, which would make this gate permanently green (caught by red-check).
  const callRe = /^\s*installProcessGuards\(\);\s*$/m;
  const m = callRe.exec(src);
  const guardAt = m ? m.index : -1;
  const listenAt = src.indexOf("server.listen(PORT, HOST");
  assert.ok(guardAt > 0, "the gateway calls installProcessGuards()");
  assert.ok(listenAt > 0, "the gateway listens");
  assert.ok(guardAt < listenAt, "guards are installed BEFORE the server accepts traffic");
});
