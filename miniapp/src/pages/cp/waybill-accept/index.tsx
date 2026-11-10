// CP 运单接收（P3 5.2 确认门页，契约 §2）：GET /cp/waybills → 明细 →
// POST /cp/waybills/{id}/accept。承运回执写交付编排运单同一状态机；
// rejected 须附原因、为终态留痕（改派由租户侧重下运单）。

import { useState } from "react";
import { ScrollView, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { cpApi } from "@/pagesets/cp-api-wire";
import { type CpWaybillDetail, type CpWaybillRow } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import { ConfirmGate, useConfirmGate } from "@/components/ConfirmGate";
import { rejectReasonError, submitDecisionFlow, waybillAcceptReceipt, waybillStatusText } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/cp/waybill-accept";
const SURFACE = "supply-chain.cp" as const;

export default function CpWaybillAcceptPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useSurfaceRead(() => cpApi.waybills({ limit: 50 }), ready);
  const detail = useSurfaceRead<CpWaybillDetail>(() => cpApi.waybill(openId ?? ""), ready && !!openId, openId);

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

  const rows: CpWaybillRow[] = list.data?.data ?? [];
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
        cpApi.acceptWaybill(openId, { decision, ...(decision === "rejected" ? { rejectedNote: note.trim() } : {}) }),
      onConfirmed: (result) => setReceipt(waybillAcceptReceipt(result as { decision?: string; status?: string; note?: string })),
    });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="cp-waybill-accept-page">
        <PageHeader title="运单接收" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/cp/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && list.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && list.error ? <ErrorLine error={list.error} /> : null}
            {ready && !list.loading && !list.error && rows.length === 0 ? (
              <ErpStateLine text="暂无下发给本承运商的运单" />
            ) : null}

            {!openId ? (
              <View className="ue-list" data-testid="cp-waybill-list">
                {rows.map((w) => (
                  <View key={w.waybillId} className="ue-row-card" data-testid="cp-waybill-row" onClick={() => setOpenId(w.waybillId ?? "")}>
                    <View className="ue-row-main">
                      <Text className="ue-product-title ue-mono">{w.waybill_no ?? w.waybillId}</Text>
                      <Text className="ue-product-meta">
                        {waybillStatusText(w.status)} · 订单 {w.order_ref ?? "—"}
                      </Text>
                    </View>
                    <Text className="ue-row-action">明细</Text>
                  </View>
                ))}
              </View>
            ) : (
              <View className="ue-card" data-testid="cp-waybill-detail">
                <Text className="ue-detail-title ue-mono">{d?.waybill_no ?? openId}</Text>
                {detail.loading ? <ErpStateLine text="加载中…" /> : null}
                {detail.error ? <ErrorLine error={detail.error} /> : null}
                {d ? (
                  <>
                    <View className="ue-kv">
                      <Text className="ue-kv-key">状态</Text>
                      <Text className="ue-kv-val">{waybillStatusText(d.status)}</Text>
                    </View>
                    <View className="ue-kv">
                      <Text className="ue-kv-key">订单</Text>
                      <Text className="ue-kv-val ue-mono">{d.order_ref ?? "—"}</Text>
                    </View>
                    <View className="ue-kv">
                      <Text className="ue-kv-key">客户</Text>
                      <Text className="ue-kv-val ue-mono">{d.customer_id ?? "—"}</Text>
                    </View>
                    <Text className="ue-note-strong">货物行</Text>
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
                    {d.note ? <Text className="ue-note-line">{d.note}</Text> : null}
                    {d.logistics_adapter ? (
                      <Text className="ue-note-line">轨迹适配器：{JSON.stringify(d.logistics_adapter)}</Text>
                    ) : null}
                  </>
                ) : null}
              </View>
            )}

            {openId && d && !receipt ? (
              <View className="ue-card" data-testid="cp-waybill-decision">
                <Text className="ue-detail-title">承运决定</Text>
                <View className="ue-chip-row">
                  {([
                    ["accepted", "接受承运"],
                    ["rejected", "拒绝"],
                  ] as const).map(([v, label]) => (
                    <Text
                      key={v}
                      className={`ue-chip${decision === v ? " ue-chip-active" : ""}`}
                      data-testid={`cp-waybill-decision-${v}`}
                      onClick={() => setDecision(v)}
                    >
                      {label}
                    </Text>
                  ))}
                </View>
                {decision === "rejected" ? (
                  <Textarea
                    className="ue-textarea"
                    placeholder="拒单原因（必填）"
                    value={note}
                    onInput={(e) => setNote(e.detail.value)}
                    maxlength={200}
                  />
                ) : null}
                {localError ? (
                  <Text className="ue-error-line" data-testid="cp-waybill-form-error">
                    {localError}
                  </Text>
                ) : null}
                <ConfirmGate
                  api={gate}
                  onSubmit={submit}
                  submitLabel={decision === "accepted" ? "接受承运" : "拒绝运单"}
                  pendingLabel="提交中…"
                  className="ue-cta"
                  pendingClassName="ue-cta-disabled"
                  errorClassName="ue-error-line"
                  testId="cp-waybill-submit"
                  errorTestId="cp-waybill-gate-error"
                />
                <Text className="ue-link-btn" onClick={() => setOpenId(null)}>
                  返回列表
                </Text>
              </View>
            ) : null}

            {receipt ? (
              <View className="ue-card" data-testid="cp-waybill-receipt">
                <Text className="ue-detail-title">承运回执</Text>
                <Text className="ue-note-strong">{receipt}</Text>
                <Text className="ue-link-btn" onClick={() => Taro.redirectTo({ url: "/pages/cp/track" })}>
                  查看运单跟踪
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
