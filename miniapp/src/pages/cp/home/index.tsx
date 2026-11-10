// CP 承运商工作台（P3 5.1）：GET /cp/workspace —— 待接运单/在途/月台预约/
// 异常签收计数卡。服务器 notes 原样呈现（可约时段目录与运费单 read 面为何
// 不可得要说明白）。采集纪律：定位/影像为可选采集，隐私声明过审后启用。

import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate, useVisiblePagesets } from "@/pagesets";
import { cpApi } from "@/pagesets/cp-api-wire";
import { type CpWorkspaceData } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/cp/home";
const SURFACE = "supply-chain.cp" as const;

function selfEntries(visible: Array<{ def: { key: string }; pages: Array<{ path: string; title: string }> }>) {
  const cp = visible.find((p) => p.def.key === SURFACE);
  if (!cp) return [];
  return cp.pages.filter((p) => p.path !== PAGE_PATH).map((p) => ({ path: p.path, title: p.title }));
}

export default function CpHomePage() {
  const visible = useVisiblePagesets();
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const read = useSurfaceRead<CpWorkspaceData>(() => cpApi.workspace(), ready);
  const w = read.data;
  const entries = selfEntries(visible);

  const cards: Array<{ label: string; value: number | undefined }> = [
    { label: "运单", value: w?.waybills_total },
    { label: "在途", value: w?.waybills_open },
    { label: "待接单", value: w?.waybills_pending_accept },
    { label: "月台预约", value: w?.dock_reservations_active },
  ];

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="cp-home-page">
        <PageHeader title="承运商工作台" />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}

            {ready && w ? (
              <View className="ue-card" data-testid="cp-home-cards">
                <Text className="ue-detail-title">今日概览</Text>
                <View className="ue-entry-grid">
                  {cards.map((c) => (
                    <View key={c.label} className="ue-entry" data-testid="cp-home-card">
                      <Text className="ue-product-price">{c.value ?? 0}</Text>
                      <Text className="ue-product-meta">{c.label}</Text>
                    </View>
                  ))}
                </View>
                <Text className="ue-note-line">
                  承运商：{w.carrier ?? identity.value ?? ""}（{identity.source}）
                </Text>
                {w.pod_exceptions ? (
                  <Text className="ue-note-line ue-error-line">异常签收 {w.pod_exceptions} 单已进处置车道</Text>
                ) : null}
                {w.notes?.tasks ? <Text className="ue-note-line">{w.notes.tasks}</Text> : null}
                {w.notes?.dock_slots ? <Text className="ue-note-line">{w.notes.dock_slots}</Text> : null}
                {w.notes?.freight ? <Text className="ue-note-line">{w.notes.freight}</Text> : null}
              </View>
            ) : null}

            {ready && entries.length > 0 ? (
              <View className="ue-card">
                <Text className="ue-detail-title">功能入口</Text>
                <View className="ue-entry-grid" data-testid="cp-home-entries">
                  {entries.map((e) => (
                    <Text
                      key={e.path}
                      className="ue-entry"
                      data-testid="cp-home-entry"
                      onClick={() => Taro.navigateTo({ url: `/${e.path}` })}
                    >
                      {e.title}
                    </Text>
                  ))}
                </View>
              </View>
            ) : null}

            <Text className="ue-note-line">
              采集纪律：定位与影像为可选采集项，须隐私声明过审后启用；本页不主动采集任何位置/影像。
            </Text>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
