// Unit tests for the SE / SP / CP page sets (openspec:
// add-erp-miniapp-pagesets P2 3.1-3.6 / 4.1-4.7, P3 5.1-5.8).
//
// Same discipline as ue-pages.test.mjs: node --test imports the .ts sources
// directly, the ERP transport is injected (never a second real client), and the
// confirm-gate flows drive the REAL ConfirmGate machine with mock endpoints.
// What these tests pin down:
//   - identity resolution is fail-closed (no binding -> no header, no request);
//   - every implemented endpoint's path/verb matches the api-contract;
//   - 501 endpoints are recognised as "capability unavailable", not failures;
//   - gate flows: confirm-on-receipt, reject-verbatim, timeout-never-success;
//   - receipts never claim more than the server said (pending ≠ confirmed);
//   - the AI entry pages make no network call at all (same-source discipline).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ERP_API_BASE, ErpApiError } from "./erp-api.ts";
import { identityHeaders, parseSurfaceBindings, resolveSurfaceIdentity, withSurfaceIdentity } from "./identity.ts";
import { makeCpApi, makeSeApi, makeSpApi } from "./surface-api.ts";
import {
  alertReceipt,
  arrivalNoticeFormError,
  deliveryFeedbackFormError,
  dockFormError,
  errorTextOf,
  isCapabilityUnavailable,
  podFormError,
  podReceipt,
  poAcceptReceipt,
  poStatusText,
  proxyOrderFormError,
  proxyOrderReceipt,
  rejectReasonError,
  severityText,
  submitDecisionFlow,
  surfaceErrorText,
  waybillAcceptReceipt,
  waybillStatusText,
} from "./surface-view.ts";
import { createConfirmGateMachine } from "../components/ConfirmGate/confirm-gate.ts";

// ---- mock transport（记录方法/路径/身份头，按路径回放统一壳）----

function mockTransport(respond, headers = {}) {
  const calls = [];
  const transport = (path, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const rel = path.replace(ERP_API_BASE, "");
    calls.push({ method, path: rel.split("?")[0], query: rel.includes("?") ? rel.split("?")[1] : "", body, headers: init?.headers ?? {} });
    const r = respond(method, rel.split("?")[0], body);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: "",
      json: async () => r.payload,
    });
  };
  return { calls, transport: withSurfaceIdentity(transport, () => headers) };
}

const okShell = (data, extra = {}) => ({ ok: true, data, rows_returned: Array.isArray(data) ? data.length : undefined, ...extra });
const errShell = (code, message, detail = null) => ({ ok: false, error: { code, message, detail }, rows_returned: 0 });

// ---- identity（fail-closed 是这套页面集的地基）----

test("identity: 四种面集的身份头映射（UE 不需要外部身份）", () => {
  assert.equal(resolveSurfaceIdentity("supply-chain.ue").header, "");
  assert.equal(resolveSurfaceIdentity("supply-chain.se").header, "X-ERP-Staff");
  assert.equal(resolveSurfaceIdentity("supply-chain.sp").header, "X-ERP-Supplier");
  assert.equal(resolveSurfaceIdentity("supply-chain.cp").header, "X-ERP-Carrier");
});

test("identity: SE 会话账号即可用；SP/CP 只有绑定才可用（不猜档案 id）", () => {
  const se = resolveSurfaceIdentity("supply-chain.se", { sessionEmail: "rep@example.com" });
  assert.equal(se.value, "rep@example.com");
  assert.equal(se.reason, null);
  assert.deepEqual(identityHeaders(se), { "X-ERP-Staff": "rep@example.com" });

  const sp = resolveSurfaceIdentity("supply-chain.sp", { sessionEmail: "rep@example.com" });
  assert.equal(sp.value, null, "会话账号不能顶替供应商档案");
  assert.match(sp.reason, /X-ERP-Supplier/);
  assert.deepEqual(identityHeaders(sp), {}, "未绑定 → 不带任何身份头");

  const cp = resolveSurfaceIdentity("supply-chain.cp", { bindings: { carrier: "SF-EXPRESS" } });
  assert.equal(cp.value, "SF-EXPRESS");
  assert.deepEqual(identityHeaders(cp), { "X-ERP-Carrier": "SF-EXPRESS" });
});

