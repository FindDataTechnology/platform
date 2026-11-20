// SP 发货反馈（P2 4.3 确认门页，契约 §3）：POST
// /sp/purchase-orders/{poId}/delivery-feedback —— 行级发货明细 + 物流商/单号
// + 凭证影像引用。回执与入库任务联动（编排面同源），并自动生成到货预告。
// 凭证影像只存引用（中台文件服务上传契约另行接入，本页如实说明）。

import { useState } from "react";
import { Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { spApi } from "@/pagesets/sp-api-wire";
import { IdentityMissing, useSurfaceIdentity } from "@/pagesets/surface-gate";
import { ConfirmGate, useConfirmGate } from "@/components/ConfirmGate";
import { deliveryFeedbackFormError, submitDecisionFlow } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/sp/delivery-feedback";
const SURFACE = "supply-chain.sp" as const;

interface DraftLine {
  product: string;
  qty: string;
}

export default function SpDeliveryFeedbackPage() {
  const router = useRouter();
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;

  const [poId, setPoId] = useState((router.params.poId ?? "").trim());
  const [lines, setLines] = useState<DraftLine[]>([{ product: "", qty: "1" }]);
  const [carrier, setCarrier] = useState("");
  const [waybillNo, setWaybillNo] = useState("");
  const [expectedDay, setExpectedDay] = useState("");
  const [documents, setDocuments] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const gate = useConfirmGate({
    onSettled: (r) => {
      if (r.outcome === "confirmed") Taro.showToast({ title: "发货反馈已提交", icon: "none" });
    },
  });
  useState(() => () => gate.dispose());

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = () => {
    if (gate.isPending()) return;
    setLocalError(null);
    const parsed = lines
      .filter((l) => l.product.trim())
      .map((l) => ({ product: l.product.trim(), qty: Number(l.qty) }));
    const err = deliveryFeedbackFormError(parsed, carrier, waybillNo);
    if (err) {
      setLocalError(err);
      return;
    }
    submitDecisionFlow(gate, {
      perform: () =>
        spApi.deliveryFeedback(poId.trim(), {
          lines: parsed,
          carrier: carrier.trim(),
          waybillNo: waybillNo.trim(),
          documents: documents
            .split(/[\s,，]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          ...(expectedDay.trim() ? { expectedDay: expectedDay.trim() } : {}),
        }),
      onConfirmed: () => setReceipt("发货反馈已受理：已写入采购单同一状态机，并自动生成到货预告（入库任务随之联动）。"),
    });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="sp-delivery-feedback-page">
        <PageHeader
          title="发货反馈"
          onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/sp/order-accept" }) })}
        />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}

            {ready && receipt ? (
              <View className="ue-card" data-testid="sp-df-receipt">
                <Text className="ue-detail-title">已提交</Text>
                <Text className="ue-note-strong">{receipt}</Text>
                <Text className="ue-link-btn" onClick={() => Taro.redirectTo({ url: "/pages/sp/arrival-notice" })}>
                  查看到货预告
                </Text>
              </View>
            ) : null}

            {ready && !receipt ? (
              <>
                <View className="ue-card">
                  <Text className="ue-detail-title">采购单</Text>
                  <Input
                    className="ue-input"
                    placeholder="采购单号 poId（已推送给我方）"
                    value={poId}
                    onInput={(e) => setPoId(e.detail.value)}
                  />
                </View>

                <View className="ue-card" data-testid="sp-df-lines">
                  <Text className="ue-detail-title">发货明细</Text>
                  {lines.map((l, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 行集无稳定 id（本地草稿行/服务端行数组），只读渲染且顺序即身份
                    <View key={i} className="ue-form-row">
                      <Input
                        className="ue-input"
                        placeholder="商品编码"
                        value={l.product}
                        onInput={(e) => setLine(i, { product: e.detail.value })}
                      />
                      <Input
                        className="ue-input-qty"
                        type="number"
                        placeholder="数量"
                        value={l.qty}
                        onInput={(e) => setLine(i, { qty: e.detail.value })}
                      />
                    </View>
                  ))}
                  <Text className="ue-link-btn" onClick={() => setLines((prev) => [...prev, { product: "", qty: "1" }])}>
                    + 添加一行
                  </Text>
                </View>

                <View className="ue-card" data-testid="sp-df-logistics">
                  <Text className="ue-detail-title">物流信息</Text>
                  <Input className="ue-input" placeholder="物流商" value={carrier} onInput={(e) => setCarrier(e.detail.value)} />
                  <Input className="ue-input" placeholder="运单号" value={waybillNo} onInput={(e) => setWaybillNo(e.detail.value)} />
                  <Input
                    className="ue-input"
                    placeholder="预计到货日 YYYY-MM-DD（可选）"
                    value={expectedDay}
                    onInput={(e) => setExpectedDay(e.detail.value)}
                  />
                  <Input
                    className="ue-input"
                    placeholder="凭证影像引用（逗号分隔，可选）"
                    value={documents}
                    onInput={(e) => setDocuments(e.detail.value)}
                  />
                  <Text className="ue-note-line">
                    凭证影像仅存引用：中台文件服务上传契约尚未接入（后端如实挂账），请粘贴已上传件的引用 id。
                  </Text>
                </View>

                {localError ? (
                  <Text className="ue-error-line" data-testid="sp-df-form-error">
                    {localError}
                  </Text>
                ) : null}
                <ConfirmGate
                  api={gate}
                  onSubmit={submit}
                  submitLabel="提交发货反馈"
                  pendingLabel="提交中…"
                  className="ue-cta"
                  pendingClassName="ue-cta-disabled"
                  errorClassName="ue-error-line"
                  testId="sp-df-submit"
                  errorTestId="sp-df-gate-error"
                />
              </>
            ) : null}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
