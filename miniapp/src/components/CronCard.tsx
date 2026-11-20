// 对话内定时任务卡片(spec: agent-scheduling-tools)。agent 通过工具创建的
// 任务渲染为卡片——带实时状态与暂停/删除操作——而不是原始工具输出。
// 任务 id 从工具结果文本的 "- id: <id>" 行解析;实时状态来自共享 cron store
// (cron_status 广播)。store 里还没有记录时,仅展示本次调用的静态信息。

import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCronStore, type Block, type CronJob } from "@platform/core";
import { describeJobSchedule } from "@/lib/cron-text";
import { wsSend } from "@/lib/runtime";

const JOB_ID_FROM_RESULT = /- id:\s*(\S+)/;

const STATUS_LABEL: Record<CronJob["status"], string> = {
  scheduled: "已排程",
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  expired: "已过期",
  error: "错误",
  manual: "委派",
};

export function CronCard({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const jobs = useCronStore((s) => s.jobs);
  const { args, state, result } = block;

  const resultText = typeof result === "string" ? result : "";
  const jobId = JOB_ID_FROM_RESULT.exec(resultText)?.[1] ?? null;
  const job = jobId ? jobs.find((j) => j.id === jobId) ?? null : null;
  const a = (args ?? {}) as { cron?: string; when?: string; prompt?: string; tz?: string | null };
  const shape = job ?? {
    type: (a.cron ? "recurring" : "once") as CronJob["type"],
    cron: a.cron ?? null,
    when: a.when ?? null,
    prompt: a.prompt ?? "",
    tz: a.tz ?? null,
  };

  const toggle = () => {
    if (!job) return;
    wsSend(job.paused ? { type: "cron_resume", jobId: job.id } : { type: "cron_pause", jobId: job.id });
  };

  const del = () => {
    if (!job) return;
    Taro.showModal({
      title: "删除定时任务",
      content: "删除后不再运行,确定删除?",
      success: (r) => {
        if (r.confirm) wsSend({ type: "cron_remove", jobId: job.id });
      },
    });
  };

  return (
    <View className="blk blk-cron-card" data-testid="mp-cron-card">
      <View className="blk-cron-head">
        <Text className="blk-cron-title">⏰ 定时任务</Text>
        <Text className="blk-cron-schedule">{describeJobSchedule(shape)}</Text>
      </View>
      {state === "done" ? (
        <>
          <Text className="blk-cron-prompt">{shape.prompt}</Text>
          {job ? (
            <View className="blk-cron-actions">
              <Text className="blk-cron-status">
                {job.paused ? "已暂停" : STATUS_LABEL[job.status]}
                {job.preset ? ` · ${job.preset}` : ""}
              </Text>
              <Text className="blk-cron-btn" onClick={toggle}>
                {job.paused ? "恢复" : "暂停"}
              </Text>
              <Text className="blk-cron-btn blk-cron-danger" onClick={del}>
                删除
              </Text>
            </View>
          ) : (
            <Text className="blk-cron-status">已创建 · 详情见任务页</Text>
          )}
        </>
      ) : (
        <Text className="blk-cron-status">创建中…</Text>
      )}
    </View>
  );
}
