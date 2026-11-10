// UE 售后进度（P1 2.3，api-contract §6 GET /ue/aftersale-requests[/{id}]）。
// 后端实态：售后流三端点均如实 501。本页如实呈现「该能力当前未提供」，
// 不伪装进度面。

import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { ueApi } from "@/pagesets/ue-api-wire";
import { type ListEnvelope } from "@/pagesets/erp-api";
import { CapabilityUnavailable, ErpStateLine } from "@/pagesets/ue-states";
import { capabilityUnavailableText } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/ue/aftersale-detail";

type ErrLike = { notImplemented?: boolean; message?: string };

export default function UeAftersaleDetailPage() {
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [list, setList] = useState<ListEnvelope<Record<string, unknown>> | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });

  useEffect(() => {
    ueApi
      .aftersaleRequests()
      .then((res) => {
        setList(res);
        setUnavailable(null);
        setState({ loading: false, error: null });
      })
      .catch((e: ErrLike) => {
        if (e.notImplemented) {
          setUnavailable(capabilityUnavailableText(e).message);
          setState({ loading: false, error: null });
          return;
        }
        setState({ loading: false, error: e.message || "读取失败" });
      });
  }, []);

  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="ue-aftersale-detail-page">
        <PageHeader title="售后进度" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/ue/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {state.loading ? <ErpStateLine text="加载中…" /> : null}
            {state.error ? <ErpStateLine text={state.error} tone="error" /> : null}
            {unavailable ? <CapabilityUnavailable message={unavailable} /> : null}
            {list ? (
              list.data.length === 0 ? (
                <ErpStateLine text="暂无售后申请记录" />
              ) : (
                <View className="ue-list">
                  {list.data.map((row, i) => (
                    <View key={String(row.request_id ?? i)} className="ue-row-card">
                      <View className="ue-row-main">
                        <Text className="ue-product-title ue-mono">{String(row.request_id ?? "")}</Text>
                        <Text className="ue-product-meta">{String(row.status ?? "")}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )
            ) : null}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
