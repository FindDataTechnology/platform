// CP 提货打卡（P3 5.4，契约 §4）：POST /cp/waybills/{id}/pickup-checkin。
// 扫码提货复用底座 bind-scan 同一扫码实现（解析目标改为作业码）；
// 定位/影像为可选采集 —— 默认不采集，勾选才填，并在页面上如实标注
// 「须隐私声明过审后启用」。回执驱动在途状态。

import { useState } from "react";
import { Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { cpApi } from "@/pagesets/cp-api-wire";
import { IdentityMissing, useSurfaceIdentity } from "@/pagesets/surface-gate";
import { ConfirmGate, useConfirmGate } from "@/components/ConfirmGate";
import { submitDecisionFlow } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/cp/pickup-checkin";
const SURFACE = "supply-chain.cp" as const;

export default function CpPickupCheckinPage() {
  const router = useRouter();
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;

  const [waybillId, setWaybillId] = useState((router.params.waybillId ?? "").trim());
  const [scanCode, setScanCode] = useState("");
  const [imageRefs, setImageRefs] = useState("");
  const [withLocation, setWithLocation] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const gate = useConfirmGate({
    onSettled: (r) => {
      if (r.outcome === "confirmed") Taro.showToast({ title: "打卡已提交", icon: "none" });
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
    if (!scanCode.trim() && imageRefs.trim() === "" ) {
      setLocalError("请扫码或填入凭证影像引用（至少一项，用于证明提货发生）");
      return;
    }
    submitDecisionFlow(gate, {
      perform: () =>
        cpApi.pickupCheckin(waybillId.trim(), {
          ...(scanCode.trim() ? { scanCode: scanCode.trim() } : {}),
          ...(imageRefs.trim()
            ? {
                imageRefs: imageRefs
                  .split(/[\s,，]+/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : {}),
        }),
      onConfirmed: () => setReceipt("提货打卡已受理：回执驱动在途状态（交付编排运单同一事件档）。"),
    });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="cp-pickup-checkin-page">
        <PageHeader title="提货打卡" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/cp/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}

            {ready && receipt ? (
              <View className="ue-card" data-testid="cp-pickup-receipt">
                <Text className="ue-detail-title">打卡回执</Text>
                <Text className="ue-note-strong">{receipt}</Text>
                <Text className="ue-link-btn" onClick={() => Taro.redirectTo({ url: "/pages/cp/track" })}>
                  查看运单跟踪
                </Text>
              </View>
            ) : null}

            {ready && !receipt ? (
              <>
                <View className="ue-card" data-testid="cp-pickup-form">
                  <Text className="ue-detail-title">提货信息</Text>
                  <Input className="ue-input" placeholder="运单号 / waybillId" value={waybillId} onInput={(e) => setWaybillId(e.detail.value)} />
                  <Input className="ue-input" placeholder="作业码（扫码结果）" value={scanCode} onInput={(e) => setScanCode(e.detail.value)} />
                  <Text className="ue-link-btn" onClick={() => Taro.scanCode({ success: (r) => setScanCode(r.result) })}>
                    扫作业码
                  </Text>
                  <Input
                    className="ue-input"
                    placeholder="凭证影像引用（逗号分隔，可选）"
                    value={imageRefs}
                    onInput={(e) => setImageRefs(e.detail.value)}
                  />
                  {localError ? (
                    <Text className="ue-error-line" data-testid="cp-pickup-form-error">
                      {localError}
                    </Text>
                  ) : null}
                  <ConfirmGate
                    api={gate}
                    onSubmit={submit}
                    submitLabel="提交打卡"
                    pendingLabel="提交中…"
                    className="ue-cta"
                    pendingClassName="ue-cta-disabled"
                    errorClassName="ue-error-line"
                    testId="cp-pickup-submit"
                    errorTestId="cp-pickup-gate-error"
                  />
                </View>

                <View className="ue-card" data-testid="cp-pickup-privacy">
                  <Text className="ue-detail-title">采集与隐私</Text>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">位置采集</Text>
                    <Text className="ue-kv-val" onClick={() => setWithLocation((v) => !v)}>
                      {withLocation ? "已选（未启用）" : "不采集"}
                    </Text>
                  </View>
                  <Text className="ue-note-line">
                    定位为可选采集项，须隐私声明过审后启用；当前未接入定位上报，本页不主动采集位置（采集范围沿底座隐私纪律）。
                  </Text>
                  <Text className="ue-note-line">影像同样为可选：本页只接受已上传件的引用，不直接读取相册/相机。</Text>
                </View>
              </>
            ) : null}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
