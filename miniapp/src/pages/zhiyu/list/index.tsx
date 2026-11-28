// 智语房间列表（openspec: add-zhiyu-mobile-clients 3.1）。只做「进房」：
// 列表是只读的，重交互（邀请/私窗/订阅/设置）一律由房间页交给 web 的一次性链接。
//
// 与 web 同一批端点、同一批字段；这里没有任何「移动版」字段。

import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import PageHeader from "@/components/PageHeader";
import { listRooms, type ZhiyuRoomSummary } from "@/lib/zhiyu-api";

function relativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export default function ZhiyuListPage() {
  const [rooms, setRooms] = useState<ZhiyuRoomSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await listRooms();
      setRooms(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message || "读取房间失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Coming back from a room must show the room's new activity, not a stale list.
  useDidShow(() => {
    void load();
  });

  const open = (room: ZhiyuRoomSummary) => {
    void Taro.navigateTo({ url: `/pages/zhiyu/room/index?roomId=${encodeURIComponent(room.id)}` });
  };

  return (
    <View data-testid="mp-zhiyu-list" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <PageHeader title="智语" />
      <ScrollView scrollY style={{ flex: 1, minHeight: 0, padding: "12px 16px" }}>
        {loading ? (
          <Text data-testid="mp-zhiyu-list-loading" style={{ color: "var(--muted-foreground, #888)" }}>
            正在读取…
          </Text>
        ) : null}
        {error ? (
          <Text data-testid="mp-zhiyu-list-error" style={{ color: "#c0392b" }} onClick={() => void load()}>
            {error}（点此重试）
          </Text>
        ) : null}
        {!loading && !error && rooms.length === 0 ? (
          <Text data-testid="mp-zhiyu-list-empty" style={{ color: "var(--muted-foreground, #888)" }}>
            还没有房间。在电脑上创建后，这里就会出现。
          </Text>
        ) : null}
        {rooms.map((room) => (
          <View
            key={room.id}
            data-testid={`mp-zhiyu-room-item-${room.id}`}
            onClick={() => open(room)}
            style={{
              padding: "12px 4px",
              borderBottom: "1px solid var(--border, #eee)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <View style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: "16px" }}>{room.title || "未命名空间"}</Text>
              <Text style={{ fontSize: "12px", color: "var(--muted-foreground, #888)" }}>
                {room.status === "active" ? "进行中" : "已结束"} · {relativeTime(room.lastActivityAt)}
              </Text>
            </View>
            <Text style={{ color: "var(--muted-foreground, #888)" }}>›</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
