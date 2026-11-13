// ── 微信客服：就绪诊断 ──────────────────────────────────────────────────────
//
// 诊断的价值在于**把三种完全不同的情形分开**，因为它们要三种不同的动作：
//
//   unconfigured   → 填配置（corpid / secret / open_kfid）
//   api_unavailable→ 去后台把自建应用选为「可调用接口的应用」，并把接待人员加进可见范围
//   ready_empty    → 什么都不用修，只是这 3 天没人来问
//
// 早先只做"能不能调通"这一个判据，结果 `ready_empty` 被当成故障排查了半天，
// 而 `api_unavailable` 被当成"配置没填对"反复改 corpid。所以这里的 `verdict` 是一等输出。
//
// 另一条约束：容量上限（未认证 100 客户 / 10 客服号）如实写出。
// 它不是代码能改变的东西，但运维必须能看见，否则会在客户数撞墙时以为是程序 bug。

import { kfCoverageReport } from "./store.js";
import { evaluateLag } from "../window.js";
import { KF_WINDOW_DAYS, KF_WARN_DAYS } from "./ingest.js";

export const UNVERIFIED_LIMITS = { customers: 100, accounts: 10 };
export const VERIFIED_LIMITS = { customers: 2000, accounts: 5000 };

/**
 * 跑一次诊断。`client` 可注入；不传时只做静态配置检查（不发网络请求）。
 */
export async function runKfDoctor({
  db,
  client = null,
  config = {},
  corpVerified = false,
  now = Date.now(),
  cursorId = "default",
} = {}) {
  const missing = [];
  if (!config.corpId) missing.push("corpid");
  if (!config.secret) missing.push("secret");
  // open_kfid 可选：不填就拉取全部客服账号，消息自带 open_kfid 足以正确分组。
  // 少一项要用户去后台翻，就少一个卡住的地方。
  const hasKfId = Boolean(config.openKfId);

  const checks = {
    configured: missing.length === 0,
    token: null,
    api: null,
    kfidKnown: null,
    ipTrusted: null, // 60020 专用：false＝出口 IP 不在企业可信IP 内
    data: null,
    sdkPresent: null, // kf 不需要本地 SDK；保留字段是为了让两个通道的诊断形状一致
  };
  const blockers = [];
  let verdict = "unknown";

  const coverage = db ? kfCoverageReport(db, { cursorId, windowDays: KF_WINDOW_DAYS }) : null;

  if (missing.length) {
    verdict = "unconfigured";
    blockers.push(`缺少配置：${missing.join(", ")}`);
  } else if (client && typeof client.listAccounts === "function") {
    try {
      await client.getToken();
      checks.token = true;
    } catch (err) {
      checks.token = false;
      verdict = "api_unavailable";
      blockers.push(
        `取 access_token 失败（${err?.name || "Error"} errcode=${err?.errcode ?? "?"}）：` +
          "优先核对 corpid/secret 是否属于同一个自建应用",
      );
    }

    if (checks.token) {
      try {
        const accounts = await client.listAccounts();
        checks.api = true;
        const ids = accounts.map((a) => String(a.open_kfid || ""));
        if (hasKfId) {
          checks.kfidKnown = ids.includes(String(config.openKfId));
          if (!checks.kfidKnown) {
            verdict = "api_unavailable";
            blockers.push(
              `open_kfid=${config.openKfId} 不在本企业客服账号列表（现有 ${ids.length} 个：${ids.join(", ") || "无"}）：` +
                "要么 id 填错，要么该客服号不在自建应用的可见范围",
            );
          }
        } else {
          // 未指定 open_kfid：这里只是把候选账号列出来供人选择。
          // 拉取阶段仍必须有 kfid（官方文档 94670 标为必填），由 resolveOpenKfId 解析。
          checks.kfidKnown = null;
          checks.accounts = accounts.map((a) => ({
            openKfId: String(a.open_kfid || ""),
            name: String(a.name || ""),
          }));
        }
      } catch (err) {
        checks.api = false;
        verdict = "api_unavailable";
        if (err?.name === "KfIpNotTrustedError" || Number(err?.errcode) === 60020) {
          // 取票成功却调不通，最常见的原因就是出口 IP 不在白名单。把 IP 点名，
          // 否则运维会去改 corpid/secret——那是另一类错误，改多久都还是 60020。
          checks.ipTrusted = false;
          blockers.push(
            `调用出口 IP ${err?.ip || "（errmsg 未给出）"} 不在「企业可信IP」内（errcode=60020）：` +
              "在 应用管理 → 自建应用 → 企业可信IP 里加入该 IP，或把通道部署到已在白名单的机器",
          );
        } else {
          blockers.push(
            `调用 kf/account/list 失败（errcode=${err?.errcode ?? "?"}）：` +
              "通常是自建应用未被选为「可调用接口的应用」，或接待人员不在应用可见范围",
          );
        }
      }
    }
  } else {
    // 没有 client：只能给"配置齐了"，不能宣称接口通。
    checks.token = null;
    checks.api = null;
  }

  if (!verdict || verdict === "unknown") {
    const hasMessages = Number(coverage?.messages?.total || 0) > 0;
    checks.data = hasMessages;
    verdict = hasMessages ? "ready" : "ready_empty";
  }

  const lag = coverage
    ? evaluateLag({
        lastMessageAt: coverage.cursor.lastMessageAt,
        lastCheckedAt: coverage.cursor.lastCheckedAt,
        // 水位只认「最后一次成功同步」：客服号几天没人说话是常态，按最后一条消息
        // 算会把它永久判成 lost → doctor 长期红、退出码 1，真红就没人看了。
        lastSuccessAt: coverage.cursor.lastSuccessAt,
        now,
        warnDays: KF_WARN_DAYS,
        hardLimitDays: KF_WINDOW_DAYS,
      })
    : null;

  if (lag?.level === "lost") blockers.push(lag.reason);

  return {
    channel: "wecom-kf",
    ok: verdict === "ready" || verdict === "ready_empty",
    verdict,
    blockers,
    checks,
    lag,
    coverage,
    limits: {
      corpVerified,
      customers: corpVerified ? VERIFIED_LIMITS.customers : UNVERIFIED_LIMITS.customers,
      accounts: corpVerified ? VERIFIED_LIMITS.accounts : UNVERIFIED_LIMITS.accounts,
      note: corpVerified
        ? "已认证企业上限"
        : "未认证企业上限：客户 100 人 / 客服账号 10 个。认证后为 2000 / 5000，认证是后台操作，不是代码开关",
    },
  };
}

/** 一行结论，给 CLI / 巡检日志用。 */
export function kfDoctorLine(result) {
  const cov = result?.coverage;
  const parts = [`kf:${result?.verdict || "unknown"}`];
  if (cov) parts.push(`消息 ${cov.messages.total} 条`, `会话 ${cov.conversations.total} 个`);
  if (result?.lag?.level) parts.push(`滞后 ${result.lag.level}`);
  if (result?.blockers?.length) parts.push(`阻塞 ${result.blockers.length} 项`);
  parts.push(
    `上限 客户 ${result?.limits?.customers ?? "?"} / 客服号 ${result?.limits?.accounts ?? "?"}`,
  );
  return parts.join(" · ");
}
