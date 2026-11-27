// Demo quota end-state card (openspec: add-mp-demo-quota-end): the designed
// surface at the moment the demo budget dies, rendered at the transcript's
// foot — the exact place the user is looking when their prompt does not
// answer. Two shapes, two recoveries: "cell" (gateway per-cell budget —
// binding a real account upgrades out of demo) and "connection" (sandbox
// per-connection budget — a reconnect IS recovery, the new connection starts
// with a full budget). Block-card pattern: white card, hairline, 12rpx;
// one Pocket Blue primary action per the one-lamp rule.

import { Text, View } from "@tarojs/components";

export interface DemoQuotaCardProps {
  shape: "cell" | "connection";
  message: string;
  onBind: () => void;
  onReconnect: () => void;
  onDismiss: () => void;
}

export default function DemoQuotaCard({ shape, message, onBind, onReconnect, onDismiss }: DemoQuotaCardProps) {
  const isCell = shape === "cell";
  return (
    <View className="quota-card" data-testid="mp-demo-quota-card" data-shape={shape}>
      <View className="quota-card-head">
        <Text className="quota-card-title">{isCell ? "体验额度已用完" : "本轮演示额度已用完"}</Text>
        <Text className="quota-card-close" aria-label="关闭" onClick={onDismiss}>
          ✕
        </Text>
      </View>
      <Text className="quota-card-body">{message}</Text>
      {isCell ? (
        <Text className="quota-card-action" data-testid="mp-quota-bind" onClick={onBind}>
          绑定账号解锁完整功能 ›
        </Text>
      ) : (
        <Text className="quota-card-action" data-testid="mp-quota-reconnect" onClick={onReconnect}>
          重新连接继续 ›
        </Text>
      )}
    </View>
  );
}
