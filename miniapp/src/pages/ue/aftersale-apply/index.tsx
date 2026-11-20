// UE 售后申请（P1 2.3，api-contract §6 POST /ue/aftersale-requests）。
// 后端实态：售后流三端点均如实 501（编排层无售后处置车道）。本页消费
// 契约端点并把 501 如实呈现为「该能力当前未提供」+ 服务器人话 message
// 原样：不提供假表单、不伪装提交成功。

import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import { ueApi } from "@/pagesets/ue-api-wire";
import { CapabilityUnavailable, ErpStateLine } from "@/pagesets/ue-states";
import { capabilityUnavailableText } from "@/pagesets/ue-view";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/ue/aftersale-apply";

type ErrLike = { notImplemented?: boolean; message?: string };

export default function UeAftersaleApplyPage() {
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });

  useEffect(() => {
    // 探测契约写面前的读面：501 → 如实能力未提供（写面同车道，一并如实）。
    ueApi
      .aftersaleRequests()
      .then(() => setState({ loading: false, error: null }))
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
      <View className="ue-page" data-testid="ue-aftersale-apply-page">
        <PageHeader title="售后申请" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/ue/home" }) })} />
        <ScrollView scrollY className="ue-scroll">
          <View className="ue-body">
            {state.loading ? <ErpStateLine text="加载中…" /> : null}
            {state.error ? <ErpStateLine text={state.error} tone="error" /> : null}
            {unavailable ? (
              <>
                <CapabilityUnavailable message={unavailable} />
                <Text className="ue-note-line" data-testid="ue-aftersale-note">
                  售后申请通道尚未开通：退/换/补申请与处置进度待后端售后车道实施后开放。
                </Text>
              </>
            ) : null}
            <View className="ue-bottom-pad" />
          </View>
        </ScrollView>
      </View>
    </PagesetGate>
  );
}