test("identity: 绑定解析严格（损坏/异形 → 空绑定，不部分信任）", () => {
  assert.deepEqual(parseSurfaceBindings("{}"), {});
  assert.deepEqual(parseSurfaceBindings("{bad json"), {});
  assert.deepEqual(parseSurfaceBindings([1, 2]), {});
  assert.deepEqual(parseSurfaceBindings({ supplier: 42, carrier: "  " }), {});
  assert.deepEqual(parseSurfaceBindings('{"supplier":" SUP-1 "}'), { supplier: "SUP-1" });
  assert.deepEqual(parseSurfaceBindings({ supplier: "SUP-1", junk: "x" }), { supplier: "SUP-1" });
});

test("identity: 未绑定时传输层也不注入头（请求不带假身份）", async () => {
  const { calls, transport } = mockTransport(() => ({ status: 200, payload: okShell([]) }), {});
  const api = makeSeApi(transport, () => ({}));
  await api.workspace();
  assert.deepEqual(calls[0].headers, {});
});

test("identity: 已绑定时每个请求都带头（含 GET）", async () => {
  const { calls, transport } = mockTransport(() => ({ status: 200, payload: okShell({}) }), { "X-ERP-Staff": "S1" });
  const api = makeSeApi(transport, () => ({ "X-ERP-Staff": "S1" }));
  await api.workspace();
  await api.customers({});
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.headers["X-ERP-Staff"], "S1");
});

// ---- 端点路径与契约一一对应 ----

test("se-api: 端点路径与 se-sales 契约逐条对应", async () => {
  const { calls, transport } = mockTransport((_m, rel) => ({ status: 200, payload: okShell(rel.includes("{") ? {} : []) }));
  const api = makeSeApi(transport, () => ({ "X-ERP-Staff": "S1" }));
  await api.workspace();
  await api.customers({ keyword: "acme", limit: 20 });
  await api.customer360("C1");
  await api.customerOrders("C1", { limit: 5 });
  await api.leads({});
  await api.createLead({ name: "线索" });
  await api.createVisit({ customerId: "C1" });
  await api.visits({});
  await api.proxyOrder({ customerId: "C1", lines: [{ productId: "P1", qty: 2 }] });
  await api.orders({ customerId: "C1" });
  await api.orderDetail("O1");
  await api.alerts({ status: "pending" });
  await api.handleAlert("A1", { decision: "accept" });
  await api.statements({});
  await api.pushStatement("ST1", {});
  const paths = calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, [
    "GET /se/workspace",
    "GET /se/customers",
    "GET /se/customers/C1",
    "GET /se/customers/C1/orders",
    "GET /se/leads",
    "POST /se/leads",
    "POST /se/visits",
    "GET /se/visits",
    "POST /se/orders/proxy",
    "GET /se/orders",
    "GET /se/orders/O1",
    "GET /se/alerts",
    "POST /se/alerts/A1/handle",
    "GET /se/statements",
    "POST /se/statements/ST1/push",
  ]);
  assert.match(calls[1].query, /keyword=acme/, "查询参数编码进 query");
});

test("sp-api: 端点路径与 sp-supplier 契约逐条对应", async () => {
  const { calls, transport } = mockTransport(() => ({ status: 200, payload: okShell([]) }));
  const api = makeSpApi(transport, () => ({ "X-ERP-Supplier": "SUP-1" }));
  await api.workspace();
  await api.purchaseOrders({ status: "pushed" });
  await api.purchaseOrder("PO1");
  await api.acceptPurchaseOrder("PO1", { decision: "accepted" });
  await api.deliveryFeedback("PO1", { lines: [], carrier: "SF", waybillNo: "W1" });
  await api.arrivalNotices({});
  await api.createArrivalNotice({ poRef: "PO1", lines: [] });
  await api.statements({});
  await api.statementDetail("ST1");
  await api.confirmStatement("ST1", { decision: "confirmed" });
  await api.invoices();
  await api.uploadInvoice({});
  await api.settlements({});
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      "GET /sp/workspace",
      "GET /sp/purchase-orders",
      "GET /sp/purchase-orders/PO1",
      "POST /sp/purchase-orders/PO1/accept",
      "POST /sp/purchase-orders/PO1/delivery-feedback",
      "GET /sp/arrival-notices",
      "POST /sp/arrival-notices",
      "GET /sp/statements",
      "GET /sp/statements/ST1",
      "POST /sp/statements/ST1/confirm",
      "GET /sp/invoices",
      "POST /sp/invoices",
      "GET /sp/settlements",
    ],
  );
});

