// Paper-trading board server side (add-paper-trading-board).
// Run: node --test scripts/test-paper-trading-board.mjs
//
//   1.x 四块都从用户自己的 fdt_ 令牌直读，渲染真实形状
//   2.x 无凭据 → 未连接卡 + 连接入口；发出零个上游请求
//   3.x 401 → 清凭据 + 未连接；不透传明文
//   4.x 单块失败只降级该块
//   5.x 只读：没有任何块带 actions
import test from "node:test";
import assert from "node:assert/strict";
import { PaperTradingBoardAdapter } from "../lib/board-adapters.js";


// The live endpoint's shape (curl 2026-11-26): the figure is `daily_pnl`, not
// `total`. A fixture that invents a field makes the block pass for the wrong
// reason — the first live walk-through read "部分缺失：当日盈亏" against a 200.
const REAL_PNL = (v) => ({
  account_id: "acc-1", as_of: "2026-11-26T12:10:48Z", day_start: "2026-11-26T00:00:00Z",
  baseline: "previous_close", realized_today: v, unrealized: "0", daily_pnl: v,
  gaps: [], unattributed_fills: 0,
});

const ACCOUNT = { id: "acc-1", name: "主力", starting_balance: "100000", cash_balance: "90000" };

function fakeFetch(byPath, { calls = [] } = {}) {
  return async (url) => {
    const u = new URL(url);
    const path = u.pathname + (u.search || "");
    calls.push(path);
    // match on the PATHNAME: routes carry a query (?status=OPEN) that the
    // fixtures key without — matching the full string silently falls to 404 and
    // makes "block failed" tests pass for the wrong reason.
    const hit = Object.entries(byPath)
      .filter(([p]) => u.pathname.startsWith(p))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (!hit) return { ok: false, status: 404, text: async () => "not found" };
    const v = hit[1];
    if (typeof v === "number") return { ok: false, status: v, text: async () => `status ${v}` };
    return { ok: true, status: 200, json: async () => v };
  };
}

function adapter(deps) {
  return new PaperTradingBoardAdapter({ apiBase: "https://paper.test", deps });
}

test("four blocks read the user's own token and never leak it", async () => {
  const calls = [];
  const a = adapter({
    liveToken: () => "fdt_SECRET",
    markInvalid: () => { throw new Error("must not mark invalid on 200"); },
    fetch: fakeFetch({
      "/api/v1/accounts/acc-1/positions": [{ symbol: "600000", quantity: "100.00000000", avg_price: "10.00000000", unrealized_pnl: "33.00000000" }],
      "/api/v1/accounts/acc-1/daily-pnl": REAL_PNL("12.5"),
      "/api/v1/accounts/acc-1/orders": [{ id: "o1", symbol: "600000", side: "BUY", quantity: "100.00000000", order_type: "LIMIT", status: "OPEN", limit_price: "9.00000000" }],
      "/api/v1/strategy-runs": [{ id: "r1", strategy_id: "strat-1", status: "RUNNING", created_at: "2026-11-26T00:00:00Z", params: { last_bar_date: "2026-11-25" } }],
      "/api/v1/accounts/acc-1": { ...ACCOUNT },
      "/api/v1/accounts": [ACCOUNT],
    }, { calls }),
  });
  const out = await a.fetchBlocks({ email: "u@x.io" });
  assert.equal(out.connected, true);
  assert.deepEqual(out.blocks.map((b) => b.id), ["overview", "positions", "orders", "runs"]);
  assert.equal(out.blocks[0].data.live_runs, 1);
  // The field name is load-bearing: reading `total` against the live shape
  // left the overview reporting "部分缺失：当日盈亏" on a 200.
  assert.equal(out.blocks[0].data.daily_pnl, "12.5");
  assert.match(out.blocks[0].data.cash, /^90000$/, "metrics trim Decimal(8) zeros too");
  assert.equal(out.blocks[0].error, undefined, "a fully covered account must not report missing parts");
  assert.equal(out.blocks[1].data[0].title, "600000");
  // The service speaks Decimal(8): a board shows "100", not "100.00000000".
  assert.match(out.blocks[2].data[0].title, /BUY 100 600000/);
  assert.match(out.blocks[2].data[0].badges[0], /限价 9$/);
  // the token must never surface in any block
  assert.ok(!JSON.stringify(out).includes("fdt_SECRET"), "token leaked into blocks");
});

