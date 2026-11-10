// UE AI 助手（P1 2.4，manifest aiEntry；api-contract §7：无独立 AI 端点）。
// 取数同源纪律：AI 助手由底座 chat 面（pages/chat/index + WS wsSend 契约）
// 承载 —— 本页是入口页，唯一动作就是进入底座对话面；不另开 WS 面、不打
// 任何 /erp/ 端点、零平行取数路径（grep 可证：本页无网络调用）。
// 纪律文案照契约 §7：建议类输出标注为建议；动作类输出必须经确认门后生效。

import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { PagesetGate } from "@/pagesets";
import PageHeader from "@/components/PageHeader";

const PAGE_PATH = "pages/ue/ai-assistant";
/** 底座 chat 面路由（同源取数唯一去向；pageset-base/v1 复用页）。 */
export const CHAT_SURFACE_PATH = "/pages/chat/index";

export default function UeAiAssistantPage() {
  return (
    <PagesetGate pagePath={PAGE_PATH}>
      <View className="ue-page" data-testid="ue-ai-page">
        <PageHeader title="AI 助手" onBack={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/ue/home" }) })} />
        <View className="ue-body">
          <View className="ue-card" data-testid="ue-ai-card">
            <Text className="ue-detail-title">订货台 AI 助手</Text>
            <Text className="ue-note-line">
              经营问答、智能推荐与预警处置由底座 AI 对话面承载：答复与订货台页面同源同口径（同一指标出处），不泄露其他租户数据。
            </Text>
            <Text
              className="ue-cta"
              data-testid="ue-ai-open-chat"
              onClick={() => Taro.reLaunch({ url: CHAT_SURFACE_PATH })}
            >
              进入 AI 对话
            </Text>
            <Text className="ue-note-line">AI 建议类输出仅供参考（标注为建议）；动作类输出（下单、对账拍板等）必须经确认门确认后才会生效。</Text>
          </View>
          <View className="ue-bottom-pad" />
        </View>
      </View>
    </PagesetGate>
  );
}
