// UE 订单详情与物流轨迹（P1 2.3，api-contract §3）：GET /orders/{id} +
// GET /orders/{id}/fulfillment（履约编排 + 运单轨迹 + 电子回单，同源交付
// 编排面）。履约面如实呈现：未确认订单无履约编排（404）如实说明，
// handoff_pending 如实显示「已移交待编排」，绝不伪造轨迹。

import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { ErpApiError, type FulfillmentView, type OrderDetailData } from "@/pagesets/erp-api";
import { ueApi } from "@/pagesets/ue-api-wire";
import { ErpStateLine } from "@/pagesets/ue-states";
import { fmtAmount, fulfillmentView, orderStatusText } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/ue/order-detail";

export default function UeOrderDetailPage() {
  const router = useRouter();
  const orderId = router.params.orderId ?? "";
  const [data, setData] = useState<OrderDetailData | null>(null);
  const [fulfillment, setFulfillment] = useState<FulfillmentView | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [fulfillText, setFulfillText] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) {
      setState({ loading: false, error: "缺少订单参数" });
      return;
    }
    setState({ loading: true, error: null });
    ueApi
      .orderDetail(orderId)
      .then((d) => {
        setData(d);
        setState({ loading: false, error: null });
      })
      .catch((e: Error) => setState({ loading: false, error: e.message || "读取失败" }));
    ueApi
      .orderFulfillment(orderId)
      .then((f) => {
        setFulfillment(f);
        setFulfillText(fulfillmentView(f));
      })
      .catch((e) => {
        // 404（未确认订单无履约编排）是如实状态，不是页面错误。
        if (e instanceof ErpApiError && e.code === "NOT_FOUND") {
          setFulfillment(null);
          setFulfillText(fulfillmentView(null));
          return;
        }
        setFulfillText(e.message || "履约读取失败");
      });
  }, [orderId]);

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="ue-order-detail-page">
        <PageHeader title="订单详情" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/ue/order-list" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {state.loading ? <ErpStateLine text="加载中…" /> : null}
            {state.error ? <ErpStateLine text={state.error} tone="error" /> : null}

            {data ? (
              <>
                <View className="ue-card" data-testid="ue-order-detail">
                  <View className="ue-row-head">
                    <Text className="ue-detail-title ue-mono">{data.orderId}</Text>
                    <Text className={`ue-chip${data.status === "confirmed" ? " ue-chip-active" : ""}`}>{orderStatusText(data.status)}</Text>
                  </View>
                  <Text className="ue-note-line">{data.status_note ?? ""}</Text>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">下单日</Text>
                    <Text className="ue-kv-val">{data.day ?? "—"}</Text>
                  </View>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">金额</Text>
                    <Text className="ue-kv-val">
                      ¥{fmtAmount(data.amount_total)} {data.currency ?? ""}
                    </Text>
                  </View>
                  {data.credit_reservation ? (
                    <View className="ue-kv">
                      <Text className="ue-kv-key">信用占用</Text>
                      <Text className="ue-kv-val">
                        {fmtAmount(data.credit_reservation.amount)}（内核 reserve_credit）
                      </Text>
                    </View>
                  ) : null}
                  <View className="ue-kv-block">
                    {(data.lines ?? []).map((l) => (
                      <View key={`${String(l.product)}-${String(l.qty ?? "")}-${String(l.unit ?? "")}`} className="ue-kv">
                        <Text className="ue-kv-key">
                          {String(l.product)}
                          {l.unit ? `（${l.unit}）` : ""}
                        </Text>
                        <Text className="ue-kv-val">
                          × {String(l.qty ?? "")} · ¥{fmtAmount(l.line_total)}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>

                <View className="ue-card" data-testid="ue-order-fulfillment">
                  <Text className="ue-detail-title">履约与轨迹</Text>
                  <Text className="ue-note-line">{fulfillText ?? "履约读取中…"}</Text>
                  {fulfillment?.plans && fulfillment.plans.length > 0 ? (
                    <View className="ue-kv-block">
                      {fulfillment.plans.map((p, i) => (
                        <View key={String(p.plan_ref ?? i)} className="ue-kv">
                          <Text className="ue-kv-key ue-mono">{String(p.plan_ref ?? `plan-${i}`)}</Text>
                          <Text className="ue-kv-val">
                            {String(p.path ?? "")} · {String(p.status ?? "")}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
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
