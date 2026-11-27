// SE / SP / CP data plane (openspec: add-erp-miniapp-pagesets P2/P3).
//
// Same one data path as the UE plane in erp-api.ts: the base runtime's http
// transport, the /erp/supply-chain/v1 contract space, the unified ERP shell.
// The only structural difference is identity: these three surfaces address an
// external party (业务员 / 供应商 / 承运商), so every call carries the surface
// header resolved by identity.ts. When that identity is missing NOTHING is
// sent — `makeSeApi(transport, headers)` takes a headers provider and the wire
// modules pass a fail-closed one.
//
// Backend truth (fd-erp-vertical-api/faces.py): SE 10/15, SP 7/13, CP 8/12 are
// implemented; the rest answer 501 NOT_IMPLEMENTED with a planned_lane. Those
// methods exist here (the contract is real) and pages surface them honestly as
// 该能力当前未提供 — never a fake form, never a disguised success.

import { type ErpTransport, type ListEnvelope, envelopeData, erpBody } from "./erp-api.ts";
import { type HeadersProvider } from "./identity.ts";

// ---- 共用 ----

type Hdr = { headers?: Record<string, string> };
type Envelope<T> = ListEnvelope<T> & Record<string, unknown>;

function callers(transport: ErpTransport, headers: HeadersProvider) {
  const h = (): Hdr => {
    const extra = headers();
    return Object.keys(extra).length ? { headers: extra } : {};
  };
  return {
    /** 对象端点：取壳内 data。 */
    obj: <T>(path: string, init?: { method?: string; body?: unknown }) =>
      erpBody(transport, path, { ...init, ...h() }).then((body) => envelopeData<T>(body)),
    /** 列表端点：整壳回传（data + total/offset/limit/truncated 在 body 平级）。 */
    list: <T>(path: string, init?: { method?: string; body?: unknown }) =>
      erpBody(transport, path, { ...init, ...h() }) as unknown as Promise<Envelope<T>>,
  };
}

function q(params: Record<string, string | number | undefined>): string {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return pairs.length ? `?${pairs.join("&")}` : "";
}

const seg = (s: string) => encodeURIComponent(s);

// ---- 共用形状 ----

/** 订单行（编排层 proposal 行；UE/SE 同形）。 */
export interface OrderLine {
  product?: string;
  product_code?: string;
  qty?: string | number;
  unit?: string;
  line_total?: string;
  [k: string]: unknown;
}

/** 订单/采购单/运单统一状态行外壳。 */
export interface StatusRow {
  status?: string;
  event?: string;
  status_note?: string;
}

/** 504 诚实缺省注记汇总（多处端点自带 notes 字段）。 */
export type Notes = Record<string, string>;

// ==========================================================================
// SE 销售助手（supply-chain.se，契约 se-sales/api-contract.md）
// ==========================================================================

export interface SeWorkspaceData {
  staff?: string;
  owned_customer_count?: number;
  pending_orders?: number;
  open_statements?: number;
  pending_alerts?: number;
  today_visit_plan?: number;
  notes?: Notes;
}

export interface SeCustomerRow {
  customerId?: string;
  code?: string;
  name?: string;
  state?: string;
  sales_rep?: string;
  credit_occupied?: string | null;
  credit_available?: string | null;
  ar_balance?: string | null;
  open_statement_count?: number;
  credit_source?: string;
}

export interface SeOrderRow extends StatusRow {
  orderId?: string;
  phase?: string;
  day?: string;
  amount_total?: string;
  currency?: string;
  customer_id?: string;
  requested_by?: string | null;
}

export interface CreditPosition {
  limit?: string | null;
  ar_balance?: string | null;
  reserved?: string | null;
  available?: string | null;
  source_note?: string;
}

export interface SeCustomer360 {
  customerId?: string;
  profile?: Record<string, unknown>;
  state?: string;
  credit?: CreditPosition;
  recent_orders?: SeOrderRow[];
  order_count?: number;
  statements?: { count?: number; open_count?: number; latest_period?: string | null };
}

export interface ProxyOrderResult {
  accepted?: boolean;
  order_ref?: string;
  status?: string;
  amount_total?: string;
  currency?: string;
  credit_reservation?: { stable_id?: string; amount?: string } | null;
  priced_lines?: Array<Record<string, unknown>>;
  proxy?: { staff?: string; customer_id?: string; requested_by?: string; note?: string };
  note?: string;
}

export interface SeAlertRow {
  alertId?: string;
  status?: string;
  metric?: string;
  value?: string;
  threshold?: string;
  severity?: string;
  title?: string;
  assignee?: string;
  task_template?: string;
  note?: string;
}

