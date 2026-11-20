// SE 开票审核（add-se-invoice-audit-queue）：GET /se/invoice-requests +
// POST /se/invoice-requests/{id}/decide。
//
// 与预警处置同形：列表只读、拍板走 ConfirmGate（提交→服务器确认→失败原样回显），
// 绝不乐观关闭、绝不超时假报成功。审核只经内核确认门 decide_event——本页不存状态。
//
// 边界：只审本人名下客户的申请；票据本体不在本页（仍走客户既有开票渠道）。

import { useState } from "react";
import { ScrollView, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { seApi } from "@/pagesets/se-api-wire";
import { type SeInvoiceRow } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine, CapabilityUnavailable } from "@/pagesets/ue-states";
import { ConfirmGate, useConfirmGate } from "@/components/ConfirmGate";
import { rejectReasonError, submitDecisionFlow } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/se/invoice-audit";
const SURFACE = "supply-chain.se" as const;

const STATUS_TEXT: Record<string, string> = {
  pending: "待审核",
  accepted: "已接受",
  rejected: "已驳回",
};

export default function SeInvoiceAuditPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const [status, setStatus] = useState<"pending" | "all">("pending");
  const [tick, setTick] = useState(0);
  const read = useSurfaceRead(() => seApi.invoiceAuditList({ status, limit: 50 }), ready, `${status}:${tick}`);
  const rows: SeInvoiceRow[] = read.data?.data ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<"accepted" | "rejected">("accepted");
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const gate = useConfirmGate({
    onSettled: (r) => {
      if (r.outcome === "confirmed") {
        setTick((n) => n + 1); // 拍板成功后重新拉一次投影（状态来自内核，不本地改）
      }
    },
  });
  // 页面卸载时丢掉确认门的 8s 计时器（与 alert-handle 同一纪律）
  useState(() => () => gate.dispose());

  const reset = () => {
    setSelectedId(null);
    setDecision("accepted");
    setNote("");
    setLocalError(null);
  };

  const submit = (requestId: string) => {
    if (gate.isPending()) return;
    setLocalError(null);
    // 驳回必须给原因：客户端先拦一次，服务端还会再拦（不靠单侧守卫）
    const err = rejectReasonError(decision === "rejected" ? "rejected" : "accepted", note);
    if (err) {
      setLocalError(err);
      return;
    }
    submitDecisionFlow(gate, {
      perform: () =>
        seApi.invoiceDecide(requestId, {
          decision,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      onConfirmed: (result) => {
        const r = result as { requestId?: string; status?: string; decided_at?: string };
        setReceipt(
          `${r.requestId ?? requestId} → ${STATUS_TEXT[r.status ?? ""] ?? r.status ?? "已拍板"}` +
            (r.decided_at ? `（${r.decided_at}）` : ""),
        );
        reset();
      },
    });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="se-invoice-audit-page">
        <PageHeader
          title="开票审核"
          onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/se/home" }) })}
        />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}

            {ready ? (
              <View className="ue-chip-row">
                {([
                  ["pending", "待审核"],
                  ["all", "全部"],
                ] as const).map(([v, label]) => (
                  <Text
                    key={v}
                    className={`ue-chip${status === v ? " ue-chip-active" : ""}`}
                    data-testid={`se-invoice-status-${v}`}
                    onClick={() => {
                      setStatus(v);
                      reset();
                    }}
                  >
                    {label}
                  </Text>
                ))}
              </View>
            ) : null}

            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}
            {/* 501 是「能力未提供」，绝不当成「没有待审」——否则内核不可达时会静默显示空队列 */}
            {ready && read.notImplemented ? <CapabilityUnavailable message={read.notImplementedMessage} /> : null}
            {ready && !read.loading && !read.error && !read.notImplemented && rows.length === 0 ? (
              <ErpStateLine text={status === "pending" ? "没有待审核的开票申请" : "没有开票申请"} />
            ) : null}

            {receipt ? (
              <View className="ue-card" data-testid="se-invoice-receipt">
                <Text className="ue-detail-title">审核回执</Text>
                <Text className="ue-note-strong">{receipt}</Text>
              </View>
            ) : null}

            <View className="ue-list" data-testid="se-invoice-list">
              {rows.map((r) => {
                const id = r.requestId ?? "";
                const open = selectedId === id;
                return (
                  <View key={id} data-testid="se-invoice-row">
                    <View className="ue-row-card" onClick={() => setSelectedId(open ? null : id)}>
                      <View className="ue-row-main">
                        <Text className="ue-product-title">{r.title ?? id}</Text>
                        <Text className="ue-product-meta">
                          {STATUS_TEXT[r.status ?? ""] ?? r.status ?? "—"}
                          {r.taxId ? ` · 税号 ${r.taxId}` : ""}
                        </Text>
                        <Text className="ue-product-meta">
                          {r.orderId ? `订单 ${r.orderId}` : ""}
                          {r.statementId ? ` 对账单 ${r.statementId}` : ""}
                          {!r.orderId && !r.statementId ? "（无单据引用）" : ""}
                        </Text>
                        <Text className="ue-product-meta">提交 {r.submitted_at ?? "—"}</Text>
                      </View>
                      <Text className="ue-row-action">{open ? "收起" : r.status === "pending" ? "审核 ›" : "详情 ›"}</Text>
                    </View>

                    {open ? (
                      <View className="ue-card" data-testid="se-invoice-decision">
                        {r.status !== "pending" ? (
                          <Text className="ue-note-line">
                            已拍板：{STATUS_TEXT[r.status ?? ""] ?? r.status}
                            {r.decided_at ? `（${r.decided_at}）` : ""}
                          </Text>
                        ) : (
                          <>
                            <View className="ue-chip-row">
                              {([
                                ["accepted", "接受"],
                                ["rejected", "驳回"],
                              ] as const).map(([v, label]) => (
                                <Text
                                  key={v}
                                  className={`ue-chip${decision === v ? " ue-chip-active" : ""}`}
                                  data-testid={`se-invoice-decision-${v}`}
                                  onClick={() => setDecision(v)}
                                >
                                  {label}
                                </Text>
                              ))}
                            </View>
                            <Textarea
                              className="ue-textarea"
                              placeholder={
                                decision === "rejected"
                                  ? "驳回原因（必填：抬头/税号/单据引用哪里对不上）"
                                  : "审核说明（可选）"
                              }
                              value={note}
                              onInput={(e) => setNote(e.detail.value)}
                              maxlength={200}
                            />
                            {localError ? (
                              <Text className="ue-error-line" data-testid="se-invoice-form-error">
                                {localError}
                              </Text>
                            ) : null}
                            <ConfirmGate
                              api={gate}
                              onSubmit={() => submit(id)}
                              submitLabel={decision === "accepted" ? "接受" : "驳回"}
                              pendingLabel="提交中…"
                              className="ue-cta"
                              pendingClassName="ue-cta-disabled"
                              errorClassName="ue-error-line"
                              testId="se-invoice-submit"
                              errorTestId="se-invoice-gate-error"
                            />
                            <Text className="ue-note-line">
                              审核走内核确认门；状态以服务端为准，本页不本地改写。票据本体仍由客户既有开票渠道出具。
                            </Text>
                          </>
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
