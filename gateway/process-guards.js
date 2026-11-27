// ── 进程存活兜底（2026-11-19 生产实证） ──────────────────────────────────────
//
// 一次客户端在中途断开，就让整个 gateway 退出：
//
//   Error: aborted   code: 'ECONNRESET'
//     at abortIncoming (node:_http_server:851:17)
//     at socketOnClose  (node:_http_server:845:3)
//
// 那不是我们的代码抛的——是 Node 在请求体没读完时把连接掐掉，那个 rejection
// 没人接，Node 25 的默认行为是结束进程。代价不对等：一个用户关掉浏览器 tab，
// 所有用户的 cell 一起没了。
//
// 判据是「这个错误是否说明我的状态坏了」：
//
//   · 连接类（ECONNRESET / aborted / EPIPE / ECANCELED / premature close）
//     —— 进程状态**没有**被破坏，是网络常态。记 warn，继续跑。
//   · 其他未捕获异常 —— 状态不可信，按 Node 的忠告**退出**并由容器重启。
//     这里只多写一行带堆栈的 error，让下一次崩溃能直接定位，而不是像这次
//     只有一行 `Error: aborted` 需要靠猜。
//
// 也就是说：这条兜底**只救连接类错误**，不掩盖真正的缺陷。吃掉所有异常会让
// 一个已经半死的进程继续接流量，那比崩溃更糟。
const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECANCELED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ABORT_ERR",
]);

function isConnectionError(err) {
  if (!err || typeof err !== "object") return false;
  if (CONNECTION_ERROR_CODES.has(err.code)) return true;
  if (CONNECTION_ERROR_CODES.has(err.name)) return true;
  // Node's http server raises a bare `Error: aborted` for a client that hung up
  // mid-body — no code, message only. Anchored exactly so an app error that
  // merely contains the word does not get mistaken for one.
  return err.message === "aborted";
}

export function installProcessGuards({ log = console } = {}) {
  process.on("unhandledRejection", (err) => {
    if (isConnectionError(err)) {
      log.warn(`[gateway] connection dropped mid-request (${err?.message}); continuing`);
      return;
    }
    // Node's default already exits here; log first so the reason survives.
    log.error("[gateway] unhandled rejection:", err);
    process.exitCode = 1;
    throw err;
  });

  process.on("uncaughtException", (err) => {
    if (isConnectionError(err)) {
      log.warn(`[gateway] connection dropped mid-request (${err?.message}); continuing`);
      return;
    }
    log.error("[gateway] uncaught exception:", err);
    process.exit(1);
  });
}

export const __testing = { isConnectionError };
