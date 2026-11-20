// 智语房间列表（openspec: add-zhiyu-mobile-clients 4.1）。只做「进房」：
// 列表是只读的；重交互在房间页以一次性链接交给 web（5.1）。

import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { palette } from "@/components/palette";
import { listRooms, type ZhiyuRoomSummary } from "@/lib/zhiyu-api";

function relative(ts: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return t("zhiyu.justNow");
  if (diff < 3_600_000) return t("zhiyu.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("zhiyu.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  return t("zhiyu.daysAgo", { count: Math.floor(diff / 86_400_000) });
}

export default function ZhiyuListScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [rooms, setRooms] = useState<ZhiyuRoomSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRooms(await listRooms());
      setError(null);
    } catch (err) {
      setError((err as Error).message || t("zhiyu.loadFailed"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);
  // Returning from a room must show the new activity, not a stale list.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: palette.paper, paddingTop: insets.top }}>
      <Text style={{ fontSize: 20, fontWeight: "600", color: palette.ink, paddingHorizontal: 16, paddingVertical: 12 }}>
        {t("tabs.zhiyu")}
      </Text>
      {error ? (
        <Text testID="app-zy-list-error" onPress={() => void load()} style={{ color: palette.danger, paddingHorizontal: 16 }}>
          {error}
        </Text>
      ) : null}
      <FlatList
        testID="app-zy-list"
        data={rooms}
        keyExtractor={(r) => r.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
        ListEmptyComponent={
          !loading ? (
            <Text testID="app-zy-list-empty" style={{ color: palette.muted, padding: 16 }}>
              {t("zhiyu.emptyList")}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            testID={`app-zy-room-${item.id}`}
            onPress={() => router.push({ pathname: "/(tabs)/zhiyu/[roomId]", params: { roomId: item.id } })}
            style={{ paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: palette.line }}
          >
            <Text style={{ fontSize: 16, color: palette.ink }}>{item.title || t("zhiyu.untitled")}</Text>
            <Text style={{ fontSize: 12, color: palette.muted, marginTop: 4 }}>
              {item.status === "active" ? t("zhiyu.active") : t("zhiyu.ended")} · {relative(item.lastActivityAt, t)}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}
