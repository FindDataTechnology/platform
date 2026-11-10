// SE 预警收件箱（P2 3.4）：GET /se/alerts —— 阈值预警→处置任务闭环
// （tasks 7.2）的移动呈现。列表只读；拍板在「预警处置」页（确认门）。

import { useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { seApi } from "@/pagesets/se-api-wire";
import { type SeAlertRow } from "@/pagesets/surface-api";
import { ErrorLine, IdentityMissing, useSurfaceIdentity, useSurfaceRead } from "@/pagesets/surface-gate";
import { ErpStateLine } from "@/pagesets/ue-states";
import { disposalStatusText, severityText } from "@/pagesets/surface-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/se/alert-inbox";
const SURFACE = "supply-chain.se" as const;

export default function SeAlertInboxPage() {
  const identity = useSurfaceIdentity(SURFACE);
  const ready = identity.value !== null;
  const [status, setStatus] = useState<"pending" | "all">("pending");
  const read = useSurfaceRead(() => seApi.alerts({ status, limit: 50 }), ready, status);
  const rows: SeAlertRow[] = read.data?.data ?? [];

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="se-alert-inbox-page">
        <PageHeader title="预警收件箱" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/se/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {!ready ? <IdentityMissing identity={identity} /> : null}

            {ready ? (
              <View className="ue-chip-row">
                {([
                  ["pending", "待处置"],
                  ["all", "全部"],
                ] as const).map(([v, label]) => (
                  <Text key={v} className={`ue-chip${status === v ? " ue-chip-active" : ""}`} onClick={() => setStatus(v)}>
                    {label}
                  </Text>
                ))}
              </View>
            ) : null}

            {ready && read.loading ? <ErpStateLine text="加载中…" /> : null}
            {ready && read.error ? <ErrorLine error={read.error} /> : null}
            {ready && !read.loading && !read.error && rows.length === 0 ? <ErpStateLine text="没有待处置预警" /> : null}

            <View className="ue-list" data-testid="se-alert-list">
              {rows.map((a) => (
                <View
                  key={a.alertId}
                  className="ue-row-card"
                  data-testid="se-alert-row"
                  onClick={() => Taro.navigateTo({ url: `/pages/se/alert-handle?alertId=${encodeURIComponent(a.alertId ?? "")}` })}
                >
                  <View className="ue-row-main">
                    <Text className="ue-product-title">{a.title ?? a.metric ?? "阈值预警"}</Text>
                    <Text className="ue-product-meta">
                      {severityText(a.severity)} · {a.metric ?? ""} {a.value ?? ""}/{a.threshold ?? ""} · {disposalStatusText(a.status)}
                    </Text>
                  </View>
                  <Text className="ue-row-action">处置</Text>
                </View>
              ))}
            </View>
            <Text className="ue-note-line">拍板与 owner 席位同一确认门实现（移动端不引入第二套状态机）；拒绝留痕不落账。</Text>
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
