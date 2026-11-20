// UE 我的订单（P1 2.3，api-contract §3 GET /ue/orders）：状态筛选 +
// 列表；状态机字段可解释（pending=待确认/confirmed=已确认/cancelled=已取消）。

import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { ueApi } from "@/pagesets/ue-api-wire";
import { type OrderSummary } from "@/pagesets/erp-api";
import { ErpStateLine } from "@/pagesets/ue-states";
import { fmtAmount, orderStatusText } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/ue/order-list";

const STATUS_FILTERS: Array<{ key: string; label: string }> = [
  { key: "", label: "全部" },
  { key: "pending", label: "待确认" },
  { key: "confirmed", label: "已确认" },
  { key: "cancelled", label: "已取消" },
];

export default function UeOrderListPage() {
  const [status, setStatus] = useState("");
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });

  // 状态筛选变化即重查（load 不进依赖：它只消费入参 st）。
  const load = useCallback((st: string) => {
    setState({ loading: true, error: null });
    ueApi
      .orders({ status: st || undefined })
      .then((res) => {
        setOrders(res.data ?? []);
        setState({ loading: false, error: null });
      })
      .catch((e: Error) => setState({ loading: false, error: e.message || "读取失败" }));
  }, []);

  useEffect(() => {
    load(status);
  }, [load, status]);

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="ue-order-list-page">
        <PageHeader title="我的订单" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/ue/home" }) })} />
        <View className="ue-chip-row" data-testid="ue-order-filters">
          {STATUS_FILTERS.map((f) => (
            <Text
              key={f.key}
              className={`ue-chip${status === f.key ? " ue-chip-active" : ""}`}
              onClick={() => setStatus(f.key)}
            >
              {f.label}
            </Text>
          ))}
        </View>
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {state.loading ? <ErpStateLine text="加载中…" /> : null}
            {state.error ? <ErpStateLine text={state.error} tone="error" /> : null}
            {!state.loading && !state.error && orders.length === 0 ? <ErpStateLine text="暂无订单" /> : null}

            <View className="ue-list">
              {orders.map((o) => (
                <View
                  key={o.orderId}
                  className="ue-row-card"
                  data-testid="ue-order-row"
                  data-order-status={o.status}
                  onClick={() => o.orderId && Taro.navigateTo({ url: `/pages/ue/order-detail?orderId=${encodeURIComponent(o.orderId)}` })}
                >
                  <View className="ue-row-main">
                    <Text className="ue-product-title ue-mono">{o.orderId}</Text>
                    <Text className="ue-product-meta">
                      {o.day ?? ""} · {orderStatusText(o.status)}
                    </Text>
                  </View>
                  <Text className="ue-product-price">
                    ¥{fmtAmount(o.amount_total)} {o.currency ?? ""}
                  </Text>
                </View>
              ))}
            </View>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
