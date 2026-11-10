// SP 供应商工作台（P2 4.1）：GET /sp/workspace —— 待接单/待发货/到货预告/
// 对账/发票计数卡。对账域与发票域后端如实 501，服务器 notes 原样呈现
// （计数为何是 0 要说清楚，不能让 0 读成「没有业务」）。
// 资金红线：本端零支付操作面，结算查询只读。

import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate, useVisiblePagesets } from "@/pagesets";
import { spApi } from "@/pagesets/sp-api-wire";
import { type SpWorkspaceData } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/sp/home";
const SURFACE = "supply-chain.sp" as const;

function selfEntries(visible: Array<{ def: { key: string }; pages: Array<{ path: string; title: string }> }>) {
  const sp = visible.find((p) => p.def.key === SURFACE);
  if (!sp) return [];
  return sp.pages.filter((p) => p.path !== PAGE_PATH).map((p) => ({ path: p.path, title: p.title }));
}

export default function SpHomePage() {
  const visible = useVisiblePagesets();
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const read = useSurfaceRead<SpWorkspaceData>(() => spApi.workspace(), ready);
  const w = read.data;
  const entries = selfEntries(visible);

  const cards: Array<{ label: string; value: number | undefined }> = [
    { label: "采购单", value: w?.po_count },
    { label: "待接单", value: w?.po_pending_accept },
    { label: "待发货", value: w?.po_pending_ship },
    { label: "到货预告", value: w?.arrival_notices_open },
  ];

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="sp-home-page">
        <PageHeader title="供应商工作台" />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}

            {ready && w ? (
              <View className="ue-card" data-testid="sp-home-cards">
                <Text className="ue-detail-title">今日概览</Text>
                <View className="ue-entry-grid">
                  {cards.map((c) => (
                    <View key={c.label} className="ue-entry" data-testid="sp-home-card">
                      <Text className="ue-product-price">{c.value ?? 0}</Text>
                      <Text className="ue-product-meta">{c.label}</Text>
                    </View>
                  ))}
                </View>
                <Text className="ue-note-line">
                  供应商：{w.supplier_code ?? w.supplier_id ?? ""}（{identity.source}）
                </Text>
                {w.notes?.statements ? <Text className="ue-note-line">{w.notes.statements}</Text> : null}
                {w.notes?.invoices ? <Text className="ue-note-line">{w.notes.invoices}</Text> : null}
                {w.notes?.settlements ? <Text className="ue-note-line">{w.notes.settlements}</Text> : null}
              </View>
            ) : null}

            {ready && entries.length > 0 ? (
              <View className="ue-card">
                <Text className="ue-detail-title">功能入口</Text>
                <View className="ue-entry-grid" data-testid="sp-home-entries">
                  {entries.map((e) => (
                    <Text
                      key={e.path}
                      className="ue-entry"
                      data-testid="sp-home-entry"
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
