// 定时任务管理页(spec: scheduled-tasks-ui,小程序侧)。列表 + 新建表单 +
// 任务操作,数据来自共享 cron store(socket 事件驱动);新建/操作走 WS 消息。
// 任务产出通过 chat-history REST 内联查看(与会话页同一只读查看器模式)。
// 小程序无 i18n 运行时,按约定直接用中文字面量。

import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Picker, ScrollView, Text, Textarea, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import {
  getChatSession,
  useChatStore,
  useCronStore,
  type ChatMessage,
  type CronJob,
} from "@platform/core";
import { Markdown } from "@/components/Markdown";
import PageHeader from "@/components/PageHeader";
import { describeJobSchedule, formatInJobTz } from "@/lib/cron-text";
import { runtime, wsSend } from "@/lib/runtime";

type Freq = "daily" | "weekly" | "custom";
type Mode = "recurring" | "once";

const STATUS_LABEL: Record<CronJob["status"], string> = {
  scheduled: "已排程",
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  expired: "已过期",
  error: "错误",
  manual: "委派",
};

// 执行生命周期文案(任务引擎):排队中/运行中/失败/已中断优先于排程状态。
const STATE_LABEL: Record<NonNullable<CronJob["state"]>, string> = {
  queued: "排队中",
  running: "运行中",
  done: "成功",
  failed: "失败",
  interrupted: "已中断",
};

