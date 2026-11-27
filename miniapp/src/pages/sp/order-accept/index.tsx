// SP 接单（P2 4.2 确认门页，契约 §2）：GET /sp/purchase-orders（列表）→
// GET /sp/purchase-orders/{id}（明细）→ POST .../accept（确认门）。
// 接单回执写采购编排同一状态机（不建第二状态机）；accepted 驱动到货预告编排，
// rejected 为终态、须附原因（可解释拒绝）。四段式由 ConfirmGate 承载。

import { useState } from "react";
import { ScrollView, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { spApi } from "@/pagesets/sp-api-wire";
import { type SpPurchaseOrderDetail, type SpPurchaseOrderRow } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import { ConfirmGate, useConfirmGate } from "@/components/ConfirmGate";
import { poAcceptReceipt, poStatusText, rejectReasonError, submitDecisionFlow } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/sp/order-accept";
const SURFACE = "supply-chain.sp" as const;

export default function SpOrderAcceptPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useSurfaceRead(() => spApi.purchaseOrders({ limit: 50 }), ready);
  const detail = useSurfaceRead<SpPurchaseOrderDetail>(() => spApi.purchaseOrder(openId ?? ""), ready && !!openId, openId);

  const [decision, setDecision] = useState<"accepted" | "rejected">("accepted");
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const gate = useConfirmGate({
    onSettled: (r) => {
      if (r.outcome === "confirmed") Taro.showToast({ title: "已提交", icon: "none" });
    },
  });
  useState(() => () => gate.dispose());

  const rows: SpPurchaseOrderRow[] = list.data?.data ?? [];
  const d = detail.data;

  const submit = () => {
    if (gate.isPending() || !openId) return;
    setLocalError(null);
    const err = rejectReasonError(decision, note);
    if (err) {
      setLocalError(err);
      return;
    }
    submitDecisionFlow(gate, {
      perform: () =>
        spApi.acceptPurchaseOrder(openId, { decision, ...(decision === "rejected" ? { rejectedNote: note.trim() } : {}) }),
      onConfirmed: (result) => setReceipt(poAcceptReceipt(result as { decision?: string; po_status?: string; note?: string })),
    });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="sp-order-accept-page">
        <PageHeader title="接单" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/sp/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && list.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && list.error ? <ErrorLine error={list.error} /> : null}
            {ready && !list.loading && !list.error && rows.length === 0 ? (
              <ErpStateLine text="暂无推送给本供应商的采购单" />
            ) : null}

            {!openId ? (
              <View className="ue-list" data-testid="sp-po-list">
                {rows.map((p) => (
                  <View key={p.poId} className="ue-row-card" data-testid="sp-po-row" onClick={() => setOpenId(p.poId ?? "")}>
                    <View className="ue-row-main">
                      <Text className="ue-product-title ue-mono">{p.poId}</Text>
                      <Text className="ue-product-meta">
                        {poStatusText(p.status)} · {(p.lines ?? []).length} 行
                      </Text>
                    </View>
                    <Text className="ue-row-action">明细</Text>
                  </View>
                ))}
              </View>
            ) : (
              <View className="ue-card" data-testid="sp-po-detail">
                <Text className="ue-detail-title ue-mono">{openId}</Text>
                {detail.loading ? <ErpStateLine text="加载中…" /> : null}
                {detail.error ? <ErrorLine error={detail.error} /> : null}
                {d ? (
                  <>
                    <View className="ue-kv">
                      <Text className="ue-kv-key">状态</Text>
                      <Text className="ue-kv-val">{poStatusText(d.status)}</Text>
                    </View>
                    {d.status_note ? <Text className="ue-note-line">{d.status_note}</Text> : null}
                    <Text className="ue-note-strong">采购行</Text>
                    {(d.lines ?? []).length === 0 ? <ErpStateLine text="无行明细" /> : null}
                    {(d.lines ?? []).map((l, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 行集无稳定 id（本地草稿行/服务端行数组），只读渲染且顺序即身份
                      <View key={i} className="ue-kv">
                        <Text className="ue-kv-key">{String(l.product ?? l.product_code ?? "")}</Text>
                        <Text className="ue-kv-val">
                          × {String(l.qty ?? "")} {l.unit ?? ""}
                        </Text>
                      </View>
                    ))}
                    {d.field_note ? <Text className="ue-note-line">{d.field_note}</Text> : null}
                    <View className="ue-kv">
                      <Text className="ue-kv-key">已回发货反馈</Text>
                      <Text className="ue-kv-val">{(d.delivery_feedbacks ?? []).length} 条</Text>
                    </View>
                    <View className="ue-kv">
                      <Text className="ue-kv-key">到货预告</Text>
                      <Text className="ue-kv-val">{(d.arrival_notices ?? []).length} 条</Text>
                    </View>
                    <View className="ue-kv">
                      <Text className="ue-kv-key">入库任务</Text>
                      <Text className="ue-kv-val">{(d.inbound_tasks ?? []).length} 条</Text>
                    </View>
                  </>
                ) : null}
              </View>
            )}

            {openId && d && !receipt ? (
              <View className="ue-card" data-testid="sp-po-decision">
                <Text className="ue-detail-title">接单决定</Text>
                <View className="ue-chip-row">
                  {([
                    ["accepted", "接受"],
                    ["rejected", "拒绝"],
                  ] as const).map(([v, label]) => (
                    <Text
                      key={v}
                      className={`ue-chip${decision === v ? " ue-chip-active" : ""}`}
                      data-testid={`sp-po-decision-${v}`}
                      onClick={() => setDecision(v)}
                    >
                      {label}
                    </Text>
                  ))}
                </View>
                {decision === "rejected" ? (
                  <Textarea
                    className="ue-textarea"
                    placeholder="拒单原因（必填，可发起协商）"
                    value={note}
                    onInput={(e) => setNote(e.detail.value)}
                    maxlength={200}
                  />
                ) : null}
                {localError ? (
                  <Text className="ue-error-line" data-testid="sp-po-form-error">
                    {localError}
                  </Text>
                ) : null}
                <ConfirmGate
                  api={gate}
                  onSubmit={submit}
                  submitLabel={decision === "accepted" ? "接受订单" : "拒绝订单"}
                  pendingLabel="提交中…"
                  className="ue-cta"
                  pendingClassName="ue-cta-disabled"
                  errorClassName="ue-error-line"
                  testId="sp-po-submit"
                  errorTestId="sp-po-gate-error"
                />
                <Text className="ue-note-line">回执写入采购单同一状态机；接单后请在同页提交发货反馈。</Text>
                <Text className="ue-link-btn" onClick={() => setOpenId(null)}>
                  返回列表
                </Text>
              </View>
            ) : null}

            {receipt ? (
              <View className="ue-card" data-testid="sp-po-receipt">
                <Text className="ue-detail-title">接单回执</Text>
                <Text className="ue-note-strong">{receipt}</Text>
                <Text
                  className="ue-link-btn"
                  onClick={() => Taro.redirectTo({ url: `/pages/sp/delivery-feedback?poId=${encodeURIComponent(openId ?? "")}` })}
                >
                  去提交发货反馈
                </Text>
              </View>
            ) : null}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
