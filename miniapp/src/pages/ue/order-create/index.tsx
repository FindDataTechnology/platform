// UE 订单确认（P1 2.2 确认门页，api-contract §2 POST /ue/orders）：
// 行集取自进货单（服务器 cart 面，源真唯一）；提交经信用校验
// （账本额度占用记账），额度不足 fail-closed 拒绝并附占用明细（可解释）。
// 四段式确认门（提交→服务器确认→拒绝回显→8s 超时兜底）由 ConfirmGate
// 组件承载：表单保持打开、字段保留，绝不乐观关闭、超时不假报成功。
// 受理回执如实：status=pending（订单进确认车道），不是已完成。

import { useEffect, useState } from "react";
import { Input, ScrollView, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { ueApi } from "@/pagesets/ue-api-wire";
import { type CartLine, type OrderAcceptance, type PricePreview } from "@/pagesets/erp-api";
import { ErpStateLine } from "@/pagesets/ue-states";
import { ConfirmGate, useConfirmGate, useConfirmGateSnapshot } from "@/components/ConfirmGate";
import { fmtAmount, orderFormError, orderPayload, submitOrderFlow } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/ue/order-create";

export default function UeOrderCreatePage() {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [preview, setPreview] = useState<PricePreview | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<OrderAcceptance | null>(null);

  // 确认门：受理确认 → 收据视图；拒绝（含信用占用明细）原样回显；8s 兜底。
  const gate = useConfirmGate({
    onSettled: (r) => {
      if (r.outcome !== "confirmed") return;
      Taro.showToast({ title: "订单已受理，待确认", icon: "none" });
    },
  });
  const gatePending = useConfirmGateSnapshot(gate).pending;

  useEffect(() => () => gate.dispose(), [gate]);

  useEffect(() => {
    ueApi
      .cart()
      .then((cart) => {
        setLines(cart.lines ?? []);
        setState({ loading: false, error: null });
      })
      .catch((e: Error) => setState({ loading: false, error: e.message || "读取失败" }));
  }, []);

  // 行集就绪后取一次正式试算（服务器按当前客户取价，非行快照）。
  useEffect(() => {
    if (lines.length === 0) return;
    ueApi
      .pricePreview({ lines: lines.map((l) => ({ productId: l.product ?? "", qty: l.qty ?? 0, unit: l.unit || undefined })) })
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [lines]);

  const submit = () => {
    if (gate.isPending()) return;
    setLocalError(null);
    const formError = orderFormError(lines, { contact, phone, address });
    if (formError) {
      setLocalError(formError);
      return;
    }
    submitOrderFlow(gate, {
      createOrder: (body) => ueApi.createOrder(body),
      body: orderPayload(lines, { contact, phone, address }, note),
      onConfirmed: (result) => setReceipt(result as OrderAcceptance),
    });
  };

  const credit = preview?.credit_preview;

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="ue-order-create-page">
        <PageHeader title="订单确认" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/ue/cart" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {state.loading ? <ErpStateLine text="加载中…" /> : null}
            {state.error ? <ErpStateLine text={state.error} tone="error" /> : null}

            {receipt ? (
              <View className="ue-card" data-testid="ue-order-receipt">
                <Text className="ue-detail-title">订单已受理</Text>
                <View className="ue-kv">
                  <Text className="ue-kv-key">订单号</Text>
                  <Text className="ue-kv-val ue-mono">{receipt.order_ref ?? "—"}</Text>
                </View>
                <View className="ue-kv">
                  <Text className="ue-kv-key">状态</Text>
                  <Text className="ue-kv-val">{receipt.status === "pending" ? "待确认（订单进确认车道）" : (receipt.status ?? "")}</Text>
                </View>
                <View className="ue-kv">
                  <Text className="ue-kv-key">金额</Text>
                  <Text className="ue-kv-val">
                    ¥{fmtAmount(receipt.amount_total)} {receipt.currency ?? ""}
                  </Text>
                </View>
                {receipt.credit_reservation ? (
                  <View className="ue-kv">
                    <Text className="ue-kv-key">信用占用</Text>
                    <Text className="ue-kv-val">
                      {fmtAmount(receipt.credit_reservation.amount)}（内核 reserve_credit 记账）
                    </Text>
                  </View>
                ) : null}
                <Text className="ue-note-line">订单进入确认车道；确认通过后移交履约。可在「我的订单」跟进。</Text>
                <Text
                  className="ue-cta"
                  data-testid="ue-order-receipt-goto"
                  onClick={() => Taro.redirectTo({ url: "/pages/ue/order-list" })}
                >
                  查看我的订单
                </Text>
              </View>
            ) : (
              <>
                <View className="ue-card">
                  <Text className="ue-detail-title">商品行</Text>
                  {lines.length === 0 && !state.loading ? <ErpStateLine text="进货单为空" /> : null}
                  {lines.map((l) => (
                    <View key={l.line_id} className="ue-kv">
                      <Text className="ue-kv-key">
                        {l.title ?? l.product}
                        {l.unit ? `（${l.unit}）` : ""}
                      </Text>
                      <Text className="ue-kv-val">× {String(l.qty ?? "")}</Text>
                    </View>
                  ))}
                  {preview ? (
                    <View className="ue-kv" data-testid="ue-order-preview">
                      <Text className="ue-kv-key">试算合计</Text>
                      <Text className="ue-kv-val">
                        ¥{fmtAmount(preview.amount_total)} {preview.currency ?? ""}
                      </Text>
                    </View>
                  ) : null}
                  {credit && !credit.sufficient ? (
                    <Text className="ue-error-line" data-testid="ue-order-credit-warn">
                      信用预估不足：可用 {fmtAmount(credit.available)}，本单 {fmtAmount(credit.requested)}
                    </Text>
                  ) : null}
                  {credit ? <Text className="ue-note-line">试算为纯读预览；实际占用在下单经信用校验记账。</Text> : null}
                </View>

                <View className="ue-card" data-testid="ue-order-form">
                  <Text className="ue-detail-title">收货信息</Text>
                  <Input className="ue-input" placeholder="联系人" value={contact} onInput={(e) => setContact(e.detail.value)} />
                  <Input className="ue-input" placeholder="联系电话" type="number" value={phone} onInput={(e) => setPhone(e.detail.value)} />
                  <Input className="ue-input" placeholder="收货地址" value={address} onInput={(e) => setAddress(e.detail.value)} />
                  <Textarea className="ue-textarea" placeholder="备注（可选）" value={note} onInput={(e) => setNote(e.detail.value)} maxlength={200} />
                  <ConfirmGate
                    api={gate}
                    onSubmit={submit}
                    submitLabel="提交订单"
                    pendingLabel="下单中…"
                    error={localError}
                    className="ue-cta"
                    pendingClassName="ue-cta-disabled"
                    errorClassName="ue-error-line"
                    testId="ue-order-submit"
                    errorTestId="ue-order-error"
                  />
                  <Text className="ue-note-line">提交后订单进入确认车道；信用额度不足将被拒绝并附占用明细。</Text>
                </View>
              </>
            )}
            {gatePending && !receipt ? <Text className="ue-note-line">等待服务器确认…</Text> : null}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
