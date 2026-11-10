// 指挥台页(openspec: add-mp-command-center,小程序侧)。远程指挥的第一屏:
// 什么在等我处理(待答问询)、什么出了问题(任务异常)、最近完成了什么。
// 数据来自 GET /api/mp/command-summary(实例内聚合,内存快照——重启后空态
// 是诚实事实);老 cell 无此端点时整页降级为提示。跳转关系:问询→对应会话
// (chat 深链 ?id=),任务异常/近期完成→定时任务页。小程序无 i18n 运行时,
// 按约定直接用中文字面量。

import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import PageHeader from "@/components/PageHeader";
import {
  COMMAND_SUMMARY_ABSENT,
  fetchCommandSummary,
  type CommandSummary,
} from "@/lib/command";

const STATE_TEXT: Record<string, string> = { failed: "失败", interrupted: "已中断" };

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export default function CommandPage() {
  const [summary, setSummary] = useState<CommandSummary | null>(null);
  const [absent, setAbsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchCommandSummary();
      if (r === COMMAND_SUMMARY_ABSENT) {
        setAbsent(true);
        setSummary(null);
      } else {
        setAbsent(false);
        setSummary(r);
      }
    } catch (e) {
      setError((e as Error).message || "读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 每次进入页面重拉——指挥快照的生命周期就是"此刻"。
  useDidShow(() => {
    void load();
  });

  const pending = summary?.pendingQuestions ?? [];
  const attention = summary?.jobs.attention ?? [];
  const recentDone = summary?.jobs.recentDone ?? [];

  return (
    <View className="command-page" data-testid="mp-command-page">
      <PageHeader title="指挥台" />
      <View className="command-toolbar">
        <Text className="cron-count">
          {summary ? `任务 ${summary.jobs.counts.active} 活跃 · ${summary.jobs.counts.paused} 暂停` : ""}
        </Text>
        <Text className="picker-link" onClick={() => void load()}>
          刷新
        </Text>
      </View>

      {loading && !summary ? (
        <View className="sessions-loading">
          <Text>读取中…</Text>
        </View>
      ) : null}

      {absent ? (
        <View className="sessions-empty">
          <Text>此部署版本暂无指挥台,等实例升级后自动亮起</Text>
        </View>
      ) : null}

      {error ? (
        <View className="sessions-empty">
          <Text>{error}</Text>
        </View>
      ) : null}

      {summary ? (
        <ScrollView scrollY className="command-list">
          <View className="command-section" data-testid="mp-command-pending">
            <Text className="command-section-title">
              待答问询 {pending.length > 0 ? `(${pending.length})` : ""}
            </Text>
            {pending.length === 0 ? (
              <Text className="command-empty">无等待中的问询</Text>
            ) : (
              pending.map((p) => (
                <View
                  key={p.askId}
                  className="command-card"
                  data-testid="mp-command-pending-item"
                  onClick={() => Taro.navigateTo({ url: `/pages/chat/index?id=${p.sessionId}` })}
                >
                  <View className="command-card-head">
                    <Text className="cron-chip cron-chip-running">等待答复</Text>
                    <Text className="command-card-title">{p.sessionTitle ?? p.sessionId}</Text>
                  </View>
                  {p.questions.slice(0, 2).map((q, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: question list is a snapshot, never reorders
                    <Text key={i} className="command-card-line">
                      {q.question ?? ""}
                    </Text>
                  ))}
                </View>
              ))
            )}
          </View>

          <View className="command-section" data-testid="mp-command-attention">
            <Text className="command-section-title">
              任务异常 {attention.length > 0 ? `(${attention.length})` : ""}
            </Text>
            {attention.length === 0 ? (
              <Text className="command-empty">无失败或中断的任务</Text>
            ) : (
              attention.map((j) => (
                <View
                  key={j.id}
                  className="command-card"
                  data-testid="mp-command-attention-item"
                  onClick={() => Taro.navigateTo({ url: "/pages/cron/index" })}
                >
                  <View className="command-card-head">
                    <Text className={`cron-chip ${j.state === "failed" ? "cron-chip-failed" : "cron-chip-interrupted"}`}>
                      {STATE_TEXT[j.state] ?? j.state}
                    </Text>
                    <Text className="command-card-title">{j.title}</Text>
                  </View>
                  {j.error ? <Text className="cron-card-error">{j.error}</Text> : null}
                  {j.lastRun ? <Text className="command-card-line">{timeAgo(j.lastRun)}</Text> : null}
                </View>
              ))
            )}
          </View>

          <View className="command-section" data-testid="mp-command-recent">
            <Text className="command-section-title">近期完成</Text>
            {recentDone.length === 0 ? (
              <Text className="command-empty">暂无完成的任务</Text>
            ) : (
              recentDone.map((d) => (
                <View
                  key={`${d.jobId}-${d.time}`}
                  className="command-card"
                  onClick={() => Taro.navigateTo({ url: "/pages/cron/index" })}
                >
                  <View className="command-card-head">
                    <Text className="cron-chip cron-chip-completed">完成</Text>
                    <Text className="command-card-title">{d.title}</Text>
                  </View>
                  <Text className="command-card-line">
                    {timeAgo(d.time)}
                    {d.duration ? ` · ${Math.round(d.duration / 1000)}s` : ""}
                  </Text>
                </View>
              ))
            )}
          </View>
          <View className="msg-bottom" />
        </ScrollView>
      ) : null}
    </View>
  );
}
