// Unit tests for the P1 UE pageset data plane and page view-models
// (openspec: add-erp-miniapp-pagesets P1 2.1-2.4). node --test imports the
// .ts sources directly (Node type stripping). The ERP transport is injected
// (makeUeApi/mock) — never a second real client; the confirm-gate page flows
// drive the REAL ConfirmGate machine (the integration path) with mock
// endpoints.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ErpApiError,
  ERP_API_BASE,
  buildQuery,
  makeUeApi,
  parseErpEnvelope,
} from "./erp-api.ts";
import {
  CAPABILITY_UNAVAILABLE_TITLE,
  capabilityUnavailableText,
  cartTotals,
  creditExplain,
  disputeFormError,
  fmtAmount,
  fulfillmentView,
  orderFormError,
  orderPayload,
  orderStatusText,
  statementDecisionBody,
  statementReceiptText,
  statementStatusText,
  submitOrderFlow,
  submitStatementFlow,
} from "./ue-view.ts";
import { createConfirmGateMachine } from "../components/ConfirmGate/confirm-gate.ts";

// ---- mock transport（记录请求 + 按路径回放统一壳；路径已剥 ERP_API_BASE）----

function mockTransport(respond) {
  const calls = [];
  const transport = (path, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const rel = path.replace(ERP_API_BASE, "");
    calls.push({ method, path: rel, body });
    const r = respond(method, rel.split("?")[0], body);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: "",
      json: async () => r.payload,
    });
  };
  transport.calls = calls;
  return transport;
}

function okShell(data) {
  return { status: 200, payload: { ok: true, data, rows_returned: 0 } };
}

function listShell(rows) {
  return {
    status: 200,
    payload: { ok: true, data: rows, rows_returned: rows.length, total: rows.length, offset: 0, limit: 500, truncated: false },
  };
}

function errShell(status, code, message, detail) {
  return { status, payload: { ok: false, error: { code, message, hint: "", detail: detail ?? {} }, rows_returned: 0 } };
}

// ---- erp-api：统一壳解析 / 查询串 / 端点路径 ----

test("erp-api: ok 壳解出整壳（列表元数据在 body 平级）；error 壳抛 ErpApiError", () => {
  const body = parseErpEnvelope({ ok: true, data: { a: 1 }, total: 3, truncated: false }, 200);
  assert.deepEqual(body.data, { a: 1 });
  assert.equal(body.total, 3);

  assert.throws(
    () => parseErpEnvelope({ ok: false, error: { code: "CREDIT_EXCEEDED", message: "额度不足", detail: { shortfall: "5" } } }, 400),
    (e) => {
      const err = /** @type {ErpApiError} */ (e);
      return err instanceof ErpApiError && err.code === "CREDIT_EXCEEDED" && err.message === "额度不足"
        && err.status === 400 && err.detail.shortfall === "5";
    },
  );
  // 畸形壳：绝不猜成功
  assert.throws(() => parseErpEnvelope(null, 200), ErpApiError);
  assert.throws(() => parseErpEnvelope({ nope: true }, 200), ErpApiError);
  assert.throws(() => parseErpEnvelope({ ok: false }, 500), ErpApiError);
});

test("erp-api: NOT_IMPLEMENTED(501) → notImplemented（如实能力未提供的判定）", async () => {
  const t = mockTransport(() => errShell(501, "NOT_IMPLEMENTED", "开票申请后端能力未就绪"));
  const api = makeUeApi(t);
  await assert.rejects(
    api.invoiceRequests(),
    (e) => e instanceof ErpApiError && e.notImplemented === true && e.message === "开票申请后端能力未就绪",
  );
  // 400 的 NOT_IMPLEMENTED 码同样判定（status 与 code 双判）
  const t2 = mockTransport(() => errShell(400, "NOT_IMPLEMENTED", "x"));
  await assert.rejects(makeUeApi(t2).invoiceRequests(), (e) => e instanceof ErpApiError && e.notImplemented === true);
});

test("erp-api: buildQuery 跳过空值并编码", () => {
  assert.equal(buildQuery({ keyword: "可乐", categoryId: undefined, limit: 20 }), "?keyword=%E5%8F%AF%E4%B9%90&limit=20");
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery({ keyword: "" }), "");
});

