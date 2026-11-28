// Surface identity gate for SE/SP/CP pages (openspec: add-erp-miniapp-pagesets
// P2/P3). Three thin pieces every external-surface page reuses:
//   - useSurfaceIdentity(key): the resolved identity (pure rules in identity.ts);
//   - <IdentityMissing identity>: the honest fail-closed block shown instead of
//     the page body when no identity is bound. It names the exact header and how
//     to bind it — and the page simply does not fire requests (never a guessed
//     identity, never an empty list pretending to be real data);
//   - useSurfaceRead(loader): one read with honest 501 separation, so a page
//     renders 「该能力当前未提供」 instead of a generic load error.
//
// The loader runs on mount (and when `reloadKey` changes) and is kept in a ref,
// so a page may pass an inline closure without triggering a reload loop.

import { Text, View } from "@tarojs/components";
import { useCallback, useEffect, useRef, useState } from "react";
import { surfaceIdentity } from "./identity-wire.ts";
import { errorTextOf } from "./surface-view.ts";
import type { SurfaceIdentity } from "./identity.ts";
import type { PagesetKey } from "./types.ts";

/** 当前面集身份（每次渲染求值：存储已缓存，成本可忽略）。 */
export function useSurfaceIdentity(key: PagesetKey): SurfaceIdentity {
  return surfaceIdentity(key);
}

/** 身份未绑定时的如实区块（不是错误红：这是配置缺失，不是请求失败）。 */
export function IdentityMissing({ identity }: { identity: SurfaceIdentity }) {
  return (
    <View className="erp-capability" data-testid="erp-identity-missing">
      <Text className="erp-capability-title">未绑定身份，本页不发请求</Text>
      <Text className="erp-capability-message">{identity.reason ?? ""}</Text>
    </View>
  );
}

/** 错误行：闸类错误码转人话（身份/页面集/权限码/数据域/不存在/信用）。 */
export function ErrorLine({ error }: { error: unknown }) {
  return (
    <View className="erp-state erp-state-error" data-testid="erp-error-line">
      <Text className="erp-state-text">{errorTextOf(error)}</Text>
    </View>
  );
}

export interface SurfaceReadState<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  notImplemented: boolean;
  notImplementedMessage: string;
  reload: () => void;
}

/**
 * 一面读：enabled=false 时不发请求（身份未绑定的 fail-closed）。501 与错误
 * 分开呈现 —— 501 是「能力未提供」，不是加载失败。
 */
export function useSurfaceRead<T>(loader: () => Promise<T>, enabled = true, reloadKey?: unknown): SurfaceReadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<unknown>(null);
  const [notImplemented, setNotImplemented] = useState(false);
  const [notImplementedMessage, setNotImplementedMessage] = useState("");

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick/reloadKey 是刻意的重跑触发器（reload() 递增 tick；页面换查询条件时换 reloadKey），loader 本身经 ref 保持稳定。
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    setNotImplemented(false);
    loaderRef
      .current()
      .then((d) => {
        if (!live) return;
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        const err = e as { notImplemented?: boolean; status?: number; code?: string; message?: string };
        setLoading(false);
        if (err?.notImplemented === true || err?.status === 501 || err?.code === "NOT_IMPLEMENTED") {
          setNotImplemented(true);
          setNotImplementedMessage(err?.message ?? "");
        } else {
          setError(e);
        }
      });
    return () => {
      live = false;
    };
  }, [enabled, tick, reloadKey]);

  return { data, loading, error, notImplemented, notImplementedMessage, reload };
}
