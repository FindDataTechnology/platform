// UE pages' pure view-model helpers (openspec: add-erp-miniapp-pagesets P1).
//
// Everything a UE page renders that involves a DECISION lives here so
// node --test can drive it: status labels, amount formatting, cart totals,
// credit-rejection explanations (占用明细), honest 501 capability states,
// fulfillment views, and the two confirm-gate page flows (order-create /
// statement-confirm) as transport-agnostic perform functions.
//
// No React/Taro imports; no transport import — flows take the endpoint
// functions they need as parameters (the pages pass ueApi.*; tests pass
// mocks driving the REAL ConfirmGate machine).

// ---- 标签 ----

/** 订单状态机文案（服务器 status_note 同口径，可解释）。 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  cancelled: "已取消",
};

export function orderStatusText(status?: string): string {
  if (!status) return "状态未知";
  return ORDER_STATUS_LABEL[status] ?? status;
}

/** 对账单状态文案（resolution 源自内核 proposal 面状态）。 */
export const STATEMENT_STATUS_LABEL: Record<string, string> = {
  open: "待确认",
  confirming: "确认中（确认门待决）",
  confirmed: "已确认",
  disputed_pending: "异议处置中",
};

export function statementStatusText(status?: string): string {
  if (!status) return "状态未知";
  return STATEMENT_STATUS_LABEL[status] ?? status;
}

/** 501 如实文案：能力未提供，不得伪装成功能正常或加载失败。 */
export const CAPABILITY_UNAVAILABLE_TITLE = "该能力当前未提供";

export function capabilityUnavailableText(err: { notImplemented?: boolean; message?: string; code?: string }): {
  title: string;
  message: string;
} {
  if (err.notImplemented) {
    return {
      title: CAPABILITY_UNAVAILABLE_TITLE,
      // 服务器的人话 message 原样呈现（可解释纪律），附如实定性。
      message: `${err.message ?? ""}${err.message ? "。" : ""}后端能力未就绪，本页面如实展示该状态，不提供模拟功能。`,
    };
  }
  return { title: CAPABILITY_UNAVAILABLE_TITLE, message: err.message ?? "" };
}

// ---- 金额 / 汇总 ----

/** 金额展示：服务端字符串金额原样（不引入浮点误差），仅千分位。 */
export function fmtAmount(value?: string | number | null): string {
  if (value === undefined || value === null || value === "") return "—";
  const s = String(value);
  if (s === "0" || s === "0.000000") return "0";
  const neg = s.startsWith("-");
  const [int, frac] = (neg ? s.slice(1) : s).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fracTrimmed = frac?.replace(/0+$/, "");
  return `${neg ? "-" : ""}${grouped}${fracTrimmed ? `.${fracTrimmed}` : ""}`;
}

export interface CartLikeLine {
  product?: string;
  title?: string;
  qty?: number;
  unit?: string;
  quote?: { line_total?: string } | null;
}

/** 进货单行集汇总：件数与金额（行 quote.line_total 求和，decimal 字符串直加）。 */
export function cartTotals(lines: CartLikeLine[]): { count: number; amount: string } {
  // 两遍法：先定统一小数位（最大 frac 长度），再按同尺度整数累加，杜绝浮点误差。
  const raws = lines.map((l) => {
    const raw = l.quote?.line_total;
    return raw === undefined || raw === null ? "0" : String(raw);
  });
  let scale = 0;
  for (const s of raws) {
    const frac = s.split(".")[1];
    scale = Math.max(scale, frac ? frac.length : 0);
  }
  let total = 0;
  for (const s of raws) total += Math.round(Number(s) * 10 ** scale);
  const amount = scale === 0 ? String(total) : (total / 10 ** scale).toFixed(scale);
  return { count: lines.length, amount };
}

/** 下单请求体：行集最小形状 + 收货信息 + 备注（api-contract §2）。 */
export function orderPayload(
  lines: CartLikeLine[],
  shipping: { contact: string; phone: string; address: string },
  note: string,
): {
  lines: Array<{ productId: string; qty: number; unit?: string }>;
  shipping: Record<string, string>;
  note: string;
} {
  return {
    lines: lines
      .filter((l) => l.product !== undefined && l.qty !== undefined)
      .map((l) => ({ productId: l.product as string, qty: l.qty as number, ...(l.unit ? { unit: l.unit } : {}) })),
    shipping: { contact: shipping.contact, phone: shipping.phone, address: shipping.address },
    note,
  };
}

/** 下单页校验：行集非空 + 收货三要素；返回人话错误或 null。 */
export function orderFormError(
  lines: CartLikeLine[],
  shipping: { contact: string; phone: string; address: string },
): string | null {
  if (!lines.length) return "进货单为空，请先添加商品";
  if (!shipping.contact.trim()) return "请填写收货联系人";
  if (!shipping.phone.trim()) return "请填写联系电话";
  if (!shipping.address.trim()) return "请填写收货地址";
  return null;
}

/**
 * 信用不足拒绝的可解释文案：服务器 message 原样 + detail 占用明细
 * （limit/ar_balance/reserved/available/requested_amount/shortfall）。
 * 拒绝必须可解释（api-contract 0. 通用约定）。
 */
