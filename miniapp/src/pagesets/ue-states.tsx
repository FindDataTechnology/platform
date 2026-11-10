// Shared honest-state lines for pageset pages (P1 UE): loading / error /
// empty / capability-unavailable. One voice per page — states are TEXT lines
// on paper, never a fake-success or a disguised 501.

import { Text, View } from "@tarojs/components";
import { CAPABILITY_UNAVAILABLE_TITLE } from "./ue-view.ts";

/** 通用一行状态（加载/错误/空）。text 已是人话；error 行用错误红。 */
export function ErpStateLine({ text, tone = "muted" }: { text: string; tone?: "muted" | "error" }) {
  return (
    <View className={`erp-state${tone === "error" ? " erp-state-error" : ""}`} data-testid="erp-state">
      <Text className="erp-state-text">{text}</Text>
    </View>
  );
}

/**
 * 501 如实区块：标题 + 服务器人话 message 原样。契约端点未实施时页面区块
 * 显示此状态（不伪装成功能、不显示假表单）。
 */
export function CapabilityUnavailable({ message }: { message: string }) {
  return (
    <View className="erp-capability" data-testid="erp-capability-unavailable">
      <Text className="erp-capability-title">{CAPABILITY_UNAVAILABLE_TITLE}</Text>
      <Text className="erp-capability-message">{message}</Text>
    </View>
  );
}
