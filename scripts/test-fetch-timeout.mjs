// ── Outbound fetch timeout discipline tests (harden-cell-execution-reliability 组2) ──
//
//   node --test scripts/test-fetch-timeout.mjs
//
// 钉住的契约：
//   · 共享包装器 fetchWithTimeout：正常响应原样透传；停滞的 fetch 在期限内被
//     切断，抛结构化 FetchTimeoutError（code=FETCH_TIMEOUT, retryable=true）；
//   · 默认期限 env PLATFORM_FETCH_TIMEOUT_MS（缺省 10000），逐调用 timeoutMs
//     可覆盖（覆盖值优先于 env）；
//   · retryable 判定：超时/网络类=可重试；调用方主动 abort 与 4xx 语义类=不可
//     重试（isRetryableHttpStatus: 408/429/5xx 可重试）；
//   · 登录路径（gateway/mp-auth code2Session）：微信端点停滞 → 期限内返回
//     可重试的 502，不再悬挂浏览器会话；
//   · MCP bridge 家族（server/fleet-mcp report_status）：bridge 停滞 → 结构化
//     FETCH_TIMEOUT 错误浮出到工具错误面。

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  fetchWithTimeout,
  FetchTimeoutError,
  isRetryableFetchError,
  isRetryableHttpStatus,
  platformFetchTimeoutMs,
} = await import("../lib/fetch-with-timeout.js");

// A fetch that never answers but honors the abort signal the way undici does:
// the abort reason becomes the rejection reason (this is what lets the wrapper
// surface the structured FetchTimeoutError).
function hangingFetch() {
  return (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      if (init.signal?.aborted) return reject(init.signal.reason);
      init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
}

function okFetch() {
  return async (url, init = {}) => ({
    ok: true,
    status: 200,
    url,
    init,
    json: async () => ({ pong: true }),
  });
}

function withEnv(key, value, fn) {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    });
}

// ── wrapper unit tests ────────────────────────────────────────────────────────

test("wrapper passes a normal response through untouched", async () => {
  const impl = okFetch();
  const res = await fetchWithTimeout("https://upstream.test/ping", { method: "GET" }, { fetchImpl: impl });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { pong: true });
  assert.equal(res.init.method, "GET");
});

test("stalled fetch rejects with a structured retryable FetchTimeoutError within the bound", async () => {
  const t0 = Date.now();
  await assert.rejects(
    fetchWithTimeout("https://upstream.test/hang", {}, { fetchImpl: hangingFetch(), timeoutMs: 50 }),
    (err) => {
      assert.ok(err instanceof FetchTimeoutError);
      assert.equal(err.name, "FetchTimeoutError");
      assert.equal(err.code, "FETCH_TIMEOUT");
      assert.equal(err.retryable, true);
      assert.equal(err.timeoutMs, 50);
      assert.match(err.message, /timed out after 50ms/);
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 2000, "deadline must fire promptly, not hang");
});

test("env PLATFORM_FETCH_TIMEOUT_MS is the default deadline", async () => {
  assert.equal(platformFetchTimeoutMs({}), 10_000);
  assert.equal(platformFetchTimeoutMs({ PLATFORM_FETCH_TIMEOUT_MS: "2500" }), 2500);
  // 无效值回落默认（不抛、不 0、不负）。
  assert.equal(platformFetchTimeoutMs({ PLATFORM_FETCH_TIMEOUT_MS: "abc" }), 10_000);
  assert.equal(platformFetchTimeoutMs({ PLATFORM_FETCH_TIMEOUT_MS: "-3" }), 10_000);

  await withEnv("PLATFORM_FETCH_TIMEOUT_MS", "40", async () => {
    await assert.rejects(
      fetchWithTimeout("https://upstream.test/hang", {}, { fetchImpl: hangingFetch() }),
      (err) => {
        assert.equal(err.code, "FETCH_TIMEOUT");
        assert.equal(err.timeoutMs, 40);
        return true;
      },
    );
  });
});

test("per-call timeoutMs overrides the env default", async () => {
  await withEnv("PLATFORM_FETCH_TIMEOUT_MS", "5000", async () => {
    const t0 = Date.now();
    await assert.rejects(
      fetchWithTimeout("https://upstream.test/hang", {}, { fetchImpl: hangingFetch(), timeoutMs: 40 }),
      (err) => {
        assert.equal(err.code, "FETCH_TIMEOUT");
        assert.equal(err.timeoutMs, 40, "per-call override must win over the env default");
        return true;
      },
    );
    assert.ok(Date.now() - t0 < 2000);
  });
});

test("caller-initiated abort passes through as non-retryable, deadline keeps working alongside it", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    fetchWithTimeout("https://upstream.test/hang", { signal: controller.signal }, { fetchImpl: hangingFetch(), timeoutMs: 5000 }),
    (err) => {
      assert.equal(err.name, "AbortError");
      assert.equal(isRetryableFetchError(err), false, "a caller cancel is not a retryable upstream failure");
      return true;
    },
  );
});

