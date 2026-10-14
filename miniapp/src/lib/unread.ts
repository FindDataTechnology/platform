// 小程序端会话未读推导(spec: scheduled-task-notifications)。未读 = 会话的
// updatedAt 晚于本机上次查看时间。存 Taro storage(跨启动保留),无服务端
// 已读状态、无新事件——sessions 载荷本来就带 updatedAt。

import Taro from "@tarojs/taro";

const KEY = "platform.sessionLastSeen";

export type LastSeenMap = Record<string, string>;

export function getLastSeen(): LastSeenMap {
  try {
    return Taro.getStorageSync(KEY) || {};
  } catch {
    return {};
  }
}

export function markSessionSeen(id: string): LastSeenMap {
  const next = { ...getLastSeen(), [id]: new Date().toISOString() };
  try {
    Taro.setStorageSync(KEY, next);
  } catch {
    // 存储失败只是未读不再持久化
  }
  return next;
}

export function isSessionUnseen(
  session: { id: string; updatedAt?: string | number | null },
  lastSeen: LastSeenMap,
): boolean {
  if (!session.updatedAt) return false;
  const updated = new Date(session.updatedAt).toISOString();
  const seen = lastSeen[session.id];
  return !seen || updated > seen;
}
