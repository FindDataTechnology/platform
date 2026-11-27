// CP 签收上报（P3 5.5 确认门页，契约 §5）：POST /cp/waybills/{id}/pod。
// 正常签收驱动运单结单与计费事件（计费规则引擎同源，本端零落账）；
// 异常签收进处置车道（服务端派单留痕，回执带 disposal_request_id）。
// 回执如实：签收不等于结单 —— 结单/计费由计费引擎事件驱动（服务器 note 原样）。

import { useState } from "react";
import { Input, ScrollView, Text, Textarea, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { cpApi } from "@/pagesets/cp-api-wire";
import { type CpPodResult } from "@/pagesets/surface-api";
import { IdentityMissing, useSurfaceIdentity } from "@/pagesets/surface-gate";
import { ConfirmGate, useConfirmGate } from "@/components/ConfirmGate";
import { podFormError, podReceipt, submitDecisionFlow } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/cp/pod-report";
const SURFACE = "supply-chain.cp" as const;

export default function CpPodReportPage() {
  const router = useRouter();
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;

  const [waybillId, setWaybillId] = useState((router.params.waybillId ?? "").trim());
  const [documents, setDocuments] = useState("");
  const [exceptionNote, setExceptionNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CpPodResult | null>(null);

  const gate = useConfirmGate({
    onSettled: (r) => {
      if (r.outcome === "confirmed") Taro.showToast({ title: "签收已上报", icon: "none" });
    },
  });
  useState(() => () => gate.dispose());

  const submit = () => {
    if (gate.isPending()) return;
    setLocalError(null);
    if (!waybillId.trim()) {
      setLocalError("请填写运单号");
      return;
    }
    const docs = documents
      .split(/[\s,，]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const err = podFormError(docs, exceptionNote);
    if (err) {
      setLocalError(err);
      return;
    }
    submitDecisionFlow(gate, {
      perform: () =>
        cpApi.reportPod(waybillId.trim(), {
          documents: docs,
          ...(exceptionNote.trim() ? { exceptionNote: exceptionNote.trim() } : {}),
        }),
      onConfirmed: (result) => setReceipt(result as CpPodResult),
    });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="cp-pod-report-page">
        <PageHeader title="签收上报" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/cp/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}

            {ready && receipt ? (
              <View className="ue-card" data-testid="cp-pod-receipt">
                <Text className="ue-detail-title">签收回执</Text>
                <Text className="ue-note-strong">{podReceipt(receipt)}</Text>
                {receipt.exception ? (
                  <Text className="ue-note-line">
                    {`异常签收已进处置车道：处置单 ${receipt.disposal_request_id ?? "—"}（状态 ${receipt.disposal_status ?? "pending"}），请配合核对异常说明。`}
                  </Text>
                ) : null}
                <Text className="ue-link-btn" onClick={() => Taro.redirectTo({ url: "/pages/cp/track" })}>
                  查看运单跟踪
                </Text>
              </View>
            ) : (
              ready && (
                <View className="ue-card" data-testid="cp-pod-form">
                  <Text className="ue-detail-title">签收信息</Text>
                  <Input className="ue-input" placeholder="运单号 / waybillId" value={waybillId} onInput={(e) => setWaybillId(e.detail.value)} />
                  <Input
                    className="ue-input"
                    placeholder="签收凭证影像引用（逗号分隔）"
                    value={documents}
                    onInput={(e) => setDocuments(e.detail.value)}
                  />
                  <Textarea
                    className="ue-textarea"
                    placeholder="异常说明（有异常时必填：进处置车道）"
                    value={exceptionNote}
                    onInput={(e) => setExceptionNote(e.detail.value)}
                    maxlength={200}
                  />
                  {localError ? (
                    <Text className="ue-error-line" data-testid="cp-pod-form-error">
                      {localError}
                    </Text>
                  ) : null}
                  <ConfirmGate
                    api={gate}
                    onSubmit={submit}
                    submitLabel="提交签收"
                    pendingLabel="提交中…"
                    className="ue-cta"
                    pendingClassName="ue-cta-disabled"
                    errorClassName="ue-error-line"
                    testId="cp-pod-submit"
                    errorTestId="cp-pod-gate-error"
                  />
                  <Text className="ue-note-line">
                    签收触发收入确认走内核 proposal 车道；运单结单与运费计费由计费规则引擎事件驱动（承运端不落结单态）。
                  </Text>
                </View>
              )
            )}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