// 徽章优先级:暂停是显式动作;进行中/失败/中断的执行盖过排程状态;"成功"
// 落回排程徽章(成功与否由"上次运行"一行表达)。
function chipKey(job: CronJob): string {
  if (job.paused) return "paused";
  if (job.state === "queued" || job.state === "running" || job.state === "failed" || job.state === "interrupted") {
    return job.state;
  }
  return job.status;
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

function lastRunText(job: CronJob): string {
  const last = job.history[job.history.length - 1];
  if (!last) return "从未运行";
  if (last.success === null && last.missed) return `停机错过 ${last.missed} 次`;
  if (last.success) return "上次成功";
  return `上次失败${last.error ? `:${last.error}` : ""}`;
}

function JobCard({ job, onView }: { job: CronJob; onView: (sessionId: string) => void }) {
  const chip = chipKey(job);
  const chipLabel =
    chip === "paused" ? "已暂停" : STATE_LABEL[chip as NonNullable<CronJob["state"]>] ?? STATUS_LABEL[chip as CronJob["status"]];
  const rerunnable = job.state === "failed" || job.state === "interrupted";

  const del = () => {
    Taro.showModal({
      title: "删除任务",
      content: "删除后不再运行,确定删除?",
      success: (r) => {
        if (r.confirm) wsSend({ type: "cron_remove", jobId: job.id });
      },
    });
  };

  return (
    <View
      className="cron-card"
      data-testid="mp-cron-job"
      data-job-id={job.id}
      data-job-status={job.status}
      data-job-state={job.state ?? ""}
    >
      <View className="cron-card-head">
        <Text className={`cron-chip cron-chip-${chip}`}>{chipLabel}</Text>
        <Text className="cron-card-trigger">定时</Text>
        <Text className="cron-card-schedule">{describeJobSchedule(job)}</Text>
      </View>
      <Text className="cron-card-prompt">{job.prompt}</Text>
      {(job.state === "failed" || job.state === "interrupted") && job.error ? (
        <Text className="cron-card-error">{job.error}</Text>
      ) : null}
      <View className="cron-card-meta">
        {(job.target?.ref ?? job.preset) ? <Text className="cron-card-meta-item">{job.target?.ref ?? job.preset}</Text> : null}
        {job.nextRun ? (
          <Text className="cron-card-meta-item">下次 {formatInJobTz(job.nextRun, job.tz)}</Text>
        ) : null}
        <Text className="cron-card-meta-item">{lastRunText(job)}</Text>
        {job.missed > 0 ? <Text className="cron-card-meta-item">累计错过 {job.missed} 次</Text> : null}
      </View>
      <View className="cron-card-actions">
        {job.sessionId ? (
          <Text className="cron-card-btn" onClick={() => onView(job.sessionId!)}>
            产出
          </Text>
        ) : null}
        <Text
          className="cron-card-btn"
          data-testid={rerunnable ? "mp-cron-job-rerun" : "mp-cron-job-run"}
          onClick={() => wsSend({ type: "cron_run", jobId: job.id })}
        >
          {rerunnable ? "重新运行" : "立即运行"}
        </Text>
        <Text
          className="cron-card-btn"
          onClick={() =>
            wsSend(job.paused ? { type: "cron_resume", jobId: job.id } : { type: "cron_pause", jobId: job.id })
          }
        >
          {job.paused ? "恢复" : "暂停"}
        </Text>
        <Text className="cron-card-btn cron-card-danger" onClick={del}>
          删除
        </Text>
      </View>
    </View>
  );
}

export default function CronPage() {
  const jobs = useCronStore((s) => s.jobs);
  const lastError = useCronStore((s) => s.lastError);
  const lastAdded = useCronStore((s) => s.lastAdded);
  const clearError = useCronStore((s) => s.clearError);
  const presets = useChatStore((s) => s.presets);
  const currentPreset = useChatStore((s) => s.currentPreset);
  const status = useChatStore((s) => s.status);

  const [formOpen, setFormOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("recurring");
  const [freq, setFreq] = useState<Freq>("daily");
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [cronExpr, setCronExpr] = useState("");
  const [date, setDate] = useState("");
  const [whenTime, setWhenTime] = useState("09:00");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [agentIdx, setAgentIdx] = useState(-1);
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [localError, setLocalError] = useState<string | null>(null);
  // 创建确认(harden):表单保持打开、字段保留,直到服务器的 cron_added
  // 确认或 cron_error 拒绝;8 秒无回应用超时兜底。乐观关闭曾把拒绝藏在
  // 一个刚刚收起的表单里。
  const [pending, setPending] = useState(false);
  const pendingAtRef = useRef(0);
  // 内联产出查看器(REST)
  const [viewing, setViewing] = useState<{ title?: string; messages: ChatMessage[] } | null>(null);

  useEffect(() => {
    if (!pending) return;
    if (lastAdded && lastAdded.at >= pendingAtRef.current) {
      setPending(false);
      setPrompt("");
      setName("");
      setFormOpen(false);
      Taro.showToast({ title: "任务已创建", icon: "none" });
    } else if (lastError?.action === "cron_add") {
      setPending(false);
      setLocalError(lastError.message);
      clearError();
    }
    const timer = setTimeout(() => {
      setPending(false);
      setLocalError("服务器未确认，请检查连接后重试");
    }, 8000);
    return () => clearTimeout(timer);
  }, [pending, lastAdded, lastError, clearError]);

  useEffect(() => {
    void runtime.boot();
  }, []);

  const usablePresets = useMemo(() => presets.filter((p) => !p.broken), [presets]);
  const agent = agentIdx >= 0 && usablePresets[agentIdx] ? usablePresets[agentIdx].id : currentPreset || "";

  const today = useMemo(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }, []);

  const submit = () => {
    if (pending) return;
    setLocalError(null);
    clearError();
    if (!prompt.trim()) {
      setLocalError("请填写提示词");
      return;
    }
    let expr: string | undefined;
    let iso: string | undefined;
    if (mode === "recurring") {
      const [h, m] = time.split(":");
      if (freq === "daily") expr = `${m || "0"} ${h || "0"} * * *`;
      else if (freq === "weekly") {
        if (!weekdays.length) {
          setLocalError("至少选择一个星期");
          return;
        }
        expr = `${m || "0"} ${h || "0"} * * ${[...weekdays].sort().join(",")}`;
      } else {
        if (!cronExpr.trim()) {
          setLocalError("请填写 cron 表达式");
          return;
        }
        expr = cronExpr.trim();
      }
    } else {
      if (!date) {
        setLocalError("请选择日期");
        return;
      }
      iso = new Date(`${date}T${whenTime}`).toISOString();
    }
    const sent = wsSend({
      type: "cron_add",
      cron: expr,
      when: iso,
      prompt: prompt.trim(),
      preset: agent || null,
      tz: tz.trim() || null,
      sessionTitle: name.trim() || null,
    });
    if (!sent) {
      // The runtime already toasted; the inline error keeps the open form
      // honest about WHY the button did nothing.
      setLocalError("未连接，无法创建任务");
      return;
    }
    pendingAtRef.current = Date.now();
    setPending(true);
  };

  const viewSession = async (sessionId: string) => {
    try {
      const session = await getChatSession(sessionId);
      setViewing({ title: session.title, messages: session.messages });
    } catch (e) {
      Taro.showToast({ title: (e as Error).message || "读取失败", icon: "none" });
    }
  };

  if (viewing) {
    return (
      <View className="cron-page">
        <PageHeader title={viewing.title || "任务产出"} onBack={() => setViewing(null)} />
        <ScrollView scrollY className="sessions-detail">
          {viewing.messages.map((m, i) =>
            m.role === "user" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: task output history is append-only and never reorders
              <View key={i} className="turn turn-user">
                <Text className="turn-user-text" selectable userSelect>
                  {m.content}
                </Text>
              </View>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: task output history is append-only and never reorders
              <View key={i} className="turn turn-assistant">
                <View className="blk blk-text">
                  <Markdown text={m.content} />
                </View>
              </View>
            ),
          )}
          <View className="msg-bottom" />
        </ScrollView>
      </View>
    );
  }

  const errorText = localError ?? (lastError?.action === "cron_add" ? lastError.message : null);

  return (
    <View className="cron-page" data-testid="mp-cron-page">
      <PageHeader title="定时任务" />
      <View className="cron-toolbar">
        <Text className="cron-count">共 {jobs.length} 个任务</Text>
        <Text className="picker-link" onClick={() => setFormOpen((v) => !v)}>
          {formOpen ? "收起" : "新建任务"}
        </Text>
      </View>

      {status !== "connected" ? (
        <View className="sessions-loading">
          <Text>{status === "connecting" ? "连接中…" : "未连接,任务列表需要连接"}</Text>
        </View>
      ) : null}

      {formOpen ? (
        <View className="cron-form" data-testid="mp-cron-form">
          <View className="cron-form-row">
            <Text className={`cron-seg ${mode === "recurring" ? "cron-seg-on" : ""}`} onClick={() => setMode("recurring")}>
              周期
            </Text>
            <Text className={`cron-seg ${mode === "once" ? "cron-seg-on" : ""}`} onClick={() => setMode("once")}>
              单次
            </Text>
          </View>

          {mode === "recurring" ? (
            <>
              <View className="cron-form-row">
                {(["daily", "weekly", "custom"] as Freq[]).map((f) => (
                  <Text key={f} className={`cron-seg ${freq === f ? "cron-seg-on" : ""}`} onClick={() => setFreq(f)}>
                    {f === "daily" ? "每天" : f === "weekly" ? "每周" : "自定义"}
                  </Text>
                ))}
              </View>
              {freq === "weekly" ? (
                <View className="cron-form-row">
                  {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                    <Text
                      key={d}
                      className={`cron-day ${weekdays.includes(d) ? "cron-day-on" : ""}`}
                      onClick={() =>
                        setWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]))
                      }
                    >
                      {WEEKDAY_LABELS[d]}
                    </Text>
                  ))}
                </View>
              ) : null}
              {freq === "custom" ? (
                <Input
                  className="cron-input"
                  placeholder="cron 表达式,如 */15 * * * *"
                  value={cronExpr}
                  onInput={(e) => setCronExpr(e.detail.value)}
                />
              ) : (
                <Picker mode="time" value={time} onChange={(e) => setTime(e.detail.value)}>
                  <View className="cron-input cron-picker">
                    <Text>时间 {time}</Text>
                  </View>
                </Picker>
              )}
            </>
          ) : (
            <View className="cron-form-row">
              <Picker mode="date" start={today} value={date || today} onChange={(e) => setDate(e.detail.value)}>
                <View className="cron-input cron-picker">
                  <Text>{date || "选择日期"}</Text>
                </View>
              </Picker>
              <Picker mode="time" value={whenTime} onChange={(e) => setWhenTime(e.detail.value)}>
                <View className="cron-input cron-picker">
                  <Text>{whenTime}</Text>
                </View>
              </Picker>
            </View>
          )}

          <Input
            className="cron-input"
            placeholder="名称(可选)——将作为会话标题"
            value={name}
            onInput={(e) => setName(e.detail.value)}
          />
          {usablePresets.length > 0 ? (
            <Picker
              mode="selector"
              range={usablePresets.map((p) => p.name)}
              value={Math.max(0, usablePresets.findIndex((p) => p.id === agent))}
              onChange={(e) => setAgentIdx(Number(e.detail.value))}
            >
              <View className="cron-input cron-picker">
                <Text>智能体 {usablePresets.find((p) => p.id === agent)?.name ?? usablePresets[0]?.name}</Text>
              </View>
            </Picker>
          ) : null}
          <Textarea
            className="cron-textarea"
            placeholder="智能体在这个时间要做什么?"
            value={prompt}
            onInput={(e) => setPrompt(e.detail.value)}
            maxlength={2000}
          />
          <View className="cron-form-row cron-tz-row">
            <Text className="cron-tz-label">时区</Text>
            <Input className="cron-input cron-tz-input" value={tz} onInput={(e) => setTz(e.detail.value)} />
          </View>
          {errorText ? (
            <Text className="cron-error" data-testid="mp-cron-form-error">
              {errorText}
            </Text>
          ) : null}
          <Text
            className={`cron-submit${pending ? " cron-submit-disabled" : ""}`}
            onClick={submit}
            data-testid="mp-cron-submit"
          >
            {pending ? "创建中…" : "创建任务"}
          </Text>
        </View>
      ) : null}

      <ScrollView scrollY className="cron-list">
        {jobs.length === 0 && !formOpen ? (
          <View className="sessions-empty">
            <Text>还没有定时任务</Text>
          </View>
        ) : (
          jobs.map((job) => <JobCard key={job.id} job={job} onView={(id) => void viewSession(id)} />)
        )}
        <View className="msg-bottom" />
      </ScrollView>
    </View>
  );
}
