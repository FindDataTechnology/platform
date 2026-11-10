// The pageset route guard + entry hook (openspec: add-erp-miniapp-pagesets 1.2).
//
// WeChat mini programs register pages statically (app.config.ts), so
// "unauthorized invisible" is enforced at two experience layers:
//   - entries: useVisiblePagesets() renders only authorized pagesets;
//   - routes:  <PagesetGate pagePath=...> wraps every pageset page and
//              bounces direct URL entry (share/scan/history) to the base's
//              chat home with an explainable toast.
// The decision itself lives in authorize.ts (pure, node-testable); this file
// is the thin Taro/React binding. The server stays authoritative per page
// (api-contract 通用约定); the guard is UX only. Fail-closed: while
// authorization is unknown/loading/errored the gate renders nothing and
// blocks — never a flash of an unauthorized page.

import Taro from "@tarojs/taro";
import type { ReactElement } from "react";
import { useEffect, useMemo } from "react";
import {
  guardDecision,
  pageBlockReason,
  visiblePagesets,
  type PagesetAuthStatus,
  type PagesetGrants,
} from "./authorize.ts";
import { pagesetByPagePath } from "./registry.ts";
import { usePagesetAuthStore } from "./store.ts";

const HOME = "/pages/chat/index";

export { guardDecision };

/**
 * Entry surface hook: the pagesets (and their reachable pages) this tenant
 * may see, in registry order. While authorization is unsettled this is an
 * empty list — entries must simply not render (invisible ≠ grayed out).
 * Triggers the single-flight REST read on first use.
 */
export function useVisiblePagesets(): ReturnType<typeof visiblePagesets> {
  const status = usePagesetAuthStore((s) => s.status);
  const grants = usePagesetAuthStore((s) => s.grants);
  const refresh = usePagesetAuthStore((s) => s.refresh);

  useEffect(() => {
    if (status === "unknown") void refresh();
  }, [status, refresh]);

  return useMemo(() => (status === "ready" ? visiblePagesets(grants) : []), [status, grants]);
}

/**
 * Wrap a pageset page with the guard. While unsettled it renders nothing;
 * once the read has decided and the page is not reachable, it explains and
 * bounces home, still rendering nothing. Children mount only on an
 * authorized page.
 */
export function PagesetGate({ pagePath, children }: { pagePath: string; children: ReactElement }) {
  const status = usePagesetAuthStore((s) => s.status);
  const grants = usePagesetAuthStore((s) => s.grants);
  const refresh = usePagesetAuthStore((s) => s.refresh);

  useEffect(() => {
    if (status === "unknown") void refresh();
  }, [status, refresh]);

  const decision = guardDecision(pagePath, status, grants);

  useEffect(() => {
    if (decision !== "blocked") return;
    const def = pagesetByPagePath(pagePath);
    Taro.showToast({
      title: def ? pageBlockReason(def, pagePath, grants) : "当前账号未开通该功能，请联系管理员开通",
      icon: "none",
    });
    Taro.reLaunch({ url: HOME });
  }, [decision, pagePath, grants]);

  if (decision !== "allowed") return null;
  return children;
}

export type { PagesetAuthStatus, PagesetGrants };
