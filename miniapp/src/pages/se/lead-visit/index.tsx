// SE 线索/拜访登记（P2 3.2）：GET/POST /se/leads、/se/visits 后端如实 501
// （模板层无 CRM 线索/拜访事件档）。页面调用后按 notImplemented 渲染
// CapabilityUnavailable：不显示假表单、不伪装成「加载失败」。
// 「今日拜访计划」同理不可得（工作台 notes 已如实标注）。

import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { seApi } from "@/pagesets/se-api-wire";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { CapabilityUnavailable, ErpStateLine } from "@/pagesets/ue-states";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/se/lead-visit";
const SURFACE = "supply-chain.se" as const;

export default function SeLeadVisitPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const read = useSurfaceRead(() => seApi.leads({ limit: 20 }), ready);

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="se-lead-visit-page">
        <PageHeader title="线索/拜访登记" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/se/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}
            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}
            {ready && read.notImplemented ? <CapabilityUnavailable message={read.notImplementedMessage} /> : null}

            {ready && !read.loading && !read.notImplemented && !read.error ? (
              <View className="ue-list" data-testid="se-lead-list">
                {(read.data?.data ?? []).length === 0 ? <ErpStateLine text="线索池为空" /> : null}
                {(read.data?.data ?? []).map((row, i) => (
                  <View key={String(row.ref ?? i)} className="ue-row-card">
                    <View className="ue-row-main">
                      <Text className="ue-product-title">{String(row.title ?? row.name ?? "线索")}</Text>
                      <Text className="ue-product-meta">{String(row.status ?? "")}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            <View className="ue-card">
              <Text className="ue-detail-title">关于本页</Text>
              <Text className="ue-note-line">
                CRM 线索与拜访事件档尚未上线：建线索、拜访登记（含可选定位）与记录查询在后端均为「能力未提供」，本页如实展示，不提供模拟表单。
              </Text>
              <Text className="ue-note-line">
                拜访定位/影像属于可选采集项，须隐私声明过审后启用（契约 0. 采集纪律）。
              </Text>
            </View>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
