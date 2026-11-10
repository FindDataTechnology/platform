// Shared-session read-only view (openspec: add-session-share). Opened from a
// WeChat forward card with ?token=… — the ONE page that fetches without any
// auth header (the gateway route is public by design). Renders mirrored text
// turns with the same Markdown pipeline as the sessions history viewer.

import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { getSharedSession } from "@platform/core";
import { Markdown } from "@/components/Markdown";
import PageHeader from "@/components/PageHeader";
import { clearToken, enterDemoBase, isDemoBase } from "@/lib/config";
import { recordEmail } from "@/lib/auth";
import { runtime } from "@/lib/runtime";

interface ChatMessage {
  role: string;
  content: string;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; title: string; messages: ChatMessage[] }
  | { kind: "unavailable" };

export default function SharePage() {
  const router = useRouter();
  const token = router.params.token ?? "";
  const [view, setView] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setView({ kind: "unavailable" });
      return;
    }
    getSharedSession(token)
      .then((s) => {
        if (!cancelled) setView({ kind: "ready", title: s.title, messages: s.messages });
      })
      .catch(() => {
        // Revoked/expired/deleted/unknown all land here — one friendly page.
        if (!cancelled) setView({ kind: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // The dead-link page is the product's one touchpoint with outsiders — a
  // prospective user's first contact must not end in a gray line. Same demo
  // entry semantics as the chat welcome's 先体验 (origin switch + re-boot).
  const tryDemo = () => {
    if (!isDemoBase()) enterDemoBase();
    clearToken();
    recordEmail("");
    void runtime.switchBase();
    Taro.reLaunch({ url: "/pages/chat/index" });
  };

  if (view.kind === "unavailable") {
    return (
      <View className="share-page">
        <PageHeader title="FD" />
        <View className="share-unavailable">
          <Text>该共享会话已不可用</Text>
          <Text className="share-unavailable-sub">链接可能已被撤销或过期</Text>
          <Text className="share-demo-link" onClick={tryDemo} data-testid="mp-share-demo-link">
            直接体验 FD 对话 ›
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="share-page">
      <PageHeader title="FD" />
      <View className="share-banner">
        <Text className="share-banner-text">共享会话 · 只读</Text>
      </View>
      {view.kind === "loading" ? (
        <View className="share-loading">
          <Text>加载中…</Text>
        </View>
      ) : (
        <ScrollView scrollY className="share-body">
          {view.title ? <Text className="share-title">{view.title}</Text> : null}
          {view.messages.map((m, i) =>
            m.role === "user" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: share history is append-only and never reorders
              <View key={i} className="turn turn-user">
                <Text className="turn-user-text" selectable userSelect>
                  {m.content}
                </Text>
              </View>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: share history is append-only and never reorders
              <View key={i} className="turn turn-assistant">
                <View className="blk blk-text">
                  <Markdown text={m.content} />
                </View>
              </View>
            ),
          )}
          <View className="msg-bottom" />
        </ScrollView>
      )}
    </View>
  );
}
