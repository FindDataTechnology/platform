// SE 销售助手数据面接线（openspec: add-erp-miniapp-pagesets P2）。
// 传输=底座 @platform/core http（taro-http installHttp 已配置，与 chat/cron
// 同一条鉴权/401-retry 管线，零旁路）；身份头 X-ERP-Staff 由 identity-wire
// 每次请求时求值 —— 未绑定则不带（服务器 AUTH_REQUIRED，页面如实展示）。

import { http } from "@platform/core";
import { type ErpTransport } from "./erp-api.ts";
import { makeSeApi, type SeApi } from "./surface-api.ts";
import { surfaceHeaders } from "./identity-wire.ts";

export const seApi: SeApi = makeSeApi(http as ErpTransport, () => surfaceHeaders("supply-chain.se"));
