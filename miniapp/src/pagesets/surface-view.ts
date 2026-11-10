// SE / SP / CP pure view-model helpers (openspec: add-erp-miniapp-pagesets P2/P3).
//
// Same discipline as ue-view.ts: every decision a P2/P3 page renders lives
// here so node --test drives it — status vocabularies (PO / waybill / alert /
// statement), form validators, receipt texts that never claim more than the
// server said, honest 501 wording, and the confirm-gate flows as
// transport-agnostic perform functions.
//
// No React/Taro imports; flows take the endpoint call they need as a
// parameter (pages pass the surface api; tests pass mocks driving the REAL
// ConfirmGate machine).

import { type ErpApiError } from "./erp-api.ts";
import { type GateLike } from "./ue-view.ts";
import type { OrderLine } from "./surface-api.ts";

// ---- 状态词汇（服务器 status_note 同口径）----

/** 采购单状态（SP 接单线；编排层 push→accept 同一状态机）。 */
export const PO_STATUS_LABEL: Record<string, string> = {
  proposed: "待确认（租户侧确认车道）",
  confirmed: "已确认",
  pushed: "已推送·待接单",
  accepted: "已接单",
  rejected: "已拒单",
  cancelled: "已取消",
};

export function poStatusText(status?: string): string {
  if (!status) return "状态未知";
  return PO_STATUS_LABEL[status] ?? status;
}

/** 运单状态（CP 承运线）。 */
export const WAYBILL_STATUS_LABEL: Record<string, string> = {
  open: "在途流转",
  accepted: "已接单",
  rejected: "已拒单（终态）",
  closed: "已结单",
};

export function waybillStatusText(status?: string): string {
  if (!status) return "状态未知";
  return WAYBILL_STATUS_LABEL[status] ?? status;
}

/** 处置任务状态（SE 预警拍板席位）。 */
export const DISPOSAL_STATUS_LABEL: Record<string, string> = {
  pending: "待处置",
  confirmed: "已处置",
  handled: "已处置",
  rejected: "已驳回",
};

export function disposalStatusText(status?: string): string {
  if (!status) return "状态未知";
  return DISPOSAL_STATUS_LABEL[status] ?? status;
}

/** 预警级别文案。 */
export const SEVERITY_LABEL: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
  critical: "紧急",
};

export function severityText(severity?: string): string {
  if (!severity) return "级别未知";
  return SEVERITY_LABEL[severity] ?? severity;
}

/** 到货预告状态。 */
export const ARRIVAL_STATUS_LABEL: Record<string, string> = {
  open: "待到货",
  received: "已到货",
  late: "迟到",
};

export function arrivalStatusText(status?: string): string {
  if (!status) return "状态未知";
  return ARRIVAL_STATUS_LABEL[status] ?? status;
}

// ---- 错误转人话（fail-closed 闸的每一种拒绝都要可解释）----

/** 501 如实标题（与 UE 面同一句：能力未提供就得这么说）。 */
export const CAPABILITY_UNAVAILABLE_TITLE = "该能力当前未提供";

/**
 * Surface error -> 人话。顺序要紧：
 * 1. 501（notImplemented）→ 「该能力当前未提供」+ 服务器 message；
 * 2. 闸类错误码逐条给可解释文案（身份/页面集/权限码/数据域/不存在）；
 * 3. 其余原样。
 */
export function surfaceErrorText(err: {
  code?: string;
  message?: string;
  hint?: string | null;
  detail?: Record<string, unknown> | null;
  notImplemented?: boolean;
}): string {
  if (err.notImplemented) {
    return `${CAPABILITY_UNAVAILABLE_TITLE}：${err.message ?? ""}${err.message ? "。" : ""}本页如实展示该状态，不提供模拟功能。`;
  }
  const hint = err.hint ? `（${err.hint}）` : "";
  switch (err.code) {
    case "AUTH_REQUIRED":
      return `${err.message ?? "缺少身份"}`;
    case "PAGESET_FORBIDDEN":
      return `${err.message ?? "当前租户未开通该页面集"}，请联系管理员开通。`;
    case "GRANT_REQUIRED":
      return `${err.message ?? "缺少所需权限码"}，请联系管理员为当前账号加授。`;
    case "DATA_SCOPE_DENIED":
      return `${err.message ?? "不在你的数据域内"}（数据域按归属校验，代理不改变范围）。`;
    case "NOT_FOUND":
      return `${err.message ?? "对象不存在"}，或不在你的数据域内（越域一律按不存在处理，不泄露存在性）。`;
    case "CREDIT_EXCEEDED":
      return creditText(err.detail ?? {}, err.message);
    default:
      return `${err.message ?? "请求失败"}${hint}`;
  }
}

