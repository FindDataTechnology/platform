// SP 供应商协同数据面接线（openspec: add-erp-miniapp-pagesets P2）。
// 传输=底座 @platform/core http；身份头 X-ERP-Supplier 由 identity-wire 每次
// 请求时求值（供应商档案须显式绑定，未绑定则不带）。资金红线：本端零支付
// 操作面 —— 只有只读结算查询，支付走金蝶/持牌通道。

import { http } from "@platform/core";
import { type ErpTransport } from "./erp-api.ts";
import { makeSpApi, type SpApi } from "./surface-api.ts";
import { surfaceHeaders } from "./identity-wire.ts";

export const spApi: SpApi = makeSpApi(http as ErpTransport, () => surfaceHeaders("supply-chain.sp"));
