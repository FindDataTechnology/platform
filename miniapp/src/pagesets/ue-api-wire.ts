// The one transport wiring for UE pages (openspec: add-erp-miniapp-pagesets
// P1). Pages import `ueApi` from here; the transport is the base runtime's
// @platform/core http (configured by src/lib/taro-http.ts installHttp() at
// boot — the same auth-header/401-retry pipeline as chat/cron, zero bypass).
//
// This module exists separately from erp-api.ts so the pure data plane stays
// node --testable (node cannot resolve "@platform/core"; the wire can).

import { http } from "@platform/core";
import { makeUeApi, type ErpTransport, type UeApi } from "./erp-api.ts";

export const ueApi: UeApi = makeUeApi(http as ErpTransport);