test("erp-api: 端点路径与契约一一对应（14 实现路径逐条）", async () => {
  const t = mockTransport((method, path) => {
    if (path === "/ue/products" && method === "GET") return listShell([{ productId: "SKU-001" }]);
    if (path === "/ue/product-categories") return listShell([]);
    if (path === "/ue/products/SKU-001") return okShell({ productId: "SKU-001" });
    if (path === "/ue/cart") return okShell({ lines: [], line_count: 0 });
    if (path === "/ue/cart/lines" && method === "POST") return okShell({ line_id: "L1" });
    if (path === "/ue/cart/lines/L1" && method === "DELETE") return okShell({ lines: [] });
    if (path === "/ue/cart/price-preview") return okShell({ amount_total: "20" });
    if (path === "/ue/orders" && method === "POST") return okShell({ accepted: true, order_ref: "SO-1" });
    if (path === "/ue/orders" && method === "GET") return listShell([]);
    if (path === "/ue/orders/SO-1") return okShell({ orderId: "SO-1" });
    if (path === "/ue/orders/SO-1/fulfillment") return okShell({ plans: [] });
    if (path === "/ue/statements") return listShell([]);
    if (path === "/ue/statements/ST-1") return okShell({ statement_id: "ST-1" });
    if (path === "/ue/statements/ST-1/confirm") return okShell({ proposal_status: "pending" });
    return { status: 404, payload: { ok: false, error: { code: "NOT_FOUND", message: "unknown path" } } };
  });
  const api = makeUeApi(t);
  await api.products({ keyword: "水", limit: 10 });
  await api.productCategories();
  await api.productDetail("SKU-001");
  await api.cart();
  await api.addCartLine({ productId: "SKU-001", qty: 2, unit: "箱" });
  await api.removeCartLine("L1");
  await api.pricePreview({ lines: [{ productId: "SKU-001", qty: 2 }] });
  await api.createOrder({ lines: [{ productId: "SKU-001", qty: 2 }], shipping: { contact: "a", phone: "b", address: "c" }, note: "" });
  await api.orders({ status: "pending" });
  await api.orderDetail("SO-1");
  await api.orderFulfillment("SO-1");
  await api.statements({ status: "open" });
  await api.statementDetail("ST-1");
  await api.confirmStatement("ST-1", { decision: "confirmed" });
  const paths = t.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths.slice(0, 14), [
    "GET /ue/products?keyword=%E6%B0%B4&limit=10",
    "GET /ue/product-categories",
    "GET /ue/products/SKU-001",
    "GET /ue/cart",
    "POST /ue/cart/lines",
    "DELETE /ue/cart/lines/L1",
    "POST /ue/cart/price-preview",
    "POST /ue/orders",
    "GET /ue/orders?status=pending",
    "GET /ue/orders/SO-1",
    "GET /ue/orders/SO-1/fulfillment",
    "GET /ue/statements?status=open",
    "GET /ue/statements/ST-1",
    "POST /ue/statements/ST-1/confirm",
  ]);
});

// ---- ue-view：各页判定逻辑（每页至少一条）----

test("ue-view: 状态文案（order-list / statement-confirm 列表徽章）", () => {
  assert.equal(orderStatusText("pending"), "待确认");
  assert.equal(orderStatusText("confirmed"), "已确认");
  assert.equal(orderStatusText("cancelled"), "已取消");
  assert.equal(orderStatusText(undefined), "状态未知");
  assert.equal(statementStatusText("open"), "待确认");
  assert.equal(statementStatusText("confirming"), "确认中（确认门待决）");
  assert.equal(statementStatusText("disputed_pending"), "异议处置中");
  assert.equal(statementStatusText("confirmed"), "已确认");
});

test("ue-view: fmtAmount 不引入浮点误差（字符串金额原样千分位）", () => {
  assert.equal(fmtAmount("12000.500000"), "12,000.5");
  assert.equal(fmtAmount("20"), "20");
  assert.equal(fmtAmount("0.000000"), "0");
  assert.equal(fmtAmount(null), "—");
  assert.equal(fmtAmount("5000"), "5,000");
});

