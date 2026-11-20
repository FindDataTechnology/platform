// Surface identity for the SE / SP / CP page sets (openspec:
// add-erp-miniapp-pagesets P2/P3).
//
// The UE surface addresses the tenant's own customer, which the base session
// already carries. The three external-facing surfaces address someone else:
//   SE 销售助手   X-ERP-Staff    业务员（= 平台登录账号；网关 PAT 落地前的演示形态）
//   SP 供应商协同 X-ERP-Supplier 供应商档案（id 或编码）
//   CP 承运协同   X-ERP-Carrier  承运商标识
// ERP-side the header is a hard gate (AUTH_REQUIRED when absent, 404 when the
// profile is outside the caller's domain). This module resolves that value and
// is FAIL-CLOSED: no identity -> no request at all, and the page renders the
// honest "身份未绑定" state naming the exact missing header. Never send a
// guessed identity, never fabricate a profile id.
//
// Pure (no Taro/React) so node --test drives every resolution branch; the
// storage/session binding lives in identity-wire.ts.

import type { ErpTransport } from "./erp-api.ts";
import type { PagesetKey } from "./types.ts";

/** Which identity header each surface needs (ERP-side gate, faces.py). */
export const SURFACE_HEADER: Readonly<Record<string, string>> = {
  "supply-chain.ue": "", // UE 无外部身份头（租户+客户会话已足够）
  "supply-chain.se": "X-ERP-Staff",
  "supply-chain.sp": "X-ERP-Supplier",
  "supply-chain.cp": "X-ERP-Carrier",
};

/** 运行配置里的外部身份绑定（SP/CP 档案不在平台账号体系内，须显式绑定）。 */
export interface SurfaceBindings {
  staff?: string;
  supplier?: string;
  carrier?: string;
}

/** 存储键（交付/演示期绑定；网关 PAT 落地后由服务端身份取代）。 */
export const SURFACE_BINDINGS_KEY = "erp.surface.bindings";

/**
 * Strict parse of the persisted binding blob. Anything malformed yields an
 * EMPTY binding set (fail-closed: an unreadable binding is no binding), never
 * a partial trust. Unknown keys are ignored; non-strings are dropped.
 */
export function parseSurfaceBindings(raw: unknown): SurfaceBindings {
  if (typeof raw === "string") {
    if (!raw.trim()) return {};
    try {
      return parseSurfaceBindings(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  if (raw === null || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: SurfaceBindings = {};
  for (const key of ["staff", "supplier", "carrier"] as const) {
    const v = src[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return out;
}

export interface SurfaceIdentity {
  /** 需要的身份头（UE 为空串：不需要）。 */
  header: string;
  /** 身份值；null = 未绑定（fail-closed，页面不发请求）。 */
  value: string | null;
  /** 人话出处（审计/排障用，页面可直接展示）。 */
  source: string;
  /** value 为 null 时的可解释原因（页面原样展示）。 */
  reason: string | null;
}

/** 身份来源：会话登录账号 + 运行配置绑定。 */
export interface IdentitySources {
  sessionEmail?: string | null;
  bindings?: SurfaceBindings;
}

/**
 * Resolve the identity for a surface.
 * - SE: 运行配置 staff 优先，其次会话登录账号（业务员=平台账号的自然映射）。
 * - SP/CP: 只有运行配置绑定（供应商/承运商档案不在平台账号体系内）。
 * - UE: 不需要身份头，恒 value=null 但 reason=null（不是缺失）。
 */
export function resolveSurfaceIdentity(key: PagesetKey, sources: IdentitySources = {}): SurfaceIdentity {
  const header = SURFACE_HEADER[key] ?? "";
  if (!header) {
    return { header: "", value: null, source: "UE 面身份由租户+客户会话承载，无需外部身份头", reason: null };
  }
  const bindings = sources.bindings ?? {};
  const fromBinding =
    key === "supply-chain.se" ? bindings.staff : key === "supply-chain.sp" ? bindings.supplier : bindings.carrier;
  if (fromBinding) {
    return {
      header,
      value: fromBinding,
      source: `运行配置绑定（${SURFACE_BINDINGS_KEY}）`,
      reason: null,
    };
  }
  if (key === "supply-chain.se") {
    const email = (sources.sessionEmail ?? "").trim();
    if (email) {
      return { header, value: email, source: "平台登录账号（业务员=平台账号）", reason: null };
    }
  }
  return {
    header,
    value: null,
    source: "未绑定",
    reason:
      `未取得${key === "supply-chain.se" ? "业务员" : key === "supply-chain.sp" ? "供应商" : "承运商"}身份` +
      `（缺少 ${header}）：本页不发送请求，也不以假身份代填。` +
      (key === "supply-chain.se"
        ? "请先登录平台账号，或在运行配置中绑定工号。"
        : `请在运行配置中绑定档案（${SURFACE_BINDINGS_KEY}）。`),
  };
}

/** The header record for a resolved identity ({} when unresolved). */
export function identityHeaders(identity: SurfaceIdentity): Record<string, string> {
  if (!identity.header || identity.value === null) return {};
  return { [identity.header]: identity.value };
}

/** Headers provider evaluated per request (identity may load after boot). */
export type HeadersProvider = () => Record<string, string>;

/**
 * Wrap a transport so every call carries the surface identity headers.
 * Unresolved identity yields NO headers — the ERP side then answers
 * AUTH_REQUIRED, and the page shows that verbatim. We never invent a value.
 */
export function withSurfaceIdentity(transport: ErpTransport, headers: HeadersProvider): ErpTransport {
  return (path, init) => {
    const extra = headers();
    if (Object.keys(extra).length === 0) return transport(path, init);
    return transport(path, { ...init, headers: { ...(init?.headers ?? {}), ...extra } });
  };
}
