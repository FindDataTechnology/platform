// SE 名下订单跟进（P2 3.3）：GET /se/orders（客户/状态/期间）+ 详情
// （GET /se/orders/{id}）。数据域=本人名下客户的订单；越域 404 原样转述。

import { useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { seApi } from "@/pagesets/se-api-wire";
import { type SeOrderRow } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import { fmtAmount, orderStatusText } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/se/order-track";
const SURFACE = "supply-chain.se" as const;

export default function SeOrderTrackPage() {
  const router = useRouter();
  const initialCustomer = (router.params.customerId ?? "").trim();
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const [status, setStatus] = useState<"" | "pending" | "confirmed" | "cancelled">("");
  const [openId, setOpenId] = useState<string | null>(null);
  const read = useSurfaceRead(
    () => seApi.orders({ customerId: initialCustomer || undefined, status: status || undefined, limit: 50 }),
    ready,
    `${initialCustomer}|${status}`,
  );
  const detail = useSurfaceRead(() => seApi.orderDetail(openId ?? ""), ready && !!openId, openId);

  const rows: SeOrderRow[] = read.data?.data ?? [];
  const d = detail.data;

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="se-order-track-page">
        <PageHeader title="名下订单跟进" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/se/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}

            {ready && !openId ? (
              <View className="ue-chip-row">
                {([
                  ["", "全部"],
                  ["pending", "待确认"],
                  ["confirmed", "已确认"],
                  ["cancelled", "已取消"],
                ] as const).map(([v, label]) => (
                  <Text key={v} className={`ue-chip${status === v ? " ue-chip-active" : ""}`} onClick={() => setStatus(v)}>
                    {label}
                  </Text>
                ))}
              </View>
            ) : null}

            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}
            {ready && !read.loading && !read.error && rows.length === 0 ? <ErpStateLine text="暂无订单" /> : null}

            {!openId ? (
              <View className="ue-list" data-testid="se-order-list">
                {rows.map((o) => (
                  <View key={o.orderId} className="ue-row-card" data-testid="se-order-row" onClick={() => setOpenId(o.orderId ?? "")}>
                    <View className="ue-row-main">
                      <Text className="ue-product-title ue-mono">{o.orderId}</Text>
                      <Text className="ue-product-meta">
                        {o.day ?? ""} · {orderStatusText(o.status)}
                      </Text>
                    </View>
                    <Text className="ue-product-price">
                      {fmtAmount(o.amount_total)} {o.currency ?? ""}
                    </Text>
                  </View>
                ))}
              </View>
            ) : (
              <View className="ue-card" data-testid="se-order-detail">
                <Text className="ue-detail-title ue-mono">{openId}</Text>
                {detail.loading ? <ErpStateLine text="加载中…" /> : null}
                {detail.error ? <ErrorLine error={detail.error} /> : null}
                {d ? (
                  <>
                    <View className="ue-kv">
                      <Text className="ue-kv-key">状态</Text>
                      <Text className="ue-kv-val">{orderStatusText(d.status)}</Text>
                    </View>
                    <View className="ue-kv">
                      <Text className="ue-kv-key">金额</Text>
                      <Text className="ue-kv-val">
                        {fmtAmount(d.amount_total)} {d.currency ?? ""}
                      </Text>
                    </View>
                    <View className="ue-kv">
                      <Text className="ue-kv-key">下单日</Text>
                      <Text className="ue-kv-val">{d.day ?? "—"}</Text>
                    </View>
                    {d.requested_by ? (
                      <View className="ue-kv">
                        <Text className="ue-kv-key">代理身份</Text>
                        <Text className="ue-kv-val ue-mono">{d.requested_by}</Text>
                      </View>
                    ) : null}
                    {d.status_note ? <Text className="ue-note-line">{d.status_note}</Text> : null}
                    {(d.lines ?? []).length > 0 ? <Text className="ue-note-strong">商品行</Text> : null}
                    {(d.lines ?? []).map((l, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 行集无稳定 id（本地草稿行/服务端行数组），只读渲染且顺序即身份
                      <View key={i} className="ue-kv">
                        <Text className="ue-kv-key">{String(l.product ?? l.product_code ?? "")}</Text>
                        <Text className="ue-kv-val">
                          × {String(l.qty ?? "")} {l.unit ?? ""} {l.line_total ? `· ${fmtAmount(l.line_total)}` : ""}
                        </Text>
                      </View>
                    ))}
                    <Text className="ue-link-btn" onClick={() => setOpenId(null)}>
                      返回列表
                    </Text>
                  </>
                ) : null}
              </View>
            )}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