test("cp-api: 端点路径与 cp-carrier 契约逐条对应", async () => {
  const { calls, transport } = mockTransport(() => ({ status: 200, payload: okShell([]) }));
  const api = makeCpApi(transport, () => ({ "X-ERP-Carrier": "SF" }));
  await api.workspace();
  await api.waybills({ status: "open" });
  await api.waybill("W1");
  await api.acceptWaybill("W1", { decision: "accepted" });
  await api.dockSlots({});
  await api.reserveDock("W1", { slotId: "SLOT-1" });
  await api.pickupCheckin("W1", { scanCode: "CODE" });
  await api.reportPod("W1", { documents: ["doc-1"] });
  await api.waybillEvents("W1");
  await api.freightStatements({});
  await api.freightDetail("FS1");
  await api.confirmFreight("FS1", { decision: "confirmed" });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      "GET /cp/workspace",
      "GET /cp/waybills",
      "GET /cp/waybills/W1",
      "POST /cp/waybills/W1/accept",
      "GET /cp/dock-slots",
      "POST /cp/waybills/W1/dock-reservation",
      "POST /cp/waybills/W1/pickup-checkin",
      "POST /cp/waybills/W1/pod",
      "GET /cp/waybills/W1/events",
      "GET /cp/freight-statements",
      "GET /cp/freight-statements/FS1",
      "POST /cp/freight-statements/FS1/confirm",
    ],
  );
});

// ---- 501 与闸类错误的人话（如实纪律）----

test("surface-error: 501 判定与文案（能力未提供，不是加载失败）", async () => {
  const { transport } = mockTransport(() => ({
    status: 501,
    payload: errShell("NOT_IMPLEMENTED", "应付对账单后端能力未就绪", 501),
  }));
  const api = makeSpApi(transport, () => ({ "X-ERP-Supplier": "SUP-1" }));
  await assert.rejects(
    () => api.statements({}),
    (e) => {
      assert.ok(e instanceof ErpApiError);
      assert.equal(e.notImplemented, true);
      assert.ok(isCapabilityUnavailable(e));
      const text = errorTextOf(e);
      assert.match(text, /该能力当前未提供/);
      assert.match(text, /应付对账单后端能力未就绪/, "服务器人话原样呈现");
      assert.match(text, /不提供模拟功能/);
      return true;
    },
  );
});

test("surface-error: 闸类错误码逐条可解释（身份/页面集/权限码/数据域/不存在/信用）", () => {
  assert.match(surfaceErrorText({ code: "AUTH_REQUIRED", message: "缺少身份头 X-ERP-Carrier" }), /X-ERP-Carrier/);
  assert.match(surfaceErrorText({ code: "PAGESET_FORBIDDEN", message: "未授权页面集：supply-chain.se" }), /联系管理员开通/);
  assert.match(surfaceErrorText({ code: "GRANT_REQUIRED", message: "缺少权限码：alert.handle" }), /加授/);
  assert.match(surfaceErrorText({ code: "DATA_SCOPE_DENIED", message: "代客下单越权" }), /数据域|代客/);
  assert.match(surfaceErrorText({ code: "NOT_FOUND", message: "客户档案不存在" }), /不泄露存在性/);
  const credit = surfaceErrorText({
    code: "CREDIT_EXCEEDED",
    message: "超出可用信用额度",
    detail: { available: "100", requested_amount: "300", shortfall: "200" },
  });
  assert.match(credit, /可用额度 100/);
  assert.match(credit, /缺口 200/);
});

// ---- 状态词汇 ----

test("surface-view: 三端状态词汇（服务器 status_note 同口径）", () => {
  assert.equal(poStatusText("pushed"), "已推送·待接单");
  assert.equal(poStatusText("rejected"), "已拒单");
  assert.equal(poStatusText("weird"), "weird", "未知状态原样透出，不吞");
  assert.equal(waybillStatusText("open"), "在途流转");
  assert.equal(waybillStatusText("closed"), "已结单");
  assert.equal(severityText("high"), "高");
});

