// Surface identity wiring (openspec: add-erp-miniapp-pagesets P2/P3).
//
// The pure resolution rules live in identity.ts; this module supplies the two
// inputs the runtime owns:
//   1. the signed-in account (src/lib/auth sessionEmail — SE 业务员 identity);
//   2. the persisted external-profile binding for SP/CP (供应商/承运商档案 not
//      being platform accounts, they must be bound explicitly).
//
// Binding blob (storage key erp.surface.bindings, JSON):
//   { "staff": "S1001", "supplier": "SUP-0007", "carrier": "SF-EXPRESS" }
// Written by the delivery/demo configuration step; 网关 PAT 落地后由服务端身份
// 取代，本模块届时退化为空。Unreadable binding = NO binding (fail-closed).

import Taro from "@tarojs/taro";
import { sessionEmail } from "@/lib/auth";
import {
  SURFACE_BINDINGS_KEY,
  identityHeaders,
  parseSurfaceBindings,
  resolveSurfaceIdentity,
  type SurfaceBindings,
  type SurfaceIdentity,
} from "./identity.ts";
import type { PagesetKey } from "./types.ts";

let cached: SurfaceBindings | null = null;

/** 读取外部身份绑定（一次读盘后缓存；写配置后调 refreshBindings）。 */
export function loadBindings(): SurfaceBindings {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    raw = Taro.getStorageSync(SURFACE_BINDINGS_KEY);
  } catch {
    raw = null; // 存储不可用 → 无绑定（fail-closed）
  }
  cached = parseSurfaceBindings(raw);
  return cached;
}

/** 绑定变更后清缓存（交付配置/身份切换时调用）。 */
export function refreshBindings(): void {
  cached = null;
}

/** 某面集的当前身份（未绑定 → value=null + 人话 reason）。 */
export function surfaceIdentity(key: PagesetKey): SurfaceIdentity {
  return resolveSurfaceIdentity(key, { sessionEmail: sessionEmail(), bindings: loadBindings() });
}

/** 某面集的身份头（未绑定 → {}，请求不带假身份）。 */
export function surfaceHeaders(key: PagesetKey): Record<string, string> {
  return identityHeaders(surfaceIdentity(key));
}