test("no token => unconnected card and ZERO upstream calls", async () => {
  const calls = [];
  const a = adapter({ liveToken: () => null, markInvalid: () => {}, fetch: fakeFetch({}, { calls }) });
  const out = await a.fetchBlocks({ email: "u@x.io" });
  assert.equal(out.connected, false);
  assert.equal(calls.length, 0, `no request may be made without a credential (got ${calls})`);
  assert.match(out.connectPath, /panel=paper-trading/);
});

test("401 clears the credential and goes unconnected", async () => {
  let marked = 0;
  const a = adapter({
    liveToken: () => "fdt_X",
    markInvalid: () => { marked += 1; },
    fetch: fakeFetch({ "/api/v1/accounts": 401 }),
  });
  const out = await a.fetchBlocks({ email: "u@x.io" });
  assert.equal(out.connected, false);
  assert.equal(marked, 1);
});

test("one block failing degrades only that block", async () => {
  const a = adapter({
    liveToken: () => "fdt_X",
    markInvalid: () => {},
    fetch: fakeFetch({
      "/api/v1/accounts": [ACCOUNT],
      "/api/v1/accounts/acc-1/positions": [],
      "/api/v1/accounts/acc-1/daily-pnl": REAL_PNL("1"),
      "/api/v1/accounts/acc-1/orders": 500,
      "/api/v1/strategy-runs": [],
      "/api/v1/accounts/acc-1": { ...ACCOUNT },
    }),
  });
  const out = await a.fetchBlocks({ email: "u@x.io" });
  assert.equal(out.connected, true);
  const orders = out.blocks.find((b) => b.id === "orders");
  assert.ok(orders.error, "the failing block must carry an error");
  assert.ok(!out.blocks.find((b) => b.id === "positions").error, "siblings stay clean");
});

test("the board is read-only: no block carries actions", async () => {
  const a = adapter({
    liveToken: () => "fdt_X",
    markInvalid: () => {},
    fetch: fakeFetch({
      "/api/v1/accounts": [ACCOUNT],
      "/api/v1/accounts/acc-1/positions": [],
      "/api/v1/accounts/acc-1/daily-pnl": REAL_PNL("1"),
      "/api/v1/accounts/acc-1/orders": [],
      "/api/v1/strategy-runs": [],
      "/api/v1/accounts/acc-1": { ...ACCOUNT },
    }),
  });
  const out = await a.fetchBlocks({ email: "u@x.io" });
  for (const b of out.blocks) {
    assert.equal(b.actions, undefined, `block ${b.id} must not carry actions`);
    assert.ok(Array.isArray(b.links) && b.links.length > 0, `block ${b.id} needs a deep link`);
  }
});

test("positions carry unrealized P&L computed from today's close, and omit it when there is none", async () => {
  const todayTs = Math.floor(Date.now() / 1000);
  const oldTs = todayTs - 86400 * 3;
  const a = adapter({
    liveToken: () => "fdt_X",
    markInvalid: () => {},
    fetch: fakeFetch({
      "/api/v1/accounts": [ACCOUNT],
      "/api/v1/accounts/acc-1": { ...ACCOUNT },
      "/api/v1/accounts/acc-1/daily-pnl": REAL_PNL("0"),
      "/api/v1/accounts/acc-1/orders": [],
      "/api/v1/strategy-runs": [],
      "/api/v1/accounts/acc-1/positions": [
        // 100 @ 10, today's close 12  => +200.00
        { symbol: "600000", quantity: "100.00000000", avg_price: "10.00000000", realized_pnl: "0.0000" },
        // only an old bar => no honest mark => no badge at all
        { symbol: "000001", quantity: "100.00000000", avg_price: "10.00000000", realized_pnl: "0.0000" },
      ],
      "/api/v1/instruments/600000/bars": [{ ts: oldTs, open: "9", high: "13", low: "8", close: "11" }, { ts: todayTs, open: "11", high: "13", low: "10", close: "12" }],
      "/api/v1/instruments/000001/bars": [{ ts: oldTs, open: "9", high: "13", low: "8", close: "11" }],
    }),
  });
  const out = await a.fetchBlocks({ email: "u@x.io" });
  const positions = out.blocks.find((b) => b.id === "positions");
  assert.deepEqual(positions.data[0].badges, ["未实现 200.00"]);
  assert.deepEqual(positions.data[1].badges, [], "no same-day close must not invent a figure");
});