test("retryability classification: timeout/network retryable, 4xx-semantic not", () => {
  assert.equal(isRetryableFetchError(new FetchTimeoutError(1000, "https://x.test")), true);
  assert.equal(isRetryableFetchError(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })), true, "raw AbortSignal.timeout leak");
  assert.equal(isRetryableFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })), true);
  assert.equal(isRetryableFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })), true);
  assert.equal(isRetryableFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })), true);
  assert.equal(isRetryableFetchError(new AbortError()), false);
  assert.equal(isRetryableFetchError(new Error("Logto HTTP 401")), false);

  assert.equal(isRetryableHttpStatus(400), false);
  assert.equal(isRetryableHttpStatus(401), false);
  assert.equal(isRetryableHttpStatus(403), false);
  assert.equal(isRetryableHttpStatus(408), true);
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(500), true);
  assert.equal(isRetryableHttpStatus(503), true);
});

function AbortError() {
  // AbortController.abort() without a reason rejects fetches with a DOMException
  // named AbortError; reproduce the shape for the classifier.
  const e = new Error("This operation was aborted");
  e.name = "AbortError";
  return e;
}

// ── login path: gateway/mp-auth code2Session ─────────────────────────────────

test("mp-auth code2Session: a stalled WeChat endpoint fails retryable within the bound, login surfaces it", async () => {
  const { createMpAuth } = await import("../gateway/mp-auth.js");
  await withEnv("PLATFORM_FETCH_TIMEOUT_MS", "50", async () => {
    const mp = createMpAuth({
      appid: "wx-test",
      mpSecret: "secret-test",
      tokenSecret: "token-secret-test",
      ttlHours: 1,
      codeUrl: "https://api.weixin.test/sns/jscode2session",
      bindings: { get: () => null },
      fetchImpl: hangingFetch(), // 端点停滞：永不响应，只听 abort
    });
    const t0 = Date.now();
    const out = await mp.login("some-login-code");
    assert.equal(out.ok, false);
    assert.equal(out.status, 502);
    assert.equal(out.error, "WeChat code2Session unreachable", "login surface shows the retryable failure");
    assert.ok(Date.now() - t0 < 2000, "exchange must fail within the configured bound, not hang the browser session");
  });
});

test("mp-auth code2Session: a healthy endpoint still answers through the wrapper", async () => {
  const { createMpAuth, verifyMpJwt } = await import("../gateway/mp-auth.js");
  const mp = createMpAuth({
    appid: "wx-test",
    mpSecret: "secret-test",
    tokenSecret: "token-secret-test",
    ttlHours: 1,
    codeUrl: "https://api.weixin.test/sns/jscode2session",
    bindings: {
      get: (openid) => (openid === "o-abc" ? { email: "owner@finddatatech.cloud", groups: [] } : null),
    },
    fetchImpl: async () => ({ json: async () => ({ openid: "o-abc" }) }),
  });
  const out = await mp.login("some-login-code");
  assert.equal(out.ok, true);
  assert.equal(out.email, "owner@finddatatech.cloud");
  const payload = verifyMpJwt(out.token, "token-secret-test");
  assert.equal(payload?.sub, "o-abc");
});

// ── MCP bridge family: server/fleet-mcp report_status ────────────────────────

test("fleet-mcp report_status: a stalled bridge surfaces the structured retryable timeout", async () => {
  const savedFetch = globalThis.fetch;
  const savedSecret = process.env.CELL_GATEWAY_SECRET;
  try {
    globalThis.fetch = hangingFetch(); // bridge 停滞：只听 abort
    const { toolReport } = await import("../server/fleet-mcp.js");
    await withEnv("FLEET_MCP_BRIDGE_TIMEOUT_MS", "50", async () => {
      const t0 = Date.now();
      await assert.rejects(
        toolReport({ summary: "patrol ok", metrics: {} }),
        (err) => {
          assert.equal(err.code, "FETCH_TIMEOUT", "bridge failures must be distinguishable as structured timeouts");
          assert.equal(err.retryable, true);
          assert.equal(isRetryableFetchError(err), true);
          assert.match(err.message, /timed out after 50ms/);
          return true;
        },
      );
      assert.ok(Date.now() - t0 < 2000, "the calling lane records the failure instead of hanging");
    });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedSecret === undefined) delete process.env.CELL_GATEWAY_SECRET;
    else process.env.CELL_GATEWAY_SECRET = savedSecret;
  }
});

test("fleet-mcp report_status: a healthy bridge still files the report through the wrapper", async () => {
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, _init = {}) => ({
      ok: true,
      status: 200,
      json: async () => ({
        memberTitle: "巡逻哨",
        fleetName: "演示舰队",
        slotsAccepted: ["kpi_visits"],
        slotsUnrecognized: [],
        declaredSlots: ["kpi_visits"],
        windowResetsAt: new Date("2026-11-07T00:00:00Z").toISOString(),
      }),
    });
    const { toolReport } = await import("../server/fleet-mcp.js");
    const out = await toolReport({ summary: "patrol ok", metrics: { kpi_visits: { value: 3 } } });
    assert.equal(out.isError, undefined);
    assert.match(out.content[0].text, /Report filed for post/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
