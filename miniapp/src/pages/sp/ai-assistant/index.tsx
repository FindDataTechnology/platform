// SP AI 助手（P2 4.7，契约 §7：无独立 AI 端点）。同源取数：由底座 chat 面
// 承载，本页只做入口 —— 不调任何 ERP 端点、零平行取数（grep 可证）。
// 建议类输出标注为建议；动作类输出（接单、发货反馈）必须经确认门生效。

import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/sp/ai-assistant";
export const CHAT_SURFACE_PATH = "/pages/chat/index";

export default function SpAiAssistantPage() {
  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="sp-ai-page">
        <PageHeader title="AI 助手" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/sp/home" }) })} />
        <View className="ue-body">
          <View className="ue-card" data-testid="sp-ai-card">
            <Text className="ue-detail-title">供应商 AI 助手</Text>
            <Text className="ue-note-line">
              订单、交期与对账问答由底座 AI 对话面承载：答复与供应商协同页同源同口径，数据域限本供应商档案，不泄露其他供应商数据。
            </Text>
            <Text className="ue-cta" data-testid="sp-ai-open-chat" onClick={() => Taro.reLaunch({ url: CHAT_SURFACE_PATH })}>
              进入 AI 对话
            </Text>
            <Text className="ue-note-line">
              AI 建议类输出仅供参考（标注为建议）；动作类输出（接单、发货反馈）必须经确认门确认后才会生效。
            </Text>
          </View>
          <View className="ue-bottom-pad" />
        </View>
      </View>
    </PagesetGate>
  );
}
