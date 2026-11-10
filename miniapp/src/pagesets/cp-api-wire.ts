// CP 承运协同数据面接线（openspec: add-erp-miniapp-pagesets P3）。
// 传输=底座 @platform/core http；身份头 X-ERP-Carrier 由 identity-wire 每次
// 请求时求值（承运商标识须显式绑定，未绑定则不带）。采集纪律：定位/影像为
// 可选采集，隐私声明过审后启用（页面在采集项旁如实标注）。

import { http } from "@platform/core";
import { type ErpTransport } from "./erp-api.ts";
import { makeCpApi, type CpApi } from "./surface-api.ts";
import { surfaceHeaders } from "./identity-wire.ts";

export const cpApi: CpApi = makeCpApi(http as ErpTransport, () => surfaceHeaders("supply-chain.cp"));
