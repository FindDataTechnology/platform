// 对话内委派任务卡片(spec: agent-delegation-tools)。delegate_task 工具调用
// 渲染为卡片——实时生命周期状态——而不是原始工具输出。任务 id 从工具结果
// 文本的 "- id: <id>" 行解析;实时状态来自共享 cron store(cron_status 广播,
// manual 触发的任务骑同一事件面)。MP 降级形态:状态 + persona + 摘要。

import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCronStore, type Block, type CronJob } from "@platform/core";
import { wsSend } from "@/lib/runtime";

const TASK_ID_FROM_RESULT = /- id:\s*(\S+)/;

const STATE_LABEL: Record<NonNullable<CronJob["state"]>, string> = {
  queued: "排队中",
  running: "运行中",
  done: "成功",
  failed: "失败",
  interrupted: "已中断",
};

export function DelegationCard({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const jobs = useCronStore((s) => s.jobs);
  const { args, state, result } = block;

  const resultText = typeof result === "string" ? result : "";
  const taskId = TASK_ID_FROM_RESULT.exec(resultText)?.[1] ?? null;
  const task = taskId ? jobs.find((j) => j.id === taskId) ?? null : null;
  const a = (args ?? {}) as { persona?: string; prompt?: string };
  const persona = task?.target?.ref ?? a.persona ?? "";
  const prompt = task?.prompt ?? a.prompt ?? "";

  const open = () => {
    if (!task?.sessionId) return;
    wsSend({ type: "switch_session", id: task.sessionId });
    Taro.navigateTo({ url: `/pages/chat/index?id=${task.sessionId}` });
  };

  return (
    <View className="blk blk-cron-card" data-testid="mp-task-card" data-task-id={taskId ?? undefined}>
      <View className="blk-cron-head">
        <Text className="blk-cron-title">👥 委派任务</Text>
        <Text className="blk-cron-schedule">{persona}</Text>
      </View>
      {state === "done" ? (
        <>
          <Text className="blk-cron-prompt">{prompt}</Text>
          <View className="blk-cron-actions">
            <Text className="blk-cron-status" data-testid="mp-task-card-state">
              {task?.state ? STATE_LABEL[task.state] : "排队中"}
            </Text>
            {task?.sessionId ? (
              <Text className="blk-cron-btn" onClick={open}>
                产出
              </Text>
            ) : null}
          </View>
          {task?.error ? <Text className="blk-cron-status">{task.error}</Text> : null}
        </>
      ) : (
        <Text className="blk-cron-status">委派中…</Text>
      )}
    </View>
  );
}
