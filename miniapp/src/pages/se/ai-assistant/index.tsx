// SE AI 助手（P2 3.6，manifest aiEntry；契约 §6：无独立 AI 端点）。
// 同源取数纪律：AI 助手由底座 chat 面（pages/chat/index + WS wsSend）承载 ——
// 本页是入口页，唯一动作是进入底座对话面；不另开 WS 面、不调任何 ERP 端点、
// 零平行取数路径（grep 可证：本页无网络调用）。建议类输出标注为建议，
// 动作类输出（代客下单、预警拍板）必须经确认门后生效。

import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/se/ai-assistant";
export const CHAT_SURFACE_PATH = "/pages/chat/index";

export default function SeAiAssistantPage() {
  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="se-ai-page">
        <PageHeader title="AI 助手" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/se/home" }) })} />
        <View className="ue-body">
          <View className="ue-card" data-testid="se-ai-card">
            <Text className="ue-detail-title">业务员 AI 助手</Text>
            <Text className="ue-note-line">
              客户口径、订单跟进与预警处置建议由底座 AI 对话面承载：答复与业务员台页面同源同口径（同一指标出处），不泄露其他业务员名下客户数据。
            </Text>
            <Text className="ue-cta" data-testid="se-ai-open-chat" onClick={() => Taro.reLaunch({ url: CHAT_SURFACE_PATH })}>
              进入 AI 对话
            </Text>
            <Text className="ue-note-line">
              AI 建议类输出仅供参考（标注为建议）；动作类输出（代客下单、预警拍板）必须经确认门确认后才会生效。
            </Text>
          </View>
          <View className="ue-bottom-pad" />
        </View>
      </View>
    </PagesetGate>
  );
}
