// CP AI 助手（P3 5.8，契约 §7：无独立 AI 端点）。同源取数：由底座 chat 面
// 承载，本页只做入口 —— 不调任何 ERP 端点、零平行取数（grep 可证）。
// 建议类输出标注为建议；动作类输出（接单、签收上报）必须经确认门生效。

import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/cp/ai-assistant";
export const CHAT_SURFACE_PATH = "/pages/chat/index";

export default function CpAiAssistantPage() {
  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="cp-ai-page">
        <PageHeader title="AI 助手" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/cp/home" }) })} />
        <View className="ue-body">
          <View className="ue-card" data-testid="cp-ai-card">
            <Text className="ue-detail-title">承运商 AI 助手</Text>
            <Text className="ue-note-line">
              运单、月台与签收问答由底座 AI 对话面承载：答复与承运协同页同源同口径，数据域限本承运商运单，不泄露其他承运商数据。
            </Text>
            <Text className="ue-cta" data-testid="cp-ai-open-chat" onClick={() => Taro.reLaunch({ url: CHAT_SURFACE_PATH })}>
              进入 AI 对话
            </Text>
            <Text className="ue-note-line">
              AI 建议类输出仅供参考（标注为建议）；动作类输出（接单、签收上报）必须经确认门确认后才会生效。
            </Text>
          </View>
          <View className="ue-bottom-pad" />
        </View>
      </View>
    </PagesetGate>
  );
}
