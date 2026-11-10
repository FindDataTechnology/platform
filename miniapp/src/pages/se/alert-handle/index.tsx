// SE 预警处置（P2 3.4 拍板席位页，确认门）：POST /se/alerts/{id}/handle。
// accept → 与 owner 席位同一确认门拍板生效；reject → 留痕不落账（须附原因）。
// 四段式由 ConfirmGate 承载：提交→服务器确认→拒绝原样回显→8s 超时兜底，
// 绝不乐观关闭、绝不超时假报成功。

import { useState } from "react";
import { ScrollView, Text, Textarea, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { seApi } from "@/pagesets/se-api-wire";
import { type SeAlertRow } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import { ConfirmGate, useConfirmGate } from "@/components/ConfirmGate";
import { alertReceipt, disposalStatusText, rejectReasonError, severityText, submitDecisionFlow } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/se/alert-handle";
const SURFACE = "supply-chain.se" as const;

export default function SeAlertHandlePage() {
  const router = useRouter();
  const alertId = (router.params.alertId ?? "").trim();
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null && !!alertId;

  // 列表页已带出 identity/severity 等要素；详情面以列表读回填（同源 read 面）
  const list = useSurfaceRead(() => seApi.alerts({ status: "all", limit: 100 }), ready);
  const alert: SeAlertRow | undefined = (list.data?.data ?? []).find((a) => a.alertId === alertId);

  const [decision, setDecision] = useState<"accept" | "reject">("accept");
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const gate = useConfirmGate({
    onSettled: (r) => {
      if (r.outcome === "confirmed") Taro.showToast({ title: "已提交", icon: "none" });
    },
  });
  useState(() => () => gate.dispose());

  const submit = () => {
    if (gate.isPending()) return;
    setLocalError(null);
    const err = rejectReasonError(decision === "reject" ? "rejected" : "accepted", note);
    if (err) {
      setLocalError(err);
      return;
    }
    submitDecisionFlow(gate, {
      perform: () => seApi.handleAlert(alertId, { decision, ...(note.trim() ? { note: note.trim() } : {}) }),
      onConfirmed: (result) =>
        setReceipt(
          alertReceipt(result as { status?: string; request_id?: string; handled_by?: string; note?: string }),
        ),
    });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="se-alert-handle-page">
        <PageHeader title="预警处置" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/se/alert-inbox" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && list.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && list.error ? <ErrorLine error={list.error} /> : null}
            {ready && !list.loading && !list.error && !alert ? (
              <ErpStateLine text={`处置任务不存在或已不在你的数据域：${alertId}`} tone="error" />
            ) : null}

            {alert ? (
              <View className="ue-card" data-testid="se-alert-detail">
                <Text className="ue-detail-title">{alert.title ?? alert.metric ?? "阈值预警"}</Text>
                <View className="ue-kv">
                  <Text className="ue-kv-key">级别</Text>
                  <Text className="ue-kv-val">{severityText(alert.severity)}</Text>
                </View>
                <View className="ue-kv">
                  <Text className="ue-kv-key">指标</Text>
                  <Text className="ue-kv-val">
                    {alert.metric ?? "—"} {alert.value ?? ""}（阈值 {alert.threshold ?? "—"}）
                  </Text>
                </View>
                <View className="ue-kv">
                  <Text className="ue-kv-key">指派</Text>
                  <Text className="ue-kv-val">{alert.assignee ?? "—"}</Text>
                </View>
                <View className="ue-kv">
                  <Text className="ue-kv-key">状态</Text>
                  <Text className="ue-kv-val">{disposalStatusText(alert.status)}</Text>
                </View>
                {alert.task_template ? <Text className="ue-note-line">处置任务：{alert.task_template}</Text> : null}
                {alert.note ? <Text className="ue-note-line">{alert.note}</Text> : null}
              </View>
            ) : null}

            {alert && !receipt ? (
              <View className="ue-card" data-testid="se-alert-decision">
                <Text className="ue-detail-title">拍板</Text>
                <View className="ue-chip-row">
                  {([
                    ["accept", "确认处置"],
                    ["reject", "驳回"],
                  ] as const).map(([v, label]) => (
                    <Text
                      key={v}
                      className={`ue-chip${decision === v ? " ue-chip-active" : ""}`}
                      data-testid={`se-alert-decision-${v}`}
                      onClick={() => setDecision(v)}
                    >
                      {label}
                    </Text>
                  ))}
                </View>
                <Textarea
                  className="ue-textarea"
                  placeholder={decision === "reject" ? "驳回原因（必填，留痕不落账）" : "处置说明（可选）"}
                  value={note}
                  onInput={(e) => setNote(e.detail.value)}
                  maxlength={200}
                />
                {localError ? (
                  <Text className="ue-error-line" data-testid="se-alert-form-error">
                    {localError}
                  </Text>
                ) : null}
                <ConfirmGate
                  api={gate}
                  onSubmit={submit}
                  submitLabel={decision === "accept" ? "确认处置" : "驳回"}
                  pendingLabel="提交中…"
                  className="ue-cta"
                  pendingClassName="ue-cta-disabled"
                  errorClassName="ue-error-line"
                  testId="se-alert-submit"
                  errorTestId="se-alert-gate-error"
                />
                <Text className="ue-note-line">确认处置走与 owner 席位同一确认门；驳回只留痕、不产生账务影响。</Text>
              </View>
            ) : null}

            {receipt ? (
              <View className="ue-card" data-testid="se-alert-receipt">
                <Text className="ue-detail-title">处置回执</Text>
                <Text className="ue-note-strong">{receipt}</Text>
                <Text className="ue-link-btn" onClick={() => Taro.redirectTo({ url: "/pages/se/alert-inbox" })}>
                  返回收件箱
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
