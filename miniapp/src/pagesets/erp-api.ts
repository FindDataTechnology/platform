// ERP vertical REST data plane for pageset pages (openspec:
// add-erp-miniapp-pagesets P1 — UE 订货台 12 页).
//
// ONE data path, zero bypass: every call rides the base runtime's http
// transport (src/lib/taro-http.ts installHttp() configures @platform/core
// http at boot — same auth-header/401-retry pipeline as chat/cron), against
// the contract space /erp/supply-chain/v1 (ue-commerce api-contract.md).
//
// The response envelope is the ERP unified shell:
//   ok:  { ok: true, data: ..., rows_returned }
//   err: { ok: false, error: { code, message, hint, detail }, rows_returned }
// A non-2xx status carries the same shell; NOT_IMPLEMENTED (501) means the
// capability genuinely does not exist backend-side — pages must surface it
// honestly (该能力当前未提供), never disguise it.
//
// node --test discipline: makeUeApi(transport) takes the transport as a
// parameter; the DEFAULT wiring for pages lives in ue-api-wire.ts (3 lines,
// imports @platform/core — which node cannot resolve, so the pure modules
// here never import it). Pure helpers here never import React/Taro either.

export const ERP_API_BASE = "/erp/supply-chain/v1";

/** Error shape of the unified shell (machine code + 人话 message). */
export interface ErpErrorBody {
  code: string;
  message: string;
  hint?: string;
  detail?: Record<string, unknown> | null;
}

/** The one error type pages handle. notImplemented = 如实 501 能力未提供. */
export class ErpApiError extends Error {
  code: string;
  hint: string | null;
  detail: Record<string, unknown> | null;
  status: number;

  constructor(body: Partial<ErpErrorBody>, status: number) {
    super(body.message || `请求失败（${body.code || "UNKNOWN"}）`);
    this.name = "ErpApiError";
    this.code = body.code || "UNKNOWN";
    this.hint = body.hint ?? null;
    this.detail = body.detail ?? null;
    this.status = status;
  }

  /** 后端如实 501：契约已定义、能力未就绪 — 页面必须如实显示，不得伪装。 */
  get notImplemented(): boolean {
    return this.status === 501 || this.code === "NOT_IMPLEMENTED";
  }
}

/**
 * Strict envelope parse. Anything malformed (non-object, missing ok, error
 * without a message) yields an ErpApiError — never a guessed success.
 * Returns the WHOLE body on ok (list endpoints carry total/offset/limit/
 * truncated at the body level beside data — callers pick .data or keep the
 * page metadata).
 */
export function parseErpEnvelope(payload: unknown, status: number): unknown {
  if (payload === null || typeof payload !== "object") {
    throw new ErpApiError({ code: "BAD_ENVELOPE", message: "响应形态非法" }, status);
  }
  const body = payload as { ok?: unknown; data?: unknown; error?: unknown };
  if (body.ok === true) return body;
  const err = (body.error ?? {}) as Partial<ErpErrorBody>;
  if (typeof err.message !== "string" || !err.message) {
    throw new ErpApiError({ code: "BAD_ENVELOPE", message: `响应错误形态非法（HTTP ${status}）` }, status);
  }
  throw new ErpApiError(err, status);
}

/** The data field of an ok body (object endpoints). */
export function envelopeData<T>(body: unknown): T {
  return (body as { data?: T }).data as T;
}

/** Minimal transport slice erpRequestVia needs (the wired http() satisfies it). */
export type ErpTransport = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<HttpResponseLike>;

/** Structural slice of the core HttpResponse (imported type-only upstream). */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

/** URL-encode query params (skip empty); pure and testable. */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length ? `?${pairs.join("&")}` : "";
}