/** 信用不足占用明细（与 UE 面同一套字段：limit/available/requested/shortfall）。 */
export function creditText(detail: Record<string, unknown>, message?: string): string {
  const pick = (k: string) => (detail[k] === undefined || detail[k] === null ? null : String(detail[k]));
  const parts: string[] = [];
  const available = pick("available");
  const requested = pick("requested_amount");
  const shortfall = pick("shortfall");
  const reserved = pick("reserved");
  const ar = pick("ar_balance");
  if (available !== null) parts.push(`可用额度 ${available}`);
  if (requested !== null) parts.push(`本单金额 ${requested}`);
  if (shortfall !== null) parts.push(`缺口 ${shortfall}`);
  if (reserved !== null) parts.push(`已占用 ${reserved}`);
  if (ar !== null) parts.push(`应收 ${ar}`);
  return `${message ?? "超出可用信用额度（fail-closed 拒绝）"}${parts.length ? `（${parts.join("，")}）` : ""}`;
}

/** 判断一个错误是否是「能力未提供」（页面据此渲染 501 区块）。 */
export function isCapabilityUnavailable(err: unknown): boolean {
  const e = err as { notImplemented?: boolean; status?: number; code?: string };
  return e?.notImplemented === true || e?.status === 501 || e?.code === "NOT_IMPLEMENTED";
}

/** 把一个错误转成页面可渲染的字符串（501 也走这里，语义不丢）。 */
export function errorTextOf(err: unknown): string {
  const e = err as ErpApiError;
  return surfaceErrorText({
    code: e?.code,
    message: e?.message,
    hint: e?.hint,
    detail: e?.detail,
    notImplemented: e?.notImplemented,
  });
}

// ---- 表单校验（端上先挡一道，服务器仍权威）----

export interface LineInput {
  productId: string;
  qty: number;
  unit?: string;
}

/** 代客下单校验：客户归属必填 + 行集非空 + 收货三要素。 */
export function proxyOrderFormError(
  customerId: string,
  lines: LineInput[],
  shipping: { contact?: string; phone?: string; address?: string } = {},
): string | null {
  if (!customerId.trim()) return "请先选择代下单客户（代客不改变数据域，只能选本人名下客户）";
  if (lines.length === 0) return "请至少添加一行商品";
  for (const l of lines) {
    if (!l.productId?.trim()) return "行商品不能为空";
    if (!(l.qty > 0)) return "行数量须为正数";
  }
  if (!shipping.contact?.trim()) return "请填写收货联系人";
  if (!shipping.phone?.trim()) return "请填写联系电话";
  if (!shipping.address?.trim()) return "请填写收货地址";
  return null;
}

/** 拒绝/驳回必须附原因（可解释拒绝纪律，服务器同样要求）。 */
export function rejectReasonError(decision: string, note: string): string | null {
  if (decision === "rejected" && !note.trim()) return "拒绝须附原因（将对客户的说明写清楚）";
  if (decision === "disputed" && !note.trim()) return "异议须附说明（将对账差异写清楚）";
  return null;
}

/** 发货反馈校验：行集 + 物流商 + 单号（凭证影像可选）。 */
export function deliveryFeedbackFormError(lines: OrderLine[], carrier: string, waybillNo: string): string | null {
  if (lines.length === 0) return "请填写发货明细（行集非空）";
  if (!carrier.trim()) return "请填写物流商";
  if (!waybillNo.trim()) return "请填写运单号";
  return null;
}

/** 签收上报校验：签收凭证或异常说明至少一项。 */
export function podFormError(documents: string[], exceptionNote: string): string | null {
  if (documents.length === 0 && !exceptionNote.trim()) {
    return "请上传签收凭证，或填写异常说明（异常签收将进处置车道）";
  }
  return null;
}

/** 月台预约校验。 */
export function dockFormError(slotId: string): string | null {
  if (!slotId.trim()) return "请填写月台时段引用（slotId 由仓库侧提供：可约时段目录当前未提供）";
  return null;
}

/** 到货预告补录校验。 */
export function arrivalNoticeFormError(poRef: string, lines: OrderLine[]): string | null {
  if (!poRef.trim()) return "请填写采购单号（poRef）";
  if (lines.length === 0) return "请填写到货明细（行集非空）";
  return null;
}

