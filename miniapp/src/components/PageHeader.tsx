// The one shared top bar for navigationStyle:"custom" pages (sessions, cron,
// login, share — the chat page keeps its own three-zone bar). Title centered
// between the back zone and a spacer balancing it; the capsule's width is
// reserved on the row so the title can never underlap it. Padded to the
// 88rpx hit bar per the touch standard.

import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { topInsets } from "@/lib/top-insets";

export default function PageHeader({
  title,
  onBack,
}: {
  title: string;
  // Omit for the standard back (navigateBack, falling back to the chat root
  // — the stack can be shallow after a forward-card reLaunch). Pass a
  // callback for in-page back (the cron viewer's 返回任务列表).
  onBack?: () => void;
}) {
  const ins = topInsets();
  return (
    <View
      className="page-header"
      style={{ paddingTop: `${ins.statusBar}px`, paddingRight: `${ins.capsuleReserve}px` }}
    >
      <View className="page-header-row" style={{ height: `${ins.navHeight}px` }}>
        {onBack ? (
          <Text className="page-header-back" aria-label="返回" data-testid="mp-header-back" onClick={onBack}>
            ‹
          </Text>
        ) : (
          <Text
            className="page-header-back"
            aria-label="返回"
            data-testid="mp-header-back"
            onClick={() =>
              Taro.navigateBack({
                fail: () => Taro.reLaunch({ url: "/pages/chat/index" }),
              })
            }
          >
            ‹
          </Text>
        )}
        <Text className="page-header-title">{title}</Text>
        <View className="page-header-spacer" />
      </View>
    </View>
  );
}
