// SP 到货预告（P2 4.3）：GET /sp/arrival-notices（列表；发货反馈已自动生成）
// + POST /sp/arrival-notices（补录，确认门承载回执）。到货预告驱动入库任务。

import { useState } from "react";
import { Input, ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { spApi } from "@/pagesets/sp-api-wire";
import { type SpArrivalRow } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import { ConfirmGate, useConfirmGate } from "@/components/ConfirmGate";
import { arrivalNoticeFormError, arrivalStatusText, submitDecisionFlow } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/sp/arrival-notice";
const SURFACE = "supply-chain.sp" as const;

interface DraftLine {
  product: string;
  qty: string;
}

export default function SpArrivalNoticePage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const list = useSurfaceRead(() => spApi.arrivalNotices({ limit: 50 }), ready);
  const rows: SpArrivalRow[] = list.data?.data ?? [];

  const [poRef, setPoRef] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ product: "", qty: "1" }]);
  const [expectedDay, setExpectedDay] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const gate = useConfirmGate({
    onSettled: (r) => {
      if (r.outcome === "confirmed") Taro.showToast({ title: "到货预告已提交", icon: "none" });
    },
  });
  useState(() => () => gate.dispose());

  const submit = () => {
    if (gate.isPending()) return;
    setLocalError(null);
    const parsed = lines
      .filter((l) => l.product.trim())
      .map((l) => ({ product: l.product.trim(), qty: Number(l.qty) }));
    const err = arrivalNoticeFormError(poRef, parsed);
    if (err) {
      setLocalError(err);
      return;
    }
    submitDecisionFlow(gate, {
      perform: () =>
        spApi.createArrivalNotice({
          poRef: poRef.trim(),
          lines: parsed,
          ...(expectedDay.trim() ? { expectedDay: expectedDay.trim() } : {}),
        }),
      onConfirmed: () => {
        setReceipt("到货预告已补录：入库任务将按该预告驱动（编排面同源）。");
        list.reload();
      },
    });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="sp-arrival-notice-page">
        <PageHeader title="到货预告" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/sp/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && list.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && list.error ? <ErrorLine error={list.error} /> : null}
            {ready && !list.loading && !list.error && rows.length === 0 ? (
              <ErpStateLine text="暂无到货预告（提交发货反馈会自动生成）" />
            ) : null}

            <View className="ue-list" data-testid="sp-arrival-list">
              {rows.map((a) => (
                <View key={a.ref} className="ue-row-card" data-testid="sp-arrival-row">
                  <View className="ue-row-main">
                    <Text className="ue-product-title ue-mono">{a.po_ref ?? a.ref}</Text>
                    <Text className="ue-product-meta">
                      {arrivalStatusText(a.status)} · 预计 {a.expected_day ?? "未填"}
                    </Text>
                  </View>
                  <Text className="ue-row-action">{(a.lines ?? []).length} 行</Text>
                </View>
              ))}
            </View>

            {!receipt ? (
              <View className="ue-card" data-testid="sp-arrival-form">
                <Text className="ue-detail-title">补录到货预告</Text>
                <Input className="ue-input" placeholder="采购单号 poRef" value={poRef} onInput={(e) => setPoRef(e.detail.value)} />
                {lines.map((l, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 行集无稳定 id（本地草稿行/服务端行数组），只读渲染且顺序即身份
                  <View key={i} className="ue-form-row">
                    <Input
                      className="ue-input"
                      placeholder="商品编码"
                      value={l.product}
                      onInput={(e) => setLines((prev) => prev.map((x, idx) => (idx === i ? { ...x, product: e.detail.value } : x)))}
                    />
                    <Input
                      className="ue-input-qty"
                      type="number"
                      placeholder="数量"
                      value={l.qty}
                      onInput={(e) => setLines((prev) => prev.map((x, idx) => (idx === i ? { ...x, qty: e.detail.value } : x)))}
                    />
                  </View>
                ))}
                <Text className="ue-link-btn" onClick={() => setLines((prev) => [...prev, { product: "", qty: "1" }])}>
                  + 添加一行
                </Text>
                <Input
                  className="ue-input"
                  placeholder="预计到货日 YYYY-MM-DD（可选）"
                  value={expectedDay}
                  onInput={(e) => setExpectedDay(e.detail.value)}
                />
                {localError ? (
                  <Text className="ue-error-line" data-testid="sp-arrival-form-error">
                    {localError}
                  </Text>
                ) : null}
                <ConfirmGate
                  api={gate}
                  onSubmit={submit}
                  submitLabel="提交到货预告"
                  pendingLabel="提交中…"
                  className="ue-cta"
                  pendingClassName="ue-cta-disabled"
                  errorClassName="ue-error-line"
                  testId="sp-arrival-submit"
                  errorTestId="sp-arrival-gate-error"
                />
              </View>
            ) : (
              <View className="ue-card" data-testid="sp-arrival-receipt">
                <Text className="ue-detail-title">已提交</Text>
                <Text className="ue-note-strong">{receipt}</Text>
                <Text className="ue-link-btn" onClick={() => setReceipt(null)}>
                  继续补录
                </Text>
              </View>
            )}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
