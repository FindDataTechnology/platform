// Static registry of the four ERP supply-chain page sets (openspec:
// add-erp-miniapp-pagesets, D2/D4). Page ids, titles and requiredGrants are
// transcribed from the manifests at
// fd-erp-vertical-templates/templates/supply-chain/pagesets/*/manifest.json.
//
// Routes follow the D2 namespace pages/<surface>/<page-id minus prefix>
// (ue-home -> pages/ue/home). The pages themselves land phase by phase
// (P1 UE, P2 SE+SP, P3 CP) and are appended to app.config.ts as they arrive —
// WeChat requires static page registration, so this registry drives ENTRIES
// and the ROUTE GUARD, never dynamic loading. P0 registers zero new pages:
// every path below is forward-declared, consumed only when its phase ships.

import type { PagesetDef, PagesetKey } from "./types.ts";

export const PAGESETS: readonly PagesetDef[] = [
  {
    key: "supply-chain.ue",
    id: "supply-chain-ue-commerce",
    name: "UE 订货台",
    homePath: "pages/ue/home",
    requiredGrants: ["catalog.read", "order.write", "statement.confirm", "invoice.write", "aftersale.write", "ai.chat"],
    pages: [
      { id: "ue-home", path: "pages/ue/home", title: "订货首页", requiredGrants: [] },
      { id: "ue-product-search", path: "pages/ue/product-search", title: "商品检索", requiredGrants: [] },
      { id: "ue-product-detail", path: "pages/ue/product-detail", title: "商品详情", requiredGrants: [] },
      { id: "ue-cart", path: "pages/ue/cart", title: "进货单", requiredGrants: [] },
      { id: "ue-order-create", path: "pages/ue/order-create", title: "订单确认", requiredGrants: ["order.write"] },
      { id: "ue-order-list", path: "pages/ue/order-list", title: "我的订单", requiredGrants: [] },
      { id: "ue-order-detail", path: "pages/ue/order-detail", title: "订单详情与物流轨迹", requiredGrants: [] },
      { id: "ue-statement-confirm", path: "pages/ue/statement-confirm", title: "对账单确认", requiredGrants: ["statement.confirm"] },
      { id: "ue-invoice-apply", path: "pages/ue/invoice-apply", title: "开票申请", requiredGrants: ["invoice.write"] },
      { id: "ue-aftersale-apply", path: "pages/ue/aftersale-apply", title: "售后申请", requiredGrants: ["aftersale.write"] },
      { id: "ue-aftersale-detail", path: "pages/ue/aftersale-detail", title: "售后进度", requiredGrants: [] },
      { id: "ue-ai-assistant", path: "pages/ue/ai-assistant", title: "AI 助手", requiredGrants: ["ai.chat"] },
    ],
  },
  {
    key: "supply-chain.se",
    id: "supply-chain-se-sales",
    name: "SE 销售助手",
    homePath: "pages/se/home",
    requiredGrants: [
      "catalog.read",
      "order.write.proxy",
      "crm.read",
      "crm.visit.write",
      "alert.handle",
      "statement.confirm.proxy",
      "ai.chat",
    ],
    pages: [
      { id: "se-home", path: "pages/se/home", title: "业务员工作台", requiredGrants: [] },
      { id: "se-customer-list", path: "pages/se/customer-list", title: "客户与线索", requiredGrants: ["crm.read"] },
      { id: "se-customer-detail", path: "pages/se/customer-detail", title: "客户 360", requiredGrants: ["crm.read"] },
      { id: "se-lead-visit", path: "pages/se/lead-visit", title: "线索/拜访登记", requiredGrants: ["crm.visit.write"] },
      { id: "se-order-proxy", path: "pages/se/order-proxy", title: "代客下单", requiredGrants: ["order.write.proxy"] },
      { id: "se-order-track", path: "pages/se/order-track", title: "名下订单跟进", requiredGrants: [] },
      { id: "se-alert-inbox", path: "pages/se/alert-inbox", title: "预警收件箱", requiredGrants: ["alert.handle"] },
      { id: "se-alert-handle", path: "pages/se/alert-handle", title: "预警处置（拍板）", requiredGrants: ["alert.handle"] },
      { id: "se-statement-assist", path: "pages/se/statement-assist", title: "对账协助", requiredGrants: ["statement.confirm.proxy"] },
      { id: "se-ai-assistant", path: "pages/se/ai-assistant", title: "AI 助手", requiredGrants: ["ai.chat"] },
    ],
  },
  {
    key: "supply-chain.sp",
    id: "supply-chain-sp-supplier",
    name: "SP 供应商协同",
    homePath: "pages/sp/home",
    requiredGrants: ["po.read", "po.accept", "delivery.feedback", "statement.read", "invoice.upload", "ai.chat"],
    pages: [
      { id: "sp-home", path: "pages/sp/home", title: "供应商工作台", requiredGrants: [] },
      { id: "sp-order-accept", path: "pages/sp/order-accept", title: "接单", requiredGrants: ["po.accept"] },
      { id: "sp-delivery-feedback", path: "pages/sp/delivery-feedback", title: "发货反馈", requiredGrants: ["delivery.feedback"] },
      { id: "sp-arrival-notice", path: "pages/sp/arrival-notice", title: "到货预告", requiredGrants: [] },
      { id: "sp-reconciliation", path: "pages/sp/reconciliation", title: "对账单", requiredGrants: ["statement.read"] },
      { id: "sp-invoice-upload", path: "pages/sp/invoice-upload", title: "发票上传", requiredGrants: ["invoice.upload"] },
      { id: "sp-payment-view", path: "pages/sp/payment-view", title: "结算查询", requiredGrants: [] },
      { id: "sp-ai-assistant", path: "pages/sp/ai-assistant", title: "AI 助手", requiredGrants: ["ai.chat"] },
    ],
  },
  {
    key: "supply-chain.cp",
    id: "supply-chain-cp-carrier",
    name: "CP 承运协同",
    homePath: "pages/cp/home",
    requiredGrants: [
      "waybill.read",
      "waybill.accept",
      "dock.reserve",
      "pickup.checkin",
      "pod.report",
      "freight.statement.read",
      "ai.chat",
    ],
    pages: [
      { id: "cp-home", path: "pages/cp/home", title: "承运商工作台", requiredGrants: [] },
      { id: "cp-waybill-accept", path: "pages/cp/waybill-accept", title: "运单接收", requiredGrants: ["waybill.accept"] },
      { id: "cp-dock-reserve", path: "pages/cp/dock-reserve", title: "月台预约", requiredGrants: ["dock.reserve"] },
      { id: "cp-pickup-checkin", path: "pages/cp/pickup-checkin", title: "提货打卡", requiredGrants: ["pickup.checkin"] },
      { id: "cp-pod-report", path: "pages/cp/pod-report", title: "签收上报", requiredGrants: ["pod.report"] },
      { id: "cp-track", path: "pages/cp/track", title: "运单跟踪", requiredGrants: [] },
      { id: "cp-reconciliation", path: "pages/cp/reconciliation", title: "运费对账", requiredGrants: ["freight.statement.read"] },
      { id: "cp-ai-assistant", path: "pages/cp/ai-assistant", title: "AI 助手", requiredGrants: ["ai.chat"] },
    ],
  },
];

export function pagesetByKey(key: PagesetKey): PagesetDef | undefined {
  return PAGESETS.find((p) => p.key === key);
}

// Route lookup for the guard: which pageset owns this statically-registered
// page path. Unknown paths (the base's own 7 pages) return undefined — the
// guard simply lets them through.
export function pagesetByPagePath(path: string): PagesetDef | undefined {
  return PAGESETS.find((p) => p.pages.some((page) => page.path === path));
}

export function pageByPath(path: string): PagesetDef["pages"][number] | undefined {
  for (const p of PAGESETS) {
    const page = p.pages.find((x) => x.path === path);
    if (page) return page;
  }
  return undefined;
}
