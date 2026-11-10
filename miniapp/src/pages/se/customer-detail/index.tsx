// SE 客户 360（P2 3.2）：档案 + 信用额度位（账本同源）+ 近单 + 对账状态
// （GET /se/customers/{id}），并可跳代客下单/名下订单。
// 越域/未知一律 404（服务端不泄露存在性）——页面原样转述，不猜「可能没权限」。

import { ScrollView, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { seApi } from "@/pagesets/se-api-wire";
import { type SeCustomer360 } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import { fmtAmount, orderStatusText } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/se/customer-detail";
const SURFACE = "supply-chain.se" as const;

export default function SeCustomerDetailPage() {
  const router = useRouter();
  const customerId = (router.params.customerId ?? "").trim();
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null && !!customerId;
  const read = useSurfaceRead<SeCustomer360>(() => seApi.customer360(customerId), ready);
  const d = read.data;
  const credit = d?.credit;

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="se-customer-detail-page">
        <PageHeader title="客户 360" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/se/customer-list" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}

            {d ? (
              <>
                <View className="ue-card" data-testid="se-customer-profile">
                  <Text className="ue-detail-title">{String(d.profile?.name ?? d.customerId ?? "")}</Text>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">编码</Text>
                    <Text className="ue-kv-val ue-mono">{String(d.profile?.code ?? "—")}</Text>
                  </View>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">业务员</Text>
                    <Text className="ue-kv-val">{String(d.profile?.sales_rep ?? "—")}</Text>
                  </View>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">档案状态</Text>
                    <Text className="ue-kv-val">{d.state ?? "—"}</Text>
                  </View>
                </View>

                <View className="ue-card" data-testid="se-customer-credit">
                  <Text className="ue-detail-title">信用额度</Text>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">额度</Text>
                    <Text className="ue-kv-val">{credit?.limit ? fmtAmount(credit.limit) : "未登记"}</Text>
                  </View>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">应收余额</Text>
                    <Text className="ue-kv-val">{credit?.ar_balance ? fmtAmount(credit.ar_balance) : "—"}</Text>
                  </View>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">已占用</Text>
                    <Text className="ue-kv-val">{credit?.reserved ? fmtAmount(credit.reserved) : "—"}</Text>
                  </View>
                  <View className="ue-kv">
                    <Text className="ue-kv-key">可用</Text>
                    <Text className="ue-kv-val ue-price-blue">{credit?.available ? fmtAmount(credit.available) : "—"}</Text>
                  </View>
                  {credit?.source_note ? <Text className="ue-note-line">{credit.source_note}</Text> : null}
                </View>

                <View className="ue-card" data-testid="se-customer-orders">
                  <Text className="ue-detail-title">近期订单（{d.order_count ?? 0}）</Text>
                  {(d.recent_orders ?? []).length === 0 ? <ErpStateLine text="暂无订单" /> : null}
                  {(d.recent_orders ?? []).map((o) => (
                    <View key={o.orderId} className="ue-kv">
                      <Text className="ue-kv-key ue-mono">{o.orderId}</Text>
                      <Text className="ue-kv-val">
                        {orderStatusText(o.status)} · {fmtAmount(o.amount_total)} {o.currency ?? ""}
                      </Text>
                    </View>
                  ))}
                  <View className="ue-kv">
                    <Text className="ue-kv-key">对账单</Text>
                    <Text className="ue-kv-val">
                      {d.statements?.count ?? 0} 张（未结 {d.statements?.open_count ?? 0}）
                    </Text>
                  </View>
                </View>

                <View className="ue-card">
                  <Text className="ue-detail-title">操作</Text>
                  <Text
                    className="ue-cta"
                    data-testid="se-customer-proxy-order"
                    onClick={() => Taro.navigateTo({ url: `/pages/se/order-proxy?customerId=${encodeURIComponent(customerId)}` })}
                  >
                    代客下单
                  </Text>
                  <Text
                    className="ue-link-btn"
                    onClick={() => Taro.navigateTo({ url: `/pages/se/order-track?customerId=${encodeURIComponent(customerId)}` })}
                  >
                    名下订单跟进
                  </Text>
                  <Text className="ue-note-line">代客下单不改变数据域：只能为本人名下客户下单（服务端主数据归属校验，越权 403）。</Text>
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
