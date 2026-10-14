// The three-tab shell: 对话 / 定时任务 / 资源库 (grill decision Q5 — native
// tab idiom instead of the mini program's chat-only home). The pairing gate
// redirects here pre-pairing, so tabs never render without an instance.

import { Tabs, Redirect } from "expo-router";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { palette } from "@/components/palette";
import { useAppStore } from "@/store/app-store";

function TabIcon({ glyph, focused }: { glyph: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 18, textAlign: "center", color: focused ? palette.primary : palette.muted }}>
      {glyph}
    </Text>
  );
}

export default function TabsLayout() {
  const { t } = useTranslation();
  const paired = useAppStore((s) => Boolean(s.baseUrl && s.token));
  if (!paired) return <Redirect href="/pair" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.muted,
        tabBarStyle: { backgroundColor: palette.paper },
        tabBarLabelStyle: { fontSize: 11 },
      }
      }
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("tabs.chat"),
          tabBarIcon: ({ focused }) => <TabIcon glyph="◎" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="cron"
        options={{
          title: t("tabs.cron"),
          tabBarIcon: ({ focused }) => <TabIcon glyph="⏱" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="resources"
        options={{
          title: t("tabs.resources"),
          tabBarIcon: ({ focused }) => <TabIcon glyph="▦" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
