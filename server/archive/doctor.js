// ── 就绪自检（`archive doctor`）─────────────────────────────────────────────
//
// 这条命令存在的唯一理由：**把"卡在哪一项"变成可读输出**。
// 没有它，现场只得到"拉不到数据"，然后开始在 SDK/网络/权限之间猜。
//
// 五项激活清单（spec archive-sidecar「激活清单逐项可校验」）：
//   ① 已开通会话存档 ② 已上传公钥且本地有私钥 ③ secret 是存档专用（不是普通应用 secret）
//   ④ 可信 IP 与实际出口一致 ⑤ 已圈定席位范围
//
// 结论只有一句，但 blockers 逐项列出——两者都要，缺一个现场就得猜。

import { probeReadiness, verifySdkFile } from "./sdk.js";
import { readCursor, listLosses, coverageReport, ensureArchiveSchema } from "./store.js";
import { evaluateLag } from "./window.js";

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {{call: Function}} [deps.driver]  缺省则只跑本地检查（不探 SDK/出口）
 * @param {object} [deps.config]            {privateKeyPath, secret, expectedEgressIp, effectiveSeats, purchasedSeats, seatScope}
 * @param {number} [deps.now]
 */
export async function runDoctor({ db, driver, config = {}, now = Date.now() } = {}) {
  ensureArchiveSchema(db);

  const checks = {
    archiveEnabled: config.archiveEnabled === true,
    privateKey: Boolean(config.privateKeyPath),
    secret: null,
    egress: null,
    seatScope: Array.isArray(config.seatScope) ? config.seatScope.length > 0 : false,
    sdk: null,
  };

  const seat = String(config.secret || "");
  checks.secret = !seat ? "missing" : seat.length < 32 ? "too_short" : "ok";

  // SDK 文件的固定校验。`unpinned` 算通过但会写进 checks，让"未固定"这件事可被看见——
  // 假装校验过比不校验更危险。
  const pin = verifySdkFile({
    path: config.sdkPath || "",
    expectedSha256: config.expectedSdkSha256 || "",
  });
  checks.sdkPin = pin.state;
  checks.sdkActualSha256 = pin.actual;
  checks.sdkExpectedSha256 = pin.expected;

  let readiness = null;
  if (driver) {
    readiness = await probeReadiness(driver, config);
    checks.sdk = readiness.checks.sdkPresent === true;
    checks.egress = readiness.checks.egressIpMatch ?? null;
    if (readiness.checks.actualEgressIp) checks.actualEgressIp = readiness.checks.actualEgressIp;
  }

  const cursor = readCursor(db);
  const lag = evaluateLag({
    lastMessageAt: cursor.lastMessageAt,
    lastCheckedAt: cursor.lastCheckedAt,
    // 水位只认「最后一次成功拉取」，与巡检/验收同口径。
    lastSuccessAt: cursor.lastSuccessAt,
    now,
  });
  const coverage = coverageReport(db, {
    effectiveSeats: config.effectiveSeats ?? null,
    purchasedSeats: config.purchasedSeats ?? null,
  });
  const losses = listLosses(db);

  const blockers = [];
  if (!checks.archiveEnabled) blockers.push("archive_not_enabled");
  if (!checks.privateKey) blockers.push("private_key_missing");
  if (checks.secret !== "ok") blockers.push(`secret_${checks.secret}`);
  if (driver && checks.sdk === false) blockers.push("sdk_unavailable");
  // 哈希不符是硬拒：被替换过的 .so 与正版行为无法区分，却能读到客户明文
  if (pin.state === "mismatch") blockers.push("sdk_sha256_mismatch");
  if (checks.egress === false) blockers.push("egress_ip_mismatch");
  if (!checks.seatScope) blockers.push("seat_scope_unset");
  if (lag.level === "never_checked") blockers.push("never_checked");
  if (lag.level === "stalled") blockers.push("puller_stalled");
  if (lag.level === "lost") blockers.push("history_unrecoverable");
  if (lag.level === "warn") blockers.push("lag_warning");

  const ready = blockers.length === 0;
  // "能拉" 与 "有数据" 是两件事：接口通但零条不能算通过（spec 交付验收）。
  const hasData = coverage.messages.total > 0;

  let verdict;
  if (!ready) {
    verdict = `未就绪：${blockers.length} 项待办（${blockers.join(", ")}）`;
  } else if (!hasData) {
    verdict = "已就绪但零数据：检查是否真无新消息，或席位范围未覆盖实际会话";
  } else if (lag.level === "warn") {
    verdict = `可拉取，滞后 ${lag.days?.toFixed(1)} 天超过告警线`;
  } else {
    verdict = "就绪且在工作";
  }

  return {
    ok: ready && hasData && lag.level === "ok",
    verdict,
    blockers,
    checks,
    lag,
    coverage,
    losses,
    cursor,
    readiness,
    hasData,
  };
}

/** 给巡检面的一行摘要（日志/告警正文用）。 */
export function doctorLine(result) {
  const parts = [result.verdict];
  if (result.lag?.hoursSinceMessage !== null && result.lag?.hoursSinceMessage !== undefined) {
    parts.push(`滞后 ${result.lag.hoursSinceMessage.toFixed(1)}h`);
  }
  parts.push(`会话 ${result.coverage.conversations.total} / 消息 ${result.coverage.messages.total}`);
  if (result.losses.length) parts.push(`丢失区间 ${result.losses.length} 段`);
  return parts.join(" · ");
}