// ---- 表单校验（端上先挡一道）----

test("surface-view: 表单校验（代客下单/拒绝附因/发货/签收/月台/到货预告）", () => {
  assert.match(proxyOrderFormError("", [], {}), /选择代下单客户/);
  assert.match(proxyOrderFormError("C1", [], {}), /至少添加一行/);
  assert.match(proxyOrderFormError("C1", [{ productId: "P1", qty: 0 }], {}), /数量须为正数/);
  assert.match(proxyOrderFormError("C1", [{ productId: "P1", qty: 1 }], { contact: "张" }), /联系电话/);
  assert.equal(
    proxyOrderFormError("C1", [{ productId: "P1", qty: 1 }], { contact: "张", phone: "1", address: "沪" }),
    null,
  );

  assert.match(rejectReasonError("rejected", ""), /拒.*附原因|附原因/);
  assert.equal(rejectReasonError("accepted", ""), null);
  assert.match(rejectReasonError("disputed", " "), /异议须附说明/);

  assert.match(deliveryFeedbackFormError([], "SF", "W1"), /发货明细/);
  assert.match(deliveryFeedbackFormError([{ product: "P1" }], "", "W1"), /物流商/);
  assert.equal(deliveryFeedbackFormError([{ product: "P1" }], "SF", "W1"), null);

  assert.match(podFormError([], ""), /签收凭证/);
  assert.equal(podFormError([], "货物破损"), null);
  assert.equal(podFormError(["doc-1"], ""), null);

  assert.match(dockFormError(" "), /slotId/);
  assert.equal(dockFormError("SLOT-1"), null);

  assert.match(arrivalNoticeFormError("", [{ product: "P1" }]), /poRef/);
  assert.match(arrivalNoticeFormError("PO1", []), /到货明细/);
  assert.equal(arrivalNoticeFormError("PO1", [{ product: "P1" }]), null);
});

// ---- 回执文案（不多说一句）----

test("surface-view: 回执如实（pending 不是已确认；异常签收进处置车道）", () => {
  const proxy = proxyOrderReceipt({
    order_ref: "O1",
    status: "pending",
    amount_total: "100",
    currency: "CNY",
    credit_reservation: { amount: "100" },
    proxy: { requested_by: "se:S1" },
  });
  assert.match(proxy, /进入确认车道/);
  assert.match(proxy, /尚未记已确认/);
  assert.match(proxy, /代理身份留痕 se:S1/);

  assert.match(poAcceptReceipt({ decision: "accepted", po_status: "accepted" }), /已接单/);
  assert.match(poAcceptReceipt({ decision: "rejected", note: "产能不足" }), /拒单.*产能不足|产能不足/);

  assert.match(alertReceipt({ status: "confirmed", request_id: "A1", handled_by: "se:S1" }), /确认生效|已确认/);
  assert.match(alertReceipt({ status: "rejected", note: "误报" }), /留痕不落账/);

  assert.match(waybillAcceptReceipt({ decision: "accepted", status: "accepted" }), /已接单/);

  const ok = podReceipt({ waybill_no: "W1", exception: false, documents: ["d1", "d2"], settlement_note: "结单由计费引擎驱动" });
  assert.match(ok, /签收已上报/);
  assert.match(ok, /回单 2 件/);
  assert.match(ok, /计费引擎/);
  const bad = podReceipt({ waybill_no: "W2", exception: true, disposal_request_id: "T1", disposal_status: "pending" });
  assert.match(bad, /处置车道/);
  assert.match(bad, /T1/);
});

// ---- 确认门集成（真机器 + mock 端点）----