test("ue-view: cartTotals（进货单页汇总，行 quote 求和）", () => {
  const t = cartTotals([
    { product: "SKU-001", qty: 2, quote: { line_total: "20" } },
    { product: "SKU-002", qty: 1, quote: { line_total: "25.5" } },
  ]);
  assert.equal(t.count, 2);
  assert.equal(t.amount, "45.5");
  assert.deepEqual(cartTotals([{ product: "x", qty: 1, quote: null }]), { count: 1, amount: "0" });
});

test("ue-view: orderPayload + orderFormError（order-create 页表单判定）", () => {
  const lines = [{ product: "SKU-001", qty: 2, unit: "箱", quote: { line_total: "20" } }];
  const body = orderPayload(lines, { contact: "张三", phone: "138", address: "上海" }, "尽快发");
  assert.deepEqual(body, {
    lines: [{ productId: "SKU-001", qty: 2, unit: "箱" }],
    shipping: { contact: "张三", phone: "138", address: "上海" },
    note: "尽快发",
  });
  assert.equal(orderFormError([], { contact: "a", phone: "b", address: "c" }), "进货单为空，请先添加商品");
  assert.equal(orderFormError(lines, { contact: "", phone: "b", address: "c" }), "请填写收货联系人");
  assert.equal(orderFormError(lines, { contact: "a", phone: "", address: "c" }), "请填写联系电话");
  assert.equal(orderFormError(lines, { contact: "a", phone: "b", address: " " }), "请填写收货地址");
  assert.equal(orderFormError(lines, { contact: "a", phone: "b", address: "c" }), null);
});

test("ue-view: creditExplain 附占用明细（CREDIT_EXCEEDED 可解释拒绝）", () => {
  const text = creditExplain({
    code: "CREDIT_EXCEEDED",
    message: "订单金额超出可用信用额度（fail-closed 拒单）",
    detail: {
      limit: "5000",
      ar_balance: "1000",
      reserved: "1000",
      available: "3000",
      requested_amount: "3500.5",
      shortfall: "500.5",
      currency: "CNY",
      note: "订单金额超出可用信用额度（额度 = limit - 应收 - 已占用）",
    },
  });
  assert.match(text, /订单金额超出可用信用额度/);
  assert.match(text, /可用额度 3,000 CNY/);
  assert.match(text, /本单金额 3,500\.5 CNY/);
  assert.match(text, /缺口 500\.5 CNY/);
  assert.match(text, /额度 5,000/);
  assert.match(text, /应收 1,000/);
  assert.match(text, /已占用 1,000/);
  // 无 detail 时至少保留服务器原话
  assert.equal(creditExplain({ code: "CREDIT_EXCEEDED", message: "额度不足" }), "额度不足");
});

test("ue-view: fulfillmentView（order-detail 页履约面如实三态）", () => {
  // 404：未确认订单无履约编排 —— 如实说明，不是错误
  assert.match(fulfillmentView(null), /暂无履约编排/);
  assert.match(fulfillmentView(null), /未确认订单不产生履约移交/);
  // handoff_pending：已移交待编排，不伪造计划
  assert.match(
    fulfillmentView({ handoff_pending: true, note: "订单已确认并移交履约（handoff 记录在编排档）" }),
    /移交履约/,
  );
  // plans：行数 + note
  assert.match(fulfillmentView({ plans: [{}, {}], note: "同源编排面" }), /履约计划 2 条/);
  assert.match(fulfillmentView({ plans: [] }), /暂无计划明细/);
});

test("ue-view: statementDecisionBody / disputeFormError / statementReceiptText（确认门页判定）", () => {
  assert.deepEqual(statementDecisionBody("confirmed", ""), { decision: "confirmed" });
  assert.deepEqual(statementDecisionBody("disputed", " 差异 50 元 "), { decision: "disputed", disputeNote: "差异 50 元" });
  assert.equal(disputeFormError("  "), "异议须附说明（将对账差异写清楚）");
  assert.equal(disputeFormError("差异"), null);
  // 回执如实：pending 不假报已确认
  assert.match(statementReceiptText({ proposal_status: "pending", note: "确认已提交内核确认门（pending）" }), /确认门/);
  assert.match(statementReceiptText({ proposal_status: "pending" }), /不记已确认|确认门/);
  assert.match(statementReceiptText({ disputed: true }), /处置车道/);
  assert.match(statementReceiptText({ proposal_status: "confirmed", duplicate: true }), /确认门/);
});