export function creditExplain(err: { code?: string; message?: string; detail?: Record<string, unknown> | null }): string {
  const d = err.detail ?? {};
  const pick = (key: string): string | null => {
    const v = d[key];
    return v === undefined || v === null ? null : String(v);
  };
  const currency = pick("currency") ?? "CNY";
  const parts: string[] = [];
  const limit = pick("limit");
  const available = pick("available");
  const requested = pick("requested_amount");
  const shortfall = pick("shortfall");
  const reserved = pick("reserved");
  const ar = pick("ar_balance");
  if (available !== null) parts.push(`可用额度 ${fmtAmount(available)} ${currency}`);
  if (requested !== null) parts.push(`本单金额 ${fmtAmount(requested)} ${currency}`);
  if (shortfall !== null) parts.push(`缺口 ${fmtAmount(shortfall)} ${currency}`);
  if (limit !== null) parts.push(`额度 ${fmtAmount(limit)}`);
  if (ar !== null) parts.push(`应收 ${fmtAmount(ar)}`);
  if (reserved !== null) parts.push(`已占用 ${fmtAmount(reserved)}`);
  const note = typeof d.note === "string" ? d.note : "";
  const detailText = parts.length ? `（${parts.join("，")}）` : note ? `（${note}）` : "";
  return `${err.message ?? "订单未受理"}${detailText}`;
}

// ---- 履约 / 轨迹 ----

export interface FulfillmentLike {
  plans?: Array<Record<string, unknown>>;
  handoff_pending?: boolean;
  note?: string;
}

/**
 * 履约视图摘要（order-detail 页的如实呈现）：
 * - 404（未确认订单无履约编排）→ null，页面显示诚实说明；
 * - handoff_pending → 已移交待编排（不伪造计划）；
 * - plans → 计划行数 + 服务器 note。
 */
export function fulfillmentView(view: FulfillmentLike | null): string {
  if (!view) return "该订单暂无履约编排（未确认订单不产生履约移交；确认后由交付编排面生成）";
  if (view.handoff_pending) return view.note ?? "订单已确认并移交履约；交付编排计划生成后展示明细";
  const n = view.plans?.length ?? 0;
  if (n === 0) return view.note ?? "交付编排暂无计划明细";
  return `履约计划 ${n} 条${view.note ? `：${view.note}` : ""}`;
}

// ---- 对账单确认门 ----

/** 确认/异议请求体（api-contract §4：decision + disputeNote）。 */
export function statementDecisionBody(decision: "confirmed" | "disputed", disputeNote: string): {
  decision: "confirmed" | "disputed";
  disputeNote?: string;
} {
  if (decision === "disputed") return { decision, disputeNote: disputeNote.trim() };
  return { decision };
}

/** 异议提交前校验：异议必须附说明（服务器同纪律，端上先挡一道）。 */
export function disputeFormError(note: string): string | null {
  if (!note.trim()) return "异议须附说明（将对账差异写清楚）";
  return null;
}

/**
 * 确认回执文案：proposal_status=pending 是如实回执 —— 确认已进确认门待内核
 * 拍板，不假报「已确认落账」。
 */
export function statementReceiptText(result: {
  proposal_status?: string;
  disputed?: boolean;
  duplicate?: boolean;
  note?: string;
}): string {
  if (result.disputed) return result.note ?? "异议已进入内部处置车道";
  if (result.proposal_status === "pending") return result.note ?? "确认已提交确认门（待内核拍板），对账单暂不记已确认";
  if (result.proposal_status === "confirmed") return result.note ?? "该对账单确认已过确认门";
  return result.note ?? "已受理";
}

// ---- 确认门页 flow（ConfirmGate 集成路径；单测注入 mock 端点直驱真机器）----

/** Structural slice of ConfirmGateApi the flows need (no React import). */
export interface GateLike {
  start(perform: (settle: { confirm(): void; reject(message: string): void }) => void): void;
}

/**
 * 下单 flow（ue-order-create）：gate.start 内 POST /orders ——
 * 受理确认 → settle.confirm；ErpApiError → 信用不足给占用明细、其余原样拒绝；
 * 网络异常 → 人话拒绝。perform 内不 settle 的路径（请求已发出）由机器 pending +
 * 8s 超时兜底。
 */
export function submitOrderFlow(
  gate: GateLike,
  deps: {
    createOrder: (body: ReturnType<typeof orderPayload>) => Promise<unknown>;
    body: ReturnType<typeof orderPayload>;
    onConfirmed?: (result: unknown) => void;
  },
): void {
  gate.start(async (settle) => {
    try {
      const result = await deps.createOrder(deps.body);
      settle.confirm();
      deps.onConfirmed?.(result);
    } catch (e) {
      const err = e as { code?: string; message?: string; detail?: Record<string, unknown> | null };
      settle.reject(err.code === "CREDIT_EXCEEDED" ? creditExplain(err) : err.message ?? "下单失败，请重试");
    }
  });
}

/**
 * 对账确认/异议 flow（ue-statement-confirm）：同上；回执经 onConfirmed 交给
 * 页面渲染（pending 不假报已确认）。
 */
export function submitStatementFlow(
  gate: GateLike,
  deps: {
    confirmStatement: (body: ReturnType<typeof statementDecisionBody>) => Promise<unknown>;
    body: ReturnType<typeof statementDecisionBody>;
    onConfirmed?: (result: unknown) => void;
  },
): void {
  gate.start(async (settle) => {
    try {
      const result = await deps.confirmStatement(deps.body);
      settle.confirm();
      deps.onConfirmed?.(result);
    } catch (e) {
      const err = e as { message?: string };
      settle.reject(err.message ?? "提交失败，请重试");
    }
  });
}