export async function erpRequestVia<T>(
  transport: ErpTransport,
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
  const method = init?.method ?? "GET";
  const res = await transport(ERP_API_BASE + path, {
    method,
    ...(init?.headers ? { headers: init.headers } : {}),
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new ErpApiError({ code: "BAD_ENVELOPE", message: `响应非 JSON（HTTP ${res.status}）` }, res.status);
  }
  return parseErpEnvelope(payload, res.status) as T;
}

/** The full ok body (list endpoints: data + total/offset/limit/truncated). */
export async function erpBody(
  transport: ErpTransport,
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<Record<string, unknown>> {
  return erpRequestVia<Record<string, unknown>>(transport, path, init);
}

// ---- UE 契约形状（api-contract.md 逐域；只声明页面消费的字段）----

export interface ProductUnit {
  unit?: string;
  kind?: string;
  rate?: string | number;
}

export interface ProductCard {
  productId?: string;
  title?: string;
  category?: string;
  units?: ProductUnit[];
  images?: string[];
  list_price?: string | number;
}

export interface PriceQuote {
  product?: string;
  qty?: string;
  unit?: string;
  base_price?: string;
  unit_price?: string;
  line_total?: string;
  rule_chain?: Array<Record<string, unknown>>;
  caliber_note?: string;
}

export interface StockVisibility {
  visible?: boolean;
  qty_available?: string;
  note?: string;
}

export interface ProductDetail extends ProductCard {
  state?: string;
  price?: PriceQuote | null;
  stock?: StockVisibility | null;
}

export interface CartLine {
  line_id?: string;
  product?: string;
  title?: string;
  qty?: number;
  unit?: string;
  quote?: PriceQuote | null;
}

export interface CartView {
  lines?: CartLine[];
  line_count?: number;
}

export interface CreditPreview {
  available?: string;
  requested?: string;
  sufficient?: boolean;
  note?: string;
}

export interface PricePreview {
  lines?: PriceQuote[];
  amount_total?: string;
  currency?: string;
  credit_preview?: CreditPreview | null;
}

export interface OrderAcceptance {
  accepted?: boolean;
  order_ref?: string;
  status?: string;
  amount_total?: string;
  currency?: string;
  credit_reservation?: { stable_id?: string; amount?: string } | null;
  priced_lines?: PriceQuote[];
}

export interface OrderSummary {
  orderId?: string;
  status?: string;
  phase?: string;
  day?: string;
  amount_total?: string;
  currency?: string;
}

export interface OrderDetailData extends OrderSummary {
  status_note?: string;
  lines?: PriceQuote[];
  credit_reservation?: { stable_id?: string; amount?: string } | null;
}

export interface FulfillmentView {
  order_ref?: string;
  plans?: Array<Record<string, unknown>>;
  handoff_ref?: string;
  handoff_pending?: boolean;
  note?: string;
}

export interface Statement {
  statement_id?: string;
  period?: string;
  amount_total?: string;
  currency?: string;
  status?: string;
  order_count?: number;
  orders?: Array<Record<string, unknown>>;
  source_note?: string;
}

export interface StatementDecisionResult {
  statement_id?: string;
  proposal_status?: string;
  proposal_id?: string;
  disputed?: boolean;
  duplicate?: boolean;
  note?: string;
}

export interface ListEnvelope<T> {
  data: T[];
  total: number;
  offset: number;
  limit: number;
  truncated: boolean;
}

// ---- UE 端点集合（api-contract §1-§6；经注入传输可单测）----

export interface UeApi {
  products(params: { keyword?: string; categoryId?: string; offset?: number; limit?: number; sort?: string }): Promise<ListEnvelope<ProductCard>>;
  productCategories(): Promise<ListEnvelope<{ categoryId?: string; product_count?: number; stop_selling_count?: number }>>;
  productDetail(productId: string): Promise<ProductDetail>;
  cart(): Promise<CartView>;
  addCartLine(body: { productId: string; qty: number; unit?: string }): Promise<CartLine>;
  removeCartLine(lineId: string): Promise<CartView>;
  pricePreview(body: { lines: Array<{ productId: string; qty: number; unit?: string }> }): Promise<PricePreview>;
  createOrder(body: { lines: Array<{ productId: string; qty: number; unit?: string; note?: string }>; shipping?: Record<string, string>; note?: string }): Promise<OrderAcceptance>;
  orders(params: { status?: string; offset?: number; limit?: number }): Promise<ListEnvelope<OrderSummary>>;
  orderDetail(orderId: string): Promise<OrderDetailData>;
  orderFulfillment(orderId: string): Promise<FulfillmentView>;
  statements(params: { status?: string; period?: string }): Promise<ListEnvelope<Statement>>;
  statementDetail(statementId: string): Promise<Statement>;
  confirmStatement(statementId: string, body: { decision: "confirmed" | "disputed"; disputeNote?: string }): Promise<StatementDecisionResult>;
  invoiceRequests(): Promise<ListEnvelope<Record<string, unknown>>>;
  createInvoiceRequest(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  aftersaleRequests(): Promise<ListEnvelope<Record<string, unknown>>>;
  createAftersaleRequest(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  aftersaleDetail(requestId: string): Promise<Record<string, unknown>>;
}

export function makeUeApi(transport: ErpTransport): UeApi {
  // 对象端点：取壳内 data；列表端点：整壳回传（data + total/offset/limit/
  // truncated 在 body 平级，驱动分页「加载更多」）。
  const obj = <T>(path: string, init?: { method?: string; body?: unknown }) =>
    erpBody(transport, path, init).then((body) => envelopeData<T>(body));
  const listFor = <T>(path: string, init?: { method?: string; body?: unknown }) =>
    erpBody(transport, path, init) as unknown as Promise<ListEnvelope<T>>;
  const one = <T>(path: string, init?: { method?: string; body?: unknown }) =>
    erpBody(transport, path, init) as unknown as Promise<T>;
  return {
    products: (p) => listFor<ProductCard>(`/ue/products${buildQuery(p)}`),
    productCategories: () => listFor<{ categoryId?: string; product_count?: number; stop_selling_count?: number }>("/ue/product-categories"),
    productDetail: (id) => obj<ProductDetail>(`/ue/products/${encodeURIComponent(id)}`),
    cart: () => obj<CartView>("/ue/cart"),
    addCartLine: (body) => obj<CartLine>("/ue/cart/lines", { method: "POST", body }),
    removeCartLine: (lineId) => obj<CartView>(`/ue/cart/lines/${encodeURIComponent(lineId)}`, { method: "DELETE" }),
    pricePreview: (body) => obj<PricePreview>("/ue/cart/price-preview", { method: "POST", body }),
    createOrder: (body) => obj<OrderAcceptance>("/ue/orders", { method: "POST", body }),
    orders: (p) => listFor<OrderSummary>(`/ue/orders${buildQuery(p)}`),
    orderDetail: (id) => obj<OrderDetailData>(`/ue/orders/${encodeURIComponent(id)}`),
    orderFulfillment: (id) => obj<FulfillmentView>(`/ue/orders/${encodeURIComponent(id)}/fulfillment`),
    statements: (p) => listFor<Statement>(`/ue/statements${buildQuery(p)}`),
    statementDetail: (id) => obj<Statement>(`/ue/statements/${encodeURIComponent(id)}`),
    confirmStatement: (id, body) => obj<StatementDecisionResult>(`/ue/statements/${encodeURIComponent(id)}/confirm`, { method: "POST", body }),
    // §5/§6：端点契约已定义；后端实态为如实 501（NOT_IMPLEMENTED）。页面
    // 消费这些方法并把 501 如实呈现为「该能力当前未提供」——不伪装。
    invoiceRequests: () => listFor<Record<string, unknown>>("/ue/invoice-requests"),
    createInvoiceRequest: (body) => one("/ue/invoice-requests", { method: "POST", body }),
    aftersaleRequests: () => listFor<Record<string, unknown>>("/ue/aftersale-requests"),
    createAftersaleRequest: (body) => one("/ue/aftersale-requests", { method: "POST", body }),
    aftersaleDetail: (id) => one(`/ue/aftersale-requests/${encodeURIComponent(id)}`),
  };
}