export interface AlertHandleResult {
  request_id?: string;
  status?: string;
  handled_by?: string;
  note?: string;
  [k: string]: unknown;
}

export interface SeStatementRow {
  statement_id?: string;
  period?: string;
  amount_total?: string;
  currency?: string;
  status?: string;
  order_count?: number;
  customer_id?: string;
  [k: string]: unknown;
}

export interface SeInvoiceRow {
  requestId?: string;
  status?: string;
  customerId?: string;
  title?: string;
  taxId?: string;
  orderId?: string;
  statementId?: string;
  delivery?: string;
  submitted_at?: string;
  decided_at?: string;
}

export interface SeInvoiceDecideResult {
  requestId?: string;
  status?: string;
  customerId?: string;
  decided_at?: string;
  note?: string | null;
}

export interface SeApi {
  workspace(): Promise<SeWorkspaceData>;
  customers(params: { keyword?: string; offset?: number; limit?: number }): Promise<Envelope<SeCustomerRow>>;
  customer360(customerId: string): Promise<SeCustomer360>;
  customerOrders(customerId: string, params: { offset?: number; limit?: number }): Promise<Envelope<SeOrderRow>>;
  createLead(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  leads(params: { status?: string; offset?: number; limit?: number }): Promise<Envelope<Record<string, unknown>>>;
  createVisit(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  visits(params: { offset?: number; limit?: number }): Promise<Envelope<Record<string, unknown>>>;
  proxyOrder(body: {
    customerId: string;
    lines: Array<{ productId: string; qty: number; unit?: string }>;
    shipping?: Record<string, string>;
    note?: string;
  }): Promise<ProxyOrderResult>;
  orders(params: { customerId?: string; status?: string; from?: string; to?: string; offset?: number; limit?: number }): Promise<Envelope<SeOrderRow>>;
  orderDetail(orderId: string): Promise<SeOrderRow & { lines?: OrderLine[]; credit_reservation?: { stable_id?: string; amount?: string } | null; request_id?: string }>;
  alerts(params: { status?: string; severity?: string; offset?: number; limit?: number }): Promise<Envelope<SeAlertRow>>;
  handleAlert(alertId: string, body: { decision: "accept" | "reject"; note?: string }): Promise<AlertHandleResult>;
  statements(params: { status?: string; offset?: number; limit?: number }): Promise<Envelope<SeStatementRow>>;
  pushStatement(statementId: string, body: { channel?: string }): Promise<Record<string, unknown>>;
  invoiceAuditList(params: { status?: string; from?: string; to?: string; offset?: number; limit?: number }): Promise<Envelope<SeInvoiceRow>>;
  invoiceDecide(requestId: string, body: { decision: "accepted" | "rejected"; note?: string }): Promise<SeInvoiceDecideResult>;
}

export function makeSeApi(transport: ErpTransport, headers: HeadersProvider): SeApi {
  const { obj, list } = callers(transport, headers);
  return {
    workspace: () => obj<SeWorkspaceData>("/se/workspace"),
    customers: (p) => list<SeCustomerRow>(`/se/customers${q(p)}`),
    customer360: (id) => obj<SeCustomer360>(`/se/customers/${seg(id)}`),
    customerOrders: (id, p) => list<SeOrderRow>(`/se/customers/${seg(id)}/orders${q(p)}`),
    createLead: (body) => obj("/se/leads", { method: "POST", body }),
    leads: (p) => list<Record<string, unknown>>(`/se/leads${q(p)}`),
    createVisit: (body) => obj("/se/visits", { method: "POST", body }),
    visits: (p) => list<Record<string, unknown>>(`/se/visits${q(p)}`),
    proxyOrder: (body) => obj<ProxyOrderResult>("/se/orders/proxy", { method: "POST", body }),
    orders: (p) => list<SeOrderRow>(`/se/orders${q(p)}`),
    orderDetail: (id) => obj(`/se/orders/${seg(id)}`),
    alerts: (p) => list<SeAlertRow>(`/se/alerts${q(p)}`),
    handleAlert: (id, body) => obj<AlertHandleResult>(`/se/alerts/${seg(id)}/handle`, { method: "POST", body }),
    statements: (p) => list<SeStatementRow>(`/se/statements${q(p)}`),
    pushStatement: (id, body) => obj(`/se/statements/${seg(id)}/push`, { method: "POST", body }),
    invoiceAuditList: (p) => list<SeInvoiceRow>(`/se/invoice-requests${q(p)}`),
    invoiceDecide: (id, body) =>
      obj<SeInvoiceDecideResult>(`/se/invoice-requests/${seg(id)}/decide`, { method: "POST", body }),
  };
}

// ==========================================================================
// SP 供应商协同（supply-chain.sp，契约 sp-supplier/api-contract.md）
// ==========================================================================

export interface SpWorkspaceData {
  supplier_id?: string;
  supplier_code?: string;
  po_count?: number;
  po_pending_accept?: number;
  po_pending_ship?: number;
  arrival_notices_open?: number;
  statements_pending?: number;
  invoices_pending_verify?: number;
  notes?: Notes;
}

export interface SpPurchaseOrderRow extends StatusRow {
  poId?: string;
  supplier_id?: string;
  aggregate_ref?: string;
  lines?: OrderLine[];
  push_channel?: string | null;
  supplier_response?: Record<string, unknown> | null;
}

export interface SpPurchaseOrderDetail extends SpPurchaseOrderRow {
  delivery_feedbacks?: Array<{ ref?: string; event?: string; status?: string; payload?: Record<string, unknown> }>;
  arrival_notices?: Array<{ ref?: string; status?: string; payload?: Record<string, unknown> }>;
  inbound_tasks?: Array<{ ref?: string; status?: string; payload?: Record<string, unknown> }>;
  field_note?: string;
}

export interface SpDecisionResult {
  po_ref?: string;
  decision?: string;
  po_status?: string;
  po_status_before?: string;
  note?: string;
  [k: string]: unknown;
}

export interface SpArrivalRow {
  ref?: string;
  status?: string;
  event?: string;
  po_ref?: string;
  expected_day?: string;
  lines?: OrderLine[];
  [k: string]: unknown;
}

export interface SpApi {
  workspace(): Promise<SpWorkspaceData>;
  purchaseOrders(params: { status?: string; period?: string; offset?: number; limit?: number }): Promise<Envelope<SpPurchaseOrderRow>>;
  purchaseOrder(poId: string): Promise<SpPurchaseOrderDetail>;
  acceptPurchaseOrder(poId: string, body: { decision: "accepted" | "rejected"; rejectedNote?: string }): Promise<SpDecisionResult>;
  deliveryFeedback(poId: string, body: {
    lines: OrderLine[];
    carrier?: string;
    waybillNo?: string;
    documents?: string[];
    expectedDay?: string;
  }): Promise<Record<string, unknown>>;
  arrivalNotices(params: { status?: string; offset?: number; limit?: number }): Promise<Envelope<SpArrivalRow>>;
  createArrivalNotice(body: { poRef: string; lines: OrderLine[]; expectedDay?: string }): Promise<Record<string, unknown>>;
  statements(params: { period?: string; status?: string }): Promise<Envelope<Record<string, unknown>>>;
  statementDetail(statementId: string): Promise<Record<string, unknown>>;
  confirmStatement(statementId: string, body: { decision: "confirmed" | "disputed"; disputeNote?: string }): Promise<Record<string, unknown>>;
  invoices(): Promise<Envelope<Record<string, unknown>>>;
  uploadInvoice(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  settlements(params: { period?: string; status?: string }): Promise<Envelope<Record<string, unknown>>>;
}

export function makeSpApi(transport: ErpTransport, headers: HeadersProvider): SpApi {
  const { obj, list } = callers(transport, headers);
  return {
    workspace: () => obj<SpWorkspaceData>("/sp/workspace"),
    purchaseOrders: (p) => list<SpPurchaseOrderRow>(`/sp/purchase-orders${q(p)}`),
    purchaseOrder: (id) => obj<SpPurchaseOrderDetail>(`/sp/purchase-orders/${seg(id)}`),
    acceptPurchaseOrder: (id, body) => obj<SpDecisionResult>(`/sp/purchase-orders/${seg(id)}/accept`, { method: "POST", body }),
    deliveryFeedback: (id, body) => obj(`/sp/purchase-orders/${seg(id)}/delivery-feedback`, { method: "POST", body }),
    arrivalNotices: (p) => list<SpArrivalRow>(`/sp/arrival-notices${q(p)}`),
    createArrivalNotice: (body) => obj("/sp/arrival-notices", { method: "POST", body }),
    statements: (p) => list<Record<string, unknown>>(`/sp/statements${q(p)}`),
    statementDetail: (id) => obj(`/sp/statements/${seg(id)}`),
    confirmStatement: (id, body) => obj(`/sp/statements/${seg(id)}/confirm`, { method: "POST", body }),
    invoices: () => list<Record<string, unknown>>("/sp/invoices"),
    uploadInvoice: (body) => obj("/sp/invoices", { method: "POST", body }),
    settlements: (p) => list<Record<string, unknown>>(`/sp/settlements${q(p)}`),
  };
}

// ==========================================================================
// CP 承运协同（supply-chain.cp，契约 cp-carrier/api-contract.md）
// ==========================================================================

export interface CpWorkspaceData {
  carrier?: string;
  waybills_total?: number;
  waybills_open?: number;
  waybills_pending_accept?: number;
  dock_reservations_active?: number;
  pod_exceptions?: number;
  notes?: Notes;
}

export interface CpWaybillRow extends StatusRow {
  waybillId?: string;
  waybill_no?: string;
  carrier?: string;
  plan_ref?: string;
  order_ref?: string;
  carrier_response?: Record<string, unknown> | null;
}

export interface CpTrackEvent {
  at?: string;
  status?: string;
  note?: string;
  [k: string]: unknown;
}

export interface CpWaybillDetail extends CpWaybillRow {
  customer_id?: string;
  lines?: OrderLine[];
  track_events?: CpTrackEvent[] | null;
  logistics_adapter?: Record<string, unknown> | string;
  note?: string;
}

export interface CpEventRow {
  record?: string;
  ref?: string;
  event?: string;
  status?: string;
  payload?: Record<string, unknown>;
  requested_by?: string | null;
  note?: string | null;
}

export interface CpEventsData {
  waybillId?: string;
  waybill_no?: string;
  status?: string;
  events?: CpEventRow[];
  track_events?: CpTrackEvent[] | null;
  caliber_note?: string;
}

export interface CpDecisionResult {
  waybill_ref?: string;
  decision?: string;
  status?: string;
  note?: string;
  [k: string]: unknown;
}

export interface CpPodResult {
  waybill_ref?: string;
  waybill_no?: string;
  exception?: boolean;
  documents?: string[];
  disposal_request_id?: string | null;
  disposal_status?: string | null;
  settlement_note?: string;
  [k: string]: unknown;
}

export interface CpApi {
  workspace(): Promise<CpWorkspaceData>;
  waybills(params: { status?: string; offset?: number; limit?: number }): Promise<Envelope<CpWaybillRow>>;
  waybill(waybillId: string): Promise<CpWaybillDetail>;
  acceptWaybill(waybillId: string, body: { decision: "accepted" | "rejected"; rejectedNote?: string }): Promise<CpDecisionResult>;
  dockSlots(params: { warehouseId?: string; day?: string }): Promise<Envelope<Record<string, unknown>>>;
  reserveDock(waybillId: string, body: {
    action?: "reserve" | "cancel";
    slotId?: string;
    warehouse?: string;
    slotDay?: string;
    reservationId?: string;
  }): Promise<Record<string, unknown>>;
  pickupCheckin(waybillId: string, body: {
    location?: Record<string, unknown>;
    imageRefs?: string[];
    scanCode?: string;
  }): Promise<Record<string, unknown>>;
  reportPod(waybillId: string, body: { documents?: string[]; exceptionNote?: string }): Promise<CpPodResult>;
  waybillEvents(waybillId: string): Promise<CpEventsData>;
  freightStatements(params: { period?: string; status?: string }): Promise<Envelope<Record<string, unknown>>>;
  freightDetail(statementId: string): Promise<Record<string, unknown>>;
  confirmFreight(statementId: string, body: { decision: "confirmed" | "disputed"; disputeNote?: string }): Promise<Record<string, unknown>>;
}

export function makeCpApi(transport: ErpTransport, headers: HeadersProvider): CpApi {
  const { obj, list } = callers(transport, headers);
  return {
    workspace: () => obj<CpWorkspaceData>("/cp/workspace"),
    waybills: (p) => list<CpWaybillRow>(`/cp/waybills${q(p)}`),
    waybill: (id) => obj<CpWaybillDetail>(`/cp/waybills/${seg(id)}`),
    acceptWaybill: (id, body) => obj<CpDecisionResult>(`/cp/waybills/${seg(id)}/accept`, { method: "POST", body }),
    dockSlots: (p) => list<Record<string, unknown>>(`/cp/dock-slots${q(p)}`),
    reserveDock: (id, body) => obj(`/cp/waybills/${seg(id)}/dock-reservation`, { method: "POST", body }),
    pickupCheckin: (id, body) => obj(`/cp/waybills/${seg(id)}/pickup-checkin`, { method: "POST", body }),
    reportPod: (id, body) => obj<CpPodResult>(`/cp/waybills/${seg(id)}/pod`, { method: "POST", body }),
    waybillEvents: (id) => obj<CpEventsData>(`/cp/waybills/${seg(id)}/events`),
    freightStatements: (p) => list<Record<string, unknown>>(`/cp/freight-statements${q(p)}`),
    freightDetail: (id) => obj(`/cp/freight-statements/${seg(id)}`),
    confirmFreight: (id, body) => obj(`/cp/freight-statements/${seg(id)}/confirm`, { method: "POST", body }),
  };
}