// ---- 回执文案（只复述服务器说的，不多说一句）----

/** 代客下单回执：受理=进确认车道，代理身份留痕；信用不足可解释。 */
export function proxyOrderReceipt(result: {
  order_ref?: string;
  status?: string;
  amount_total?: string;
  currency?: string;
  credit_reservation?: { amount?: string } | null;
  proxy?: { requested_by?: string; note?: string };
}): string {
  const head =
    result.status === "pending"
      ? `订单 ${result.order_ref ?? ""} 已受理，进入确认车道（待内核拍板，尚未记已确认）`
      : `订单 ${result.order_ref ?? ""} 受理结果：${result.status ?? "未知"}`;
  const amount = result.amount_total ? `；金额 ${result.amount_total} ${result.currency ?? ""}` : "";
  const credit = result.credit_reservation?.amount ? `；信用占用 ${result.credit_reservation.amount}` : "";
  const proxy = result.proxy?.requested_by ? `；代理身份留痕 ${result.proxy.requested_by}` : "";
  return `${head}${amount}${credit}${proxy}`;
}

/** 采购单接单回执（accepted 驱动到货预告编排；rejected 为终态留痕）。 */
export function poAcceptReceipt(result: { decision?: string; po_status?: string; note?: string }): string {
  if (result.decision === "accepted") {
    return `已接单（状态 ${result.po_status ?? "accepted"}）：到货预告编排已可驱动，后续发货反馈请在同页提交。`;
  }
  if (result.decision === "rejected") {
    return `已拒单（终态留痕，原因已记录）：${result.note ?? ""}改派由租户侧重下采购单。`;
  }
  return result.note ?? "已受理";
}

/** 预警处置回执（accept=确认门生效；reject=留痕不落账）。 */
export function alertReceipt(result: { status?: string; request_id?: string; handled_by?: string; note?: string }): string {
  const status = result.status ?? "";
  if (status === "confirmed" || status === "handled") {
    return `处置已确认生效（${result.request_id ?? ""}）${result.handled_by ? `，拍板人 ${result.handled_by}` : ""}：与 owner 席位同一确认门，已按处置任务闭环。`;
  }
  if (status === "rejected") {
    return `已驳回（留痕不落账）${result.note ? `：${result.note}` : ""}`;
  }
  return result.note ?? `处置回执：${status || "已受理"}`;
}

/** 承运回执。 */
export function waybillAcceptReceipt(result: { decision?: string; status?: string; note?: string }): string {
  if (result.decision === "accepted") return `已接单（运单状态 ${result.status ?? "accepted"}）：可继续月台预约/提货打卡/签收上报。`;
  if (result.decision === "rejected") return `已拒单（终态留痕）：${result.note ?? ""}改派由租户侧重下运单。`;
  return result.note ?? "已受理";
}

/** 签收回执：异常签收进处置车道；结单/计费由计费规则引擎驱动（本端不落结单态）。 */
export function podReceipt(result: {
  waybill_no?: string;
  exception?: boolean;
  documents?: string[];
  disposal_request_id?: string | null;
  disposal_status?: string | null;
  settlement_note?: string;
}): string {
  const base = result.exception
    ? `异常签收已上报（运单 ${result.waybill_no ?? ""}）：已进处置车道${result.disposal_request_id ? `（处置单 ${result.disposal_request_id}，状态 ${result.disposal_status ?? "pending"}）` : ""}`
    : `签收已上报（运单 ${result.waybill_no ?? ""}），回单 ${result.documents?.length ?? 0} 件`;
  return `${base}。${result.settlement_note ?? ""}`;
}

// ---- 确认门 flow（P2/P3 拍板页直驱真机器）----

/**
 * 通用拍板 flow：一次提交 → 服务器确认即 settle.confirm；拒绝把服务器人话
 * 原样回显（表单不关、字段保留）；8s 无回执由机器超时兜底，绝不假报成功。
 * 501 也走 reject —— 「能力未提供」不是成功。
 */
export function submitDecisionFlow<T>(
  gate: GateLike,
  deps: { perform: () => Promise<T>; onConfirmed?: (result: T) => void; fallback?: string },
): void {
  gate.start(async (settle) => {
    try {
      const result = await deps.perform();
      settle.confirm();
      deps.onConfirmed?.(result);
    } catch (e) {
      settle.reject(errorTextOf(e) || deps.fallback || "提交失败，请重试");
    }
  });
}
