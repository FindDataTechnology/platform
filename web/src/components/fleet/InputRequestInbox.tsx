// ── Input-request inbox (add-input-request-cards 4.6) ───────────────────────
//
// 跨团队/跨会话的「待填表」收件箱：待拍板旁边那一格。它读的是同一个端点
// （`GET /api/input-requests`，owner-scoped），所以不会出现「团队面说有一张、
// 点进去却没有」的第二份真相——待答卡在行上只有一份。
//
// 一张卡可以在这里直接填：复用 InputRequestCard 的字段渲染，只是没有工具块。
// 提交流程与聊天里完全一致（同一端点、同一校验），不是第二条实现。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Inbox, RefreshCw } from "lucide-react";
import type { InputRequestView } from "@platform/core";
import { InputRequestInboxCard } from "@/components/InputRequestInboxCard";

export function InputRequestInbox() {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<InputRequestView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/input-requests?limit=20");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { requests?: InputRequestView[] };
      setRequests(body.requests ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // 30s 轮询与团队板同一节奏；输入请求不常有，不值得再开一条推送。
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <section
      className="rounded-md border border-border bg-card px-4 py-3"
      data-testid="input-request-inbox"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium text-foreground">{t("inputInbox.title")}</span>
        <span className="text-sm text-muted-foreground" data-testid="input-request-inbox-count">
          {t("inputInbox.count", { count: requests.length })}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("inputInbox.refresh")}
        >
          <RefreshCw className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"} aria-hidden="true" />
        </button>
      </div>

      {error && (
        <div role="alert" className="mt-2 text-xs text-destructive">
          {t("inputInbox.error", { message: error })}
        </div>
      )}

      {!error && requests.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">{t("inputInbox.empty")}</p>
      )}

      {requests.length > 0 && (
        <ul className="mt-2 space-y-2">
          {requests.map((r) => (
            <li key={r.requestId}>
              <InputRequestInboxCard request={r} onSettled={() => void load()} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