test("ue-view: capabilityUnavailable（501 页面如实文案，不伪装）", () => {
  const t = capabilityUnavailableText({ notImplemented: true, message: "售后流后端能力未就绪" });
  assert.equal(t.title, CAPABILITY_UNAVAILABLE_TITLE);
  assert.equal(CAPABILITY_UNAVAILABLE_TITLE, "该能力当前未提供");
  assert.match(t.message, /售后流后端能力未就绪/);
  assert.match(t.message, /如实/);
  // 非 501 错误不走该区块（页面区分 loading/error/501 三态）
  const other = capabilityUnavailableText({ notImplemented: false, message: "网络错误" });
  assert.equal(other.title, CAPABILITY_UNAVAILABLE_TITLE);
  assert.equal(other.message, "网络错误");
});

test("ue-view: ai-assistant 同源取数（页面源无任何取数调用：无 ueApi/REST/WS 面）", () => {
  // ai-assistant 页唯一数据来源是底座 chat 面（api-contract §7 无独立 AI
  // 端点）。直接核验页面源文本：不 import ue-api-wire、不调 Taro.request /
  // fetch / wsSend / erp——零平行取数路径。
  const src = readFileSync(new URL("../pages/ue/ai-assistant/index.tsx", import.meta.url), "utf-8");
  assert.doesNotMatch(src, /ueApi|ue-api-wire|Taro\.request|erpRequest|fetch\(|wsSend\(|WebSocket/);
  // 唯一去向是底座 chat 面。
  assert.match(src, /pages\/chat\/index/);
});

// ---- ConfirmGate 集成路径（确认门页 flow 直驱真机器）----

function gateFor(machine) {
  return {
    start(perform) {
      machine.start(perform);
    },
  };
}

/** 冲走全部微任务（flow 的 async perform 链：请求 → 解壳 → settle）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("order-create 确认门集成：受理确认 → 收据", async () => {
  const settled = [];
  const machine = createConfirmGateMachine({ onSettled: (r) => settled.push(r) });
  let receipt = null;
  const t = mockTransport(() => okShell({ accepted: true, order_ref: "SO-1", status: "pending" }));
  const api = makeUeApi(t);

  submitOrderFlow(gateFor(machine), {
    createOrder: (body) => api.createOrder(body),
    body: orderPayload([{ product: "SKU-001", qty: 2 }], { contact: "a", phone: "b", address: "c" }, ""),
    onConfirmed: (r) => {
      receipt = r;
    },
  });
  await flush();
  assert.equal(machine.snapshot().pending, false);
  assert.equal(machine.snapshot().error, null);
  assert.deepEqual(settled, [{ outcome: "confirmed" }]);
  assert.equal(receipt.order_ref, "SO-1");
  assert.equal(t.calls[0].path, "/ue/orders");
});

test("order-create 确认门集成：CREDIT_EXCEEDED 拒绝回显占用明细，表单不关", async () => {
  const settled = [];
  const machine = createConfirmGateMachine({ onSettled: (r) => settled.push(r) });
  const t = mockTransport(() =>
    errShell(400, "CREDIT_EXCEEDED", "订单金额超出可用信用额度（fail-closed 拒单）", {
      available: "3000",
      requested_amount: "3500",
      shortfall: "500",
      currency: "CNY",
    }),
  );
  const api = makeUeApi(t);

  submitOrderFlow(gateFor(machine), {
    createOrder: (body) => api.createOrder(body),
    body: orderPayload([{ product: "SKU-001", qty: 350 }], { contact: "a", phone: "b", address: "c" }, ""),
  });
  await flush();
  assert.equal(machine.snapshot().pending, false);
  // 拒绝可解释：message + 占用明细
  assert.match(machine.snapshot().error, /订单金额超出可用信用额度/);
  assert.match(machine.snapshot().error, /可用额度 3,000/);
  assert.match(machine.snapshot().error, /缺口 500/);
  assert.deepEqual(settled, [{ outcome: "rejected", message: machine.snapshot().error }]);
});

test("order-create 确认门集成：超时兜底不假报成功（真机器 8s 窗口）", async () => {
  let onTimeout = null;
  const timers = {
    setTimeout(fn) {
      onTimeout = fn;
      return 1;
    },
    clearTimeout() {},
  };
  const settled = [];
  const machine = createConfirmGateMachine({ timers, onSettled: (r) => settled.push(r) });
  // 端点永不回（挂起的 promise）→ 机器 pending → 超时兜底
  submitOrderFlow(gateFor(machine), {
    createOrder: () => new Promise(() => {}),
    body: orderPayload([{ product: "SKU-001", qty: 1 }], { contact: "a", phone: "b", address: "c" }, ""),
  });
  await Promise.resolve();
  assert.equal(machine.snapshot().pending, true);
  onTimeout();
  assert.equal(machine.snapshot().pending, false);
  assert.equal(machine.snapshot().error, "服务器未确认，请检查连接后重试");
  assert.deepEqual(settled, [{ outcome: "timeout" }]);
});

test("statement-confirm 确认门集成：确认回执如实 pending（不假报已确认）", async () => {
  const settled = [];
  const machine = createConfirmGateMachine({ onSettled: (r) => settled.push(r) });
  let receiptText = null;
  const t = mockTransport(() =>
    okShell({
      statement_id: "ST-1",
      proposal_status: "pending",
      note: "确认已提交内核确认门（pending）：确认落账前对账单不记已确认",
    }),
  );
  const api = makeUeApi(t);

  submitStatementFlow(gateFor(machine), {
    confirmStatement: (body) => api.confirmStatement("ST-1", body),
    body: statementDecisionBody("confirmed", ""),
    onConfirmed: (r) => {
      receiptText = statementReceiptText(r);
    },
  });
  await flush();
  assert.equal(machine.snapshot().error, null);
  assert.deepEqual(settled, [{ outcome: "confirmed" }]);
  assert.match(receiptText, /确认门/);
  assert.equal(t.calls[0].path, "/ue/statements/ST-1/confirm");
});

test("statement-confirm 确认门集成：异议附说明（空说明端上先挡）", async () => {
  const settled = [];
  const t = mockTransport(() => okShell({ disputed: true, disposal_status: "pending" }));
  const api = makeUeApi(t);
  const machine = createConfirmGateMachine({ onSettled: (r) => settled.push(r) });
  // 空说明：submit 前置校验挡下（页面不发请求）
  assert.notEqual(disputeFormError("  "), null);
  // 有说明：发出 dispute 请求；mock 即回 → 机器走完确认路径
  submitStatementFlow(gateFor(machine), {
    confirmStatement: (body) => api.confirmStatement("ST-1", body),
    body: statementDecisionBody("disputed", "差异 50 元"),
  });
  await flush();
  assert.equal(t.calls[0].body.decision, "disputed");
  assert.equal(t.calls[0].body.disputeNote, "差异 50 元");
  assert.deepEqual(settled, [{ outcome: "confirmed" }]);
  assert.equal(machine.snapshot().pending, false);
  assert.equal(machine.snapshot().error, null);
});

// ---- 列表页数据形状（order-list / invoice-apply / aftersale-detail 共用 ListEnvelope）----

test("erp-api: ListEnvelope 形状贯穿列表页（total/truncated 驱动加载更多）", async () => {
  const rows = [{ orderId: "SO-1" }, { orderId: "SO-2" }];
  const t = mockTransport(() => ({
    status: 200,
    payload: { ok: true, data: rows, rows_returned: 2, total: 5, offset: 0, limit: 2, truncated: true },
  }));
  const res = await makeUeApi(t).orders({});
  assert.equal(res.data.length, 2);
  assert.equal(res.total, 5);
  assert.equal(res.truncated, true);
});
