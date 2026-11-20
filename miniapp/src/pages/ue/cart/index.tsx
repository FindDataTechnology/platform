// UE 进货单（P1 2.1，api-contract §2 cart 面）：行集 + 删行 + 取价试算
// （POST /ue/cart/price-preview —— 纯读，不占用信用额度；试算结果含信用
// 预估占用，额度不足在试算面就如实亮出，下单页的确认门再正式把关）。

import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { ueApi } from "@/pagesets/ue-api-wire";
import { type CartLine, type PricePreview } from "@/pagesets/erp-api";
import { ErpStateLine } from "@/pagesets/ue-states";
import { cartTotals, fmtAmount } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/ue/cart";

export default function UeCartPage() {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [preview, setPreview] = useState<PricePreview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);

  const load = () => {
    setState({ loading: true, error: null });
    ueApi
      .cart()
      .then((c) => {
        setLines(c.lines ?? []);
        setPreview(null);
        setState({ loading: false, error: null });
      })
      .catch((e: Error) => setState({ loading: false, error: e.message || "读取失败" }));
  };

  useEffect(load, []);

  const removeLine = (lineId?: string) => {
    if (!lineId) return;
    ueApi
      .removeCartLine(lineId)
      .then((c) => {
        setLines(c.lines ?? []);
        setPreview(null);
      })
      .catch((e: Error) => Taro.showToast({ title: e.message || "删除失败", icon: "none" }));
  };

  const runPreview = () => {
    if (previewPending || lines.length === 0) return;
    setPreviewPending(true);
    ueApi
      .pricePreview({
        lines: lines.map((l) => ({ productId: l.product ?? "", qty: l.qty ?? 0, unit: l.unit || undefined })),
      })
      .then((p) => {
        setPreview(p);
        setPreviewPending(false);
      })
      .catch((e: Error) => {
        setPreviewPending(false);
        Taro.showToast({ title: e.message || "试算失败", icon: "none" });
      });
  };

  const totals = cartTotals(lines);
  const credit = preview?.credit_preview;

  const goOrder = () => {
    if (lines.length === 0) return;
    Taro.navigateTo({ url: "/pages/ue/order-create" });
  };

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="ue-cart-page">
        <PageHeader title="进货单" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/ue/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {state.loading ? <ErpStateLine text="加载中…" /> : null}
            {state.error ? <ErpStateLine text={state.error} tone="error" /> : null}
            {!state.loading && !state.error && lines.length === 0 ? (
              <ErpStateLine text="进货单是空的，先去挑点货" />
            ) : null}

            <View className="ue-list">
              {lines.map((l) => (
                <View key={l.line_id} className="ue-row-card" data-testid="ue-cart-line">
                  <View className="ue-row-main">
                    <Text className="ue-product-title">{l.title ?? l.product}</Text>
                    <Text className="ue-product-meta">
                      {l.product}
                      {l.unit ? ` · ${l.unit}` : ""} × {String(l.qty ?? "")}
                    </Text>
                  </View>
                  <View className="ue-row-side">
                    <Text className="ue-product-price">¥{fmtAmount(l.quote?.line_total)}</Text>
                    <Text className="ue-row-action" data-testid="ue-cart-remove" onClick={() => removeLine(l.line_id)}>
                      删除
                    </Text>
                  </View>
                </View>
              ))}
            </View>

            {lines.length > 0 ? (
              <View className="ue-card">
                <View className="ue-kv">
                  <Text className="ue-kv-key">合计（按加行快照）</Text>
                  <Text className="ue-kv-val">
                    {totals.count} 行 · ¥{fmtAmount(totals.amount)}
                  </Text>
                </View>
                <Text className="ue-link-btn" onClick={runPreview} data-testid="ue-cart-preview-btn">
                  {previewPending ? "试算中…" : "取价试算（不占额度）"}
                </Text>
                {preview ? (
                  <View className="ue-kv-block" data-testid="ue-cart-preview">
                    <View className="ue-kv">
                      <Text className="ue-kv-key">试算合计</Text>
                      <Text className="ue-kv-val">
                        ¥{fmtAmount(preview.amount_total)} {preview.currency ?? ""}
                      </Text>
                    </View>
                    {credit ? (
                      <>
                        <View className="ue-kv">
                          <Text className="ue-kv-key">信用预估占用</Text>
                          <Text className={`ue-kv-val${credit.sufficient ? "" : " ue-error-line"}`}>
                            {credit.sufficient
                              ? `可承受（可用 ${fmtAmount(credit.available)}）`
                              : `额度不足（可用 ${fmtAmount(credit.available)}，本单 ${fmtAmount(credit.requested)}）`}
                          </Text>
                        </View>
                        <Text className="ue-note-line">{credit.note ?? ""}</Text>
                      </>
                    ) : null}
                    <Text className="ue-note-line">试算为纯读预览；实际占用在下单经信用校验记账。</Text>
                  </View>
                ) : null}
                <Text className="ue-cta" data-testid="ue-cart-goto-order" onClick={goOrder}>
                  去下单
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
