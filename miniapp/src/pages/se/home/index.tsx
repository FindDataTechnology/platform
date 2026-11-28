// SE 业务员工作台（pageset supply-chain.se 的 home，openspec P2 3.1）。
// 三段面：名下客户/待办/预警计数卡（GET /se/workspace）、本页面集入口、
// 口径注记（服务器 notes 原样：CRM 车道未上线的如实说明不吞掉）。
// 身份：X-ERP-Staff；未绑定 → 页面不请求，显示绑定说明（fail-closed）。

import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate, useVisiblePagesets } from "@/pagesets";
import { seApi } from "@/pagesets/se-api-wire";
import { type SeWorkspaceData } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/se/home";
const SURFACE = "supply-chain.se" as const;

function selfEntries(visible: Array<{ def: { key: string }; pages: Array<{ path: string; title: string }> }>) {
  const se = visible.find((p) => p.def.key === SURFACE);
  if (!se) return [];
  return se.pages.filter((p) => p.path !== PAGE_PATH).map((p) => ({ path: p.path, title: p.title }));
}

export default function SeHomePage() {
  const visible = useVisiblePagesets();
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const read = useSurfaceRead<SeWorkspaceData>(() => seApi.workspace(), ready);

  const entries = selfEntries(visible);
  const w = read.data;

  const cards: Array<{ label: string; value: number | undefined; hint?: string }> = [
    { label: "名下客户", value: w?.owned_customer_count },
    { label: "待确认订单", value: w?.pending_orders },
    { label: "未结对账", value: w?.open_statements },
    { label: "待处置预警", value: w?.pending_alerts },
  ];

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="se-home-page">
        <PageHeader title="业务员工作台" />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}

            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}

            {ready && w ? (
              <View className="ue-card" data-testid="se-home-cards">
                <Text className="ue-detail-title">今日概览</Text>
                <View className="ue-entry-grid">
                  {cards.map((c) => (
                    <View key={c.label} className="ue-entry" data-testid="se-home-card">
                      <Text className="ue-product-price">{c.value ?? 0}</Text>
                      <Text className="ue-product-meta">{c.label}</Text>
                    </View>
                  ))}
                </View>
                <Text className="ue-note-line">身份：{w.staff ?? identity.value ?? ""}（{identity.source}）</Text>
                {w.notes?.orders ? <Text className="ue-note-line">{w.notes.orders}</Text> : null}
                {w.notes?.alerts ? <Text className="ue-note-line">{w.notes.alerts}</Text> : null}
                {w.notes?.crm ? <Text className="ue-note-line">{w.notes.crm}</Text> : null}
              </View>
            ) : null}

            {ready && entries.length > 0 ? (
              <View className="ue-card">
                <Text className="ue-detail-title">功能入口</Text>
                <View className="ue-entry-grid" data-testid="se-home-entries">
                  {entries.map((e) => (
                    <Text
                      key={e.path}
                      className="ue-entry"
                      data-testid="se-home-entry"
                      onClick={() => Taro.navigateTo({ url: `/${e.path}` })}
                    >
                      {e.title}
                    </Text>
                  ))}
                </View>
              </View>
            ) : null}

            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
