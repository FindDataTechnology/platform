// ── Trade delegation bridge ──────────────────────────────────────────────────
//
// Mints a short-lived delegation grant for an agent's trade order, server-side,
// from the deployment's registry machine credential.
//
// Why the cell must not mint its own grant: the signing key lives in the
// registry and never leaves it, and a per-cell machine credential would be a
// standing authority that survives the user's session. Here the ceiling is the
// operator's (`ERP_TRADE_GRANT_BUDGET`), the actor is the session owner, and
// the grant dies with its TTL — an agent can spend, but only inside a bound a
// human set and only for the human it is acting for.
//
// Deliberately NOT a general grant proxy: it only issues for `aud` =
// the ERP trade surface, only with an `act`, and only up to the configured
// budget. Anything else is refused, so this route cannot be used to obtain
// authority for other services.

//: The only audience this bridge will ever mint for.
const TRADE_AUD = "erp-vertical-api";
//: Hard ceiling regardless of what a caller asks for. The configured budget can
//: lower it but never raise it.
const HARD_MAX_TTL_SECONDS = 1800;

function registryOrigin(env) {
  return String(env.MARKET_REGISTRY_URL || env.REGISTRY_URL || "").replace(/\/+$/, "");
}

// GRANT_ISSUER_TOKEN 是专用凭据（能过 registry /api/grants 鉴权）。
// AGENT_SERVING_REGISTRY_TOKEN 留着做兜底，但它实测跑不过该鉴权（401），
// 混用只会让人误以为已接通。
function registryToken(env) {
  return String(env.GRANT_ISSUER_TOKEN || env.AGENT_SERVING_REGISTRY_TOKEN || "");
}

export function registerTradeGrantRoute(ctx) {
  const { app } = ctx;
  const env = ctx.env ?? process.env;
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;

  app.post("/api/trade/grant", async (req, res) => {
    // 这条路挂在 AUTH_EXEMPT 里（MCP 子进程没有会话），所以必须自己守门：
    // 只接受本机 loopback 的来源。跨机访问一律拒——否则任何能打到这个端口
    // 的人都能替任意 act 签发一张有额度上限的票。
    // shortcut: 只判来源地址，不判客户端证书；多副本/跨 pod 调用时升级为共享密钥。
    const remote = String(req.socket?.remoteAddress || "");
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!loopback) {
      console.warn(`[trade-grant] refused non-loopback caller ${remote}`);
      return res.status(403).json({ error: "loopback_only", message: "只接受本机调用" });
    }
    const base = registryOrigin(env);
    const token = registryToken(env);
    if (!base || !token) {
      // ships-dark: the trade lane still works, orders just run as human ones.
      return res.status(503).json({
        error: "trade_grant_unconfigured",
        message: "MARKET_REGISTRY_URL / GRANT_ISSUER_TOKEN / ERP_TRADE_AGENT_SUB / ERP_TENANT_ID 未配置",
      });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const act = String(body.act || "").trim();
    const run = String(body.run || "").trim();
    if (!act || !run) {
      return res.status(400).json({
        error: "invalid_argument",
        message: "act（代谁做事）与 run（本次运行标识）必填",
      });
    }
    // A caller may lower the ceiling for one order but never raise it.
    const configured = String(env.ERP_TRADE_GRANT_BUDGET || "").trim();
    const requested = String(body.budget ?? "").trim();
    const budget = pickLower(configured, requested);

    // 机器凭据没有「caller 租户」可推断：registry 的 /api/grants 文档写明
    // tenant 默认取 caller 的绑定，而这条路径没有 caller session。所以
    // sub（agent 主体）与 tenant 必须由部署显式给出 —— 漏了就会被
    // tenant_unresolved / principal_unregistered 拒签（2026-11-26 实测）。
    const sub = String(env.ERP_TRADE_AGENT_SUB || "").trim();
    const tenant = String(env.ERP_TENANT_ID || "").trim();
    if (!sub || !tenant) {
      return res.status(503).json({
        error: "trade_grant_unconfigured",
        message: "ERP_TRADE_AGENT_SUB / ERP_TENANT_ID 未配置（机器凭据无法自推断租户）",
      });
    }
    const payload = {
      aud: TRADE_AUD,
      run,
      sub,
      act,
      tenant,
      scope: ["order.write"],
      ttl_seconds: Math.min(Number(env.ERP_TRADE_GRANT_TTL || 900), HARD_MAX_TTL_SECONDS),
      ...(budget ? { budget: { amount: budget, currency: "CNY" } } : {}),
    };
    try {
      const upstream = await fetchImpl(`${base}/api/grants`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12_000),
      });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok || !data?.token) {
        console.warn(`[trade-grant] grant refused (${upstream.status}): ${JSON.stringify(data).slice(0, 200)}`);
        return res.status(upstream.status === 401 || upstream.status === 403 ? 403 : 502).json({
          error: "grant_refused",
          message: data?.detail?.message || data?.detail || data?.error || `registry ${upstream.status}`,
        });
      }
      return res.json({ token: data.token, aud: data.aud, exp: data.exp, budget: budget || null });
    } catch (err) {
      console.warn(`[trade-grant] grant bridge failed: ${err?.message || err}`);
      return res.status(502).json({ error: "grant_unreachable", message: String(err?.message || err) });
    }
  });
}

/** Return the lower of two decimal budgets; "" when neither is set. */
export function pickLower(a, b) {
  const parse = (v) => {
    if (v === undefined || v === null || String(v).trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const av = parse(a);
  const bv = parse(b);
  if (av === null && bv === null) return "";
  if (av === null) return String(bv);
  if (bv === null) return String(av);
  return String(Math.min(av, bv));
}