test("确认门集成: SE 代客下单受理 → 回执（不乐观关闭）", async () => {
  const gate = createConfirmGateMachine({ timeoutMs: 10 });
  let confirmed = null;
  submitDecisionFlow(gate, {
    perform: async () => ({ order_ref: "O1", status: "pending" }),
    onConfirmed: (r) => {
      confirmed = r;
    },
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(confirmed, { order_ref: "O1", status: "pending" });
  assert.equal(gate.snapshot().pending, false);
  assert.equal(gate.snapshot().error, null);
});

test("确认门集成: SP 接单被拒 → 服务器人话原样回显（表单保留）", async () => {
  const gate = createConfirmGateMachine({ timeoutMs: 10 });
  submitDecisionFlow(gate, {
    perform: async () => {
      throw new ErpApiError({ code: "NOT_FOUND", message: "采购订单不存在：PO9" }, 404);
    },
  });
  await new Promise((r) => setTimeout(r, 5));
  const err = gate.snapshot().error ?? "";
  assert.match(err, /采购订单不存在：PO9/);
  assert.equal(gate.snapshot().pending, false, "拒绝后不得停在 pending");
});

test("确认门集成: CP 签收走 501 → 如实拒绝，绝不假报成功", async () => {
  const gate = createConfirmGateMachine({ timeoutMs: 10 });
  let confirmed = false;
  submitDecisionFlow(gate, {
    perform: async () => {
      throw new ErpApiError({ code: "NOT_IMPLEMENTED", message: "运费单后端能力未就绪" }, 501);
    },
    onConfirmed: () => {
      confirmed = true;
    },
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(confirmed, false);
  assert.match(gate.snapshot().error ?? "", /该能力当前未提供/);
});

test("确认门集成: 无回执 → 8s 窗口超时兜底（自定义窗口），不是成功", async () => {
  const gate = createConfirmGateMachine({ timeoutMs: 10 });
  let outcome = null;
  const machine = createConfirmGateMachine({
    timeoutMs: 10,
    onSettled: (r) => {
      outcome = r;
    },
  });
  submitDecisionFlow(machine, { perform: () => new Promise(() => {}) });
  assert.equal(machine.snapshot().pending, true, "无回执即进 pending");
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(outcome?.outcome, "timeout");
  assert.match(machine.snapshot().error ?? "", /服务器未确认/);
  gate.dispose();
});

test("确认门集成: 双击防重（pending 期间第二次 start 是 no-op）", () => {
  const gate = createConfirmGateMachine({ timeoutMs: 1000 });
  let calls = 0;
  const perform = () => {
    calls += 1;
    return new Promise(() => {});
  };
  submitDecisionFlow(gate, { perform });
  submitDecisionFlow(gate, { perform });
  assert.equal(calls, 1);
  gate.dispose();
});

// ---- AI 入口页零取数（同源纪律的可证形式）----

test("ai-assistant 三端入口页无任何取数调用（零平行取数路径）", () => {
  for (const p of ["src/pages/se/ai-assistant/index.tsx", "src/pages/sp/ai-assistant/index.tsx", "src/pages/cp/ai-assistant/index.tsx"]) {
    // 只审代码行：注释里说明纪律（"不调 seApi / 不另开 WS 面"）不算调用。
    const code = readFileSync(p, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const forbidden of ["seApi", "spApi", "cpApi", "/erp/", "http(", "wsSend", "makeSeApi", "makeSpApi", "makeCpApi"]) {
      assert.equal(code.includes(forbidden), false, `${p} 不应出现 ${forbidden}`);
    }
    assert.match(code, /pages\/chat\/index/, "只指向底座 chat 面");
  }
});

// ---- 501 页面不伪装（页面源码级断言）----

test("501 三端页面消费 notImplemented 而不是把 501 当加载失败", () => {
  for (const p of [
    "src/pages/se/lead-visit/index.tsx",
    "src/pages/sp/reconciliation/index.tsx",
    "src/pages/sp/invoice-upload/index.tsx",
    "src/pages/sp/payment-view/index.tsx",
    "src/pages/cp/reconciliation/index.tsx",
  ]) {
    const src = readFileSync(p, "utf8");
    assert.match(src, /notImplemented/, `${p} 须读 notImplemented`);
    assert.match(src, /CapabilityUnavailable/, `${p} 须渲染能力未提供区块`);
  }
});

test("身份未绑定页面不请求（页面源码级 fail-closed 断言）", () => {
  for (const p of [
    "src/pages/se/home/index.tsx",
    "src/pages/sp/home/index.tsx",
    "src/pages/cp/home/index.tsx",
    "src/pages/se/order-proxy/index.tsx",
    "src/pages/cp/pod-report/index.tsx",
  ]) {
    const src = readFileSync(p, "utf8");
    assert.match(src, /IdentityMissing/, `${p} 须有身份缺失区块`);
    assert.match(src, /identity\.value !== null|ready/, `${p} 须按身份就绪度闸住请求`);
  }
});
