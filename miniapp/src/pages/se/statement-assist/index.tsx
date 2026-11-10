// SE 对账协助（P2 3.5）：GET /se/statements（名下客户对账单状态总览）+
// POST /se/statements/{id}/push（端内消息推送，后端如实 501）。
// 铁律：SE 端不可代客户拍板 —— 客户确认仍走 UE 端确认门（本页只推送/催办）。

import { useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { seApi } from "@/pagesets/se-api-wire";
import { type SeStatementRow } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { CapabilityUnavailable, ErpStateLine } from "@/pagesets/ue-states";
import { errorTextOf } from "@/pagesets/surface-view";
import { fmtAmount, statementStatusText } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/se/statement-assist";
const SURFACE = "supply-chain.se" as const;

export default function SeStatementAssistPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const read = useSurfaceRead(() => seApi.statements({ limit: 50 }), ready);
  const rows: SeStatementRow[] = read.data?.data ?? [];

  const [pushState, setPushState] = useState<{ id: string; error: string | null; notImplemented: boolean; message: string } | null>(null);

  const push = (id: string) => {
    setPushState({ id, error: null, notImplemented: false, message: "" });
    seApi
      .pushStatement(id, { channel: "inapp" })
      .then(() => setPushState({ id, error: null, notImplemented: false, message: "推送已受理" }))
      .catch((e: unknown) => {
        const err = e as { notImplemented?: boolean; status?: number; code?: string; message?: string };
        if (err?.notImplemented === true || err?.status === 501) {
          setPushState({ id, error: null, notImplemented: true, message: err?.message ?? "" });
          return;
        }
        setPushState({ id, error: errorTextOf(e), notImplemented: false, message: "" });
      });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="se-statement-assist-page">
        <PageHeader title="对账协助" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/se/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}
            {ready && !read.loading && !read.error && rows.length === 0 ? (
              <ErpStateLine text="名下客户本期暂无对账单" />
            ) : null}

            <View className="ue-list" data-testid="se-statement-list">
              {rows.map((s) => (
                <View key={s.statement_id} className="ue-row-card" data-testid="se-statement-row">
                  <View className="ue-row-main">
                    <Text className="ue-product-title">
                      {s.period ?? ""} 对账单 · {s.customer_id ?? ""}
                    </Text>
                    <Text className="ue-product-meta">
                      {s.order_count ?? 0} 笔 · {statementStatusText(s.status)}
                    </Text>
                  </View>
                  <Text className="ue-product-price">
                    {fmtAmount(s.amount_total)} {s.currency ?? ""}
                  </Text>
                  <Text className="ue-link-btn" onClick={() => push(s.statement_id ?? "")}>
                    推送提醒
                  </Text>
                </View>
              ))}
            </View>

            {pushState?.notImplemented ? <CapabilityUnavailable message={pushState.message} /> : null}
            {pushState?.error ? <ErrorLine error={{ message: pushState.error }} /> : null}
            {pushState?.message && !pushState.notImplemented && !pushState.error ? (
              <ErpStateLine text={pushState.message} />
            ) : null}

            <Text className="ue-note-line">客户的对账单确认只能由客户在订货台确认门完成；业务员端不代拍板（契约 §5 铁律）。</Text>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
