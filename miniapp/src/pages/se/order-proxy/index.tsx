// SE 代客下单（P2 3.3 确认门页，契约 §3 POST /se/orders/proxy）。
// 与 UE 下单同一取价/信用链路（账本额度占用记账），业务员身份三处留痕；
// 额度不足 fail-closed 可解释拒绝；客户越权 403 DATA_SCOPE_DENIED 原样回显。
// 四段式确认门由 ConfirmGate 承载：表单不关、字段保留、8s 超时不假报成功。
// 客户来源：深链 customerId（客户 360/列表跳入）或手填客户编码。

import { useState } from "react";
import { Input, ScrollView, Text, Textarea, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { seApi } from "@/pagesets/se-api-wire";
import { type ProxyOrderResult } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity } from "@/pagesets/surface-gate";
import { ConfirmGate, useConfirmGate } from "@/components/ConfirmGate";
import { proxyOrderFormError, proxyOrderReceipt, submitDecisionFlow } from "@/pagesets/surface-view";
import { fmtAmount } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/se/order-proxy";
const SURFACE = "supply-chain.se" as const;

interface DraftLine {
  productId: string;
  qty: string;
}

export default function SeOrderProxyPage() {
  const router = useRouter();
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;

  const [customerId, setCustomerId] = useState((router.params.customerId ?? "").trim());
  const [lines, setLines] = useState<DraftLine[]>([{ productId: "", qty: "1" }]);
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ProxyOrderResult | null>(null);

  const gate = useConfirmGate({
    onSettled: (r) => {
      if (r.outcome === "confirmed") Taro.showToast({ title: "订单已受理，待确认", icon: "none" });
    },
  });
  // 卸载时清计时器（确认门不持有第二通道，超时兜底归机器）
  useState(() => () => gate.dispose());

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, { productId: "", qty: "1" }]);
  const removeLine = (i: number) => setLines((prev) => prev.filter((_, idx) => idx !== i));

  const submit = () => {
    if (gate.isPending()) return;
    setLocalError(null);
    const parsed = lines
      .filter((l) => l.productId.trim())
      .map((l) => ({ productId: l.productId.trim(), qty: Number(l.qty) }));
    const formError = proxyOrderFormError(customerId, parsed, { contact, phone, address });
    if (formError) {
      setLocalError(formError);
      return;
    }
    submitDecisionFlow(gate, {
      perform: () =>
        seApi.proxyOrder({
          customerId: customerId.trim(),
          lines: parsed,
          shipping: { contact, phone, address },
          note,
        }),
      onConfirmed: (result) => setReceipt(result as ProxyOrderResult),
    });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="se-order-proxy-page">
        <PageHeader title="代客下单" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/se/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}

            {ready && receipt ? (
              <View className="ue-card" data-testid="se-proxy-receipt">
                <Text className="ue-detail-title">代客下单已受理</Text>
                <Text className="ue-note-strong">{proxyOrderReceipt(receipt)}</Text>
                <View className="ue-kv">
                  <Text className="ue-kv-key">金额</Text>
                  <Text className="ue-kv-val">
                    {fmtAmount(receipt.amount_total)} {receipt.currency ?? ""}
                  </Text>
                </View>
                {receipt.proxy?.requested_by ? (
                  <View className="ue-kv">
                    <Text className="ue-kv-key">代理身份</Text>
                    <Text className="ue-kv-val ue-mono">{receipt.proxy.requested_by}</Text>
                  </View>
                ) : null}
                {receipt.proxy?.note ? <Text className="ue-note-line">{receipt.proxy.note}</Text> : null}
                <Text
                  className="ue-cta"
                  onClick={() => Taro.redirectTo({ url: `/pages/se/order-track?customerId=${encodeURIComponent(customerId)}` })}
                >
                  查看名下订单
                </Text>
              </View>
            ) : null}

            {ready && !receipt ? (
              <>
                <View className="ue-card" data-testid="se-proxy-customer">
                  <Text className="ue-detail-title">客户</Text>
                  <Input
                    className="ue-input"
                    placeholder="客户 id / 编码（须为本人名下客户）"
                    value={customerId}
                    onInput={(e) => setCustomerId(e.detail.value)}
                  />
                  <Text className="ue-note-line">「代客」不改变数据域：非本人名下客户将被服务端拒绝（DATA_SCOPE_DENIED）。</Text>
                </View>

                <View className="ue-card" data-testid="se-proxy-lines">
                  <Text className="ue-detail-title">商品行</Text>
                  {lines.map((l, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 行集无稳定 id（本地草稿行/服务端行数组），只读渲染且顺序即身份
                    <View key={i} className="ue-form-row">
                      <Input
                        className="ue-input"
                        placeholder="商品编码"
                        value={l.productId}
                        onInput={(e) => setLine(i, { productId: e.detail.value })}
                      />
                      <Input
                        className="ue-input-qty"
                        type="number"
                        placeholder="数量"
                        value={l.qty}
                        onInput={(e) => setLine(i, { qty: e.detail.value })}
                      />
                      <Text className="ue-link-btn" onClick={() => removeLine(i)}>
                        删除
                      </Text>
                    </View>
                  ))}
                  <Text className="ue-link-btn" onClick={addLine}>
                    + 添加一行
                  </Text>
                </View>

                <View className="ue-card" data-testid="se-proxy-shipping">
                  <Text className="ue-detail-title">收货信息</Text>
                  <Input className="ue-input" placeholder="联系人" value={contact} onInput={(e) => setContact(e.detail.value)} />
                  <Input className="ue-input" placeholder="联系电话" type="number" value={phone} onInput={(e) => setPhone(e.detail.value)} />
                  <Input className="ue-input" placeholder="收货地址" value={address} onInput={(e) => setAddress(e.detail.value)} />
                  <Textarea className="ue-textarea" placeholder="备注（可选）" value={note} onInput={(e) => setNote(e.detail.value)} maxlength={200} />
                  {localError ? (
                    <Text className="ue-error-line" data-testid="se-proxy-form-error">
                      {localError}
                    </Text>
                  ) : null}
                  <ConfirmGate
                    api={gate}
                    onSubmit={submit}
                    submitLabel="提交代客订单"
                    pendingLabel="下单中…"
                    className="ue-cta"
                    pendingClassName="ue-cta-disabled"
                    errorClassName="ue-error-line"
                    testId="se-proxy-submit"
                    errorTestId="se-proxy-error"
                  />
                  <Text className="ue-note-line">与客户端下单同一取价与信用校验链路；额度不足将被拒绝并附占用明细。</Text>
                </View>
              </>
            ) : null}

            {ready && localError && !receipt ? <ErrorLine error={{ message: localError }} /> : null}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
