// The history drawer (the ☰ surface, layout refactor 2026-09): everything the
// old sessions page carried, as a half-screen sheet ON the chat page — no
// page navigation, no full-page loading hop. The session list shows 5 rows
// by default with 加载更多 (so a 100-session history can no longer push the
// utility groups out of reach); 我的分享 / 定时任务 / 服务器 stay one tap deep.
// Sheet mechanics mirror SelectionPanel: mask fade, 0.25s slide-up, delayed
// visibility on close. The list fetches over REST on every open, so the
// drawer works while the socket is down (switch_session then toasts via the
// runtime guard and the drawer stays put).

import { useCallback, useEffect, useState } from "react";
import { Input, ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import {
  listChatSessions,
  listShares,
  revokeShare,
  useChatStore,
  useCronStore,
  type SessionMeta,
  type ShareInfo,
} from "@platform/core";
import { baseUrl, setBaseUrl } from "@/lib/config";
import { loadResources, subscribeResources } from "@/lib/resources";
import { runtime } from "@/lib/runtime";
import { getLastSeen, markSessionSeen, isSessionUnseen } from "@/lib/unread";

// First paint shows 5; each 加载更多 reveals 15 more.
const FIRST_PAGE = 5;
const STEP = 15;

function when(meta: SessionMeta): string {
  const raw = meta.updatedAt ?? meta.createdAt;
  if (raw === undefined || raw === null) return "";
  const ms = typeof raw === "number" ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(String(raw));
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Collapsible section (from the retired sessions page): counted pill, blue
// unread badge, body renders on expand. 历史会话 opens by default.
function Group({
  title,
  count,
  badge,
  defaultOpen = false,
  bodyClass = "",
  children,
}: {
  title: string;
  count?: number;
  badge?: boolean;
  defaultOpen?: boolean;
  bodyClass?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View className="grp-sec">
      <View className="grp-sec-hd" onClick={() => setOpen((v) => !v)}>
        {badge ? <View className="session-unread-dot" /> : null}
        <Text className="grp-sec-title">{title}</Text>
        {typeof count === "number" && count > 0 ? <Text className="grp-sec-count">{count}</Text> : null}
        <Text className="grp-sec-caret">{open ? "▾" : "▸"}</Text>
      </View>
      {open ? <View className={`grp-sec-body ${bodyClass}`}>{children}</View> : null}
    </View>
  );
}

export default function HistoryDrawer({
  open,
  onClose,
  onShare,
}: {
  open: boolean;
  onClose: () => void;
  // Creates the share token for a row; the chat page owns shareTokenRef (the
  // forward-card hook reads it). Resolves so the drawer can refresh its
  // 我的分享 list afterwards.
  onShare: (sessionId: string) => Promise<void>;
}) {
  const cronJobs = useCronStore((s) => s.jobs);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [shares, setShares] = useState<ShareInfo[] | null>(null);
  // 资源库入口:旧 cell 没有 /api/resources(404)→ supported:false,整组隐藏。
  const [resources, setResources] = useState<{ supported: boolean; total: number } | null>(null);
  const [view, setView] = useState<{ kind: "idle" | "loading" | "list" | "error"; message?: string }>({
    kind: "idle",
  });
  const [visible, setVisible] = useState(FIRST_PAGE);
  const [lastSeen, setLastSeen] = useState<Record<string, string>>(() => getLastSeen());
  const [serverDraft, setServerDraft] = useState(baseUrl());

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    setVisible(FIRST_PAGE);
    const ready = await runtime.ensureReady();
    if (!ready) {
      setView({ kind: "error", message: "无法连接服务器" });
      return;
    }
    try {
      const [list, shareList, resourcePage] = await Promise.all([
        listChatSessions(),
        listShares().catch(() => [] as ShareInfo[]),
        loadResources({ limit: 1 }),
      ]);
      setSessions(list);
      setShares(shareList);
      setResources({ supported: resourcePage.supported, total: resourcePage.total });
      setView({ kind: "list" });
    } catch (err) {
      setView({ kind: "error", message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // 抽屉开着时资源数保持最新:只刷新计数,不动会话列表(否则翻页/滚动被重置)。
  useEffect(() => {
    if (!open) return;
    return subscribeResources(() => {
      void loadResources({ limit: 1 }).then((r) =>
        setResources({ supported: r.supported, total: r.total }),
      );
    });
  }, [open]);

  const openSession = (id: string) => {
    // A failed switch toasts from the runtime and keeps the drawer up.
    if (!runtime.send({ type: "switch_session", id })) return;
    setLastSeen(markSessionSeen(id));
    onClose();
  };

  const handleRevoke = (token: string) => {
    Taro.showModal({
      title: "撤销分享",
      content: "撤销后已转发的卡片将无法打开，确定撤销？",
      success: (r) => {
        if (r.confirm)
          void revokeShare(token)
            .then(() => {
              setShares((list) => list?.filter((s) => s.token !== token) ?? list);
            })
            .catch((e: Error) => Taro.showToast({ title: e.message || "撤销失败", icon: "none" }));
      },
    });
  };

  const shareRow = async (id: string) => {
    await onShare(id);
    // The new token belongs in 我的分享 — refresh quietly.
    listShares()
      .then((list) => setShares(list))
      .catch(() => {});
  };

  const saveServer = () => {
    const next = serverDraft.trim().replace(/\/+$/, "");
    if (!next) return;
    setBaseUrl(next);
    setServerDraft(next);
    Taro.showToast({ title: "已保存，重连中…", icon: "none" });
    runtime.reconnectNow();
  };

  const unseenCount = sessions.filter(
    (s) => s.id !== currentSessionId && isSessionUnseen(s, lastSeen),
  ).length;
  const shown = sessions.slice(0, visible);
  const hasMore = sessions.length > visible;

  return (
    <View className={`hisd-root${open ? " hisd-root-open" : ""}`}>
      <View className="hisd-mask" onClick={onClose} />
      <View className="hisd-panel" data-testid="mp-history-drawer">
        <View className="hisd-head">
          <Text className="hisd-title">历史</Text>
          <Text className="hisd-close" aria-label="关闭" data-testid="mp-history-close" onClick={onClose}>
            ✕
          </Text>
        </View>

        {view.kind === "loading" ? (
          <View className="hisd-state">
            <Text>加载中…</Text>
          </View>
        ) : null}
        {view.kind === "error" ? (
          <View className="hisd-state hisd-state-error">
            <Text>{view.message}</Text>
            <Text className="hisd-retry" onClick={() => void load()}>
              重试 ›
            </Text>
          </View>
        ) : null}

        {view.kind === "list" ? (
          <ScrollView scrollY className="hisd-scroll">
            <View className="hisd-groups">
              <Group title="历史会话" count={sessions.length} defaultOpen bodyClass="grp-sec-body-bleed">
                {shown.map((s) => (
                  <View
                    key={s.id}
                    className="session-item"
                    data-testid="mp-session-item"
                    data-unseen={isSessionUnseen(s, lastSeen) ? "true" : "false"}
                    onClick={() => openSession(s.id)}
                  >
                    <View className="session-title-row">
                      {isSessionUnseen(s, lastSeen) ? <View className="session-unread-dot" /> : null}
                      <Text className="session-title">{s.title || "未命名会话"}</Text>
                    </View>
                    <View className="session-meta-row">
                      <Text className="session-when">{when(s)}</Text>
                      <Text
                        className="session-share-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          void shareRow(s.id);
                        }}
                      >
                        ↗
                      </Text>
                    </View>
                  </View>
                ))}
                {sessions.length === 0 ? (
                  <View className="sessions-empty">
                    <Text>还没有历史会话</Text>
                  </View>
                ) : null}
                {hasMore ? (
                  <Text
                    className="hisd-more"
                    data-testid="mp-history-more"
                    onClick={() => setVisible((v) => v + STEP)}
                  >
                    加载更多（已显示 {visible}/{sessions.length}）›
                  </Text>
                ) : null}
              </Group>

              <Group title="我的分享" count={shares?.length ?? 0}>
                {shares !== null && shares.length > 0 ? (
                  shares.map((s) => (
                    <View key={s.token} className="share-row">
                      <Text className="share-row-title">{s.title || s.sessionId}</Text>
                      <Text
                        className="share-row-revoke"
                        data-testid="mp-share-revoke"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRevoke(s.token);
                        }}
                      >
                        撤销
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text className="grp-sec-empty">暂无分享链接</Text>
                )}
              </Group>

              {resources?.supported ? (
                <Group title="🗂 我的资源" count={resources.total}>
                  <View
                    className="grp-sec-link"
                    data-testid="mp-resources-entry"
                    onClick={() => Taro.navigateTo({ url: "/pages/resources/index" })}
                  >
                    <Text>打开资源库 ›</Text>
                  </View>
                </Group>
              ) : null}

              <Group title="⏰ 定时任务" count={cronJobs.length} badge={unseenCount > 0}>
                <View className="grp-sec-link" onClick={() => Taro.navigateTo({ url: "/pages/cron/index" })}>
                  <Text>打开定时任务 ›</Text>
                </View>
              </Group>

              <Group title="服务器与高级设置">
                <View className="sessions-server">
                  <Text className="server-label">服务器</Text>
                  <Input
                    className="server-input"
                    value={serverDraft}
                    onInput={(e) => setServerDraft(e.detail.value)}
                    placeholder="http://localhost:3080"
                    placeholderClass="login-placeholder"
                  />
                  <Text className="picker-link" onClick={saveServer}>
                    保存
                  </Text>
                </View>
              </Group>
            </View>
            <View className="msg-bottom" />
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}
