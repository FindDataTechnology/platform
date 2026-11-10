// 问询卡片（add-user-questions）：ask_user_question 工具块的小程序呈现。
//
// 挂起=交互卡（选项按钮/多选/卡内自定义输入/取消），与 web 端交互完全对
// 齐；解决=静态摘要（答案/取消/失败），历史回放渲染同一形态、永非交互。
// 状态取共享 core 的 pendingQuestion 切片；提交/取消经 runtime 的
// wsSend 发 answer_question。多端先答先得：他端先答时本卡随 tool_end
// 收敛为摘要。

import { useState } from "react";
import { Input, Text, View } from "@tarojs/components";
import { useChatStore, type AskAnswerItem, type AskQuestionItem, type Block } from "@platform/core";
import { wsSend } from "@/lib/runtime";

type ToolBlockModel = Extract<Block, { kind: "tool" }>;

// 归一化两种来源的问题形状：pending 载荷（camelCase，直出 seam）与持久化
// 工具参数（模型面 multi_select）。
function normalizeQuestion(raw: Record<string, unknown> | null | undefined): AskQuestionItem | null {
  if (!raw || typeof raw.id !== "string" || typeof raw.question !== "string") return null;
  const multiSelect =
    (raw as { multiSelect?: unknown }).multiSelect ?? (raw as { multi_select?: unknown }).multi_select;
  return {
    id: raw.id,
    question: raw.question,
    ...(typeof raw.header === "string" ? { header: raw.header } : {}),
    ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
    ...(Array.isArray(raw.options) ? { options: raw.options as AskQuestionItem["options"] } : {}),
    ...(multiSelect === true ? { multiSelect: true } : {}),
  };
}

function questionsOfArgs(args: unknown): AskQuestionItem[] {
  const list = (args as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return [];
  return list.map((q) => normalizeQuestion(q as Record<string, unknown>)).filter((q) => q !== null);
}

export function QuestionCard({ block }: { block: ToolBlockModel }) {
  const pending = useChatStore((s) => s.pendingQuestion);
  // 与 web 同一绑定：锚定到 ask 锚定的块；锚缺失时回退到唯一运行中的问询块。
  const isPending =
    block.state === "running" &&
    pending !== null &&
    (pending.toolCallId === block.id || pending.toolCallId === undefined);
  const questions = isPending ? pending.questions : questionsOfArgs(block.args);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [customs, setCustoms] = useState<Record<string, string>>({});

  const toggle = (q: AskQuestionItem, label: string) => {
    setSelected((prev) => {
      const current = prev[q.id] ?? [];
      if (q.multiSelect === true) {
        return {
          ...prev,
          [q.id]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label],
        };
      }
      return { ...prev, [q.id]: current.includes(label) ? [] : [label] };
    });
  };

  const answersOf = (): AskAnswerItem[] | null => {
    const out: AskAnswerItem[] = [];
    for (const q of questions) {
      const sel = selected[q.id] ?? [];
      const custom = (customs[q.id] ?? "").trim();
      if (sel.length === 0 && !custom) return null;
      out.push({ id: q.id, selected: sel, ...(custom ? { custom } : {}) });
    }
    return out.length > 0 ? out : null;
  };

  const submit = () => {
    const answers = answersOf();
    if (!isPending || answers === null) return;
    wsSend({ type: "answer_question", askId: pending.askId, answers });
  };
  const cancel = () => {
    if (!isPending) return;
    wsSend({ type: "answer_question", askId: pending.askId, cancelled: true });
  };

  // ── 解决态：静态摘要（含历史回放） ───────────────────────────────────────
  if (!isPending) {
    let rows: AskAnswerItem[] | null = null;
    if (typeof block.result === "string") {
      try {
        const parsed = JSON.parse(block.result) as { answers?: unknown };
        if (Array.isArray(parsed.answers)) rows = parsed.answers as AskAnswerItem[];
      } catch {
        /* 非结构化结果按失败/取消原文展示 */
      }
    }
    return (
      <View className={`blk-qc blk-qc-${block.state === "error" ? "error" : "done"}`}>
        <View className="blk-qc-head">
          <Text className="blk-qc-title">{block.state === "error" ? "问询已取消" : "问询已作答"}</Text>
          {block.state === "error" && typeof block.result === "string" ? (
            <Text className="blk-qc-sub">{block.result}</Text>
          ) : null}
        </View>
        {rows && rows.length > 0 ? (
          <View className="blk-qc-rows">
            {rows.map((row) => {
              const q = questions.find((x) => x.id === row.id);
              return (
                <View key={row.id} className="blk-qc-row">
                  <Text className="blk-qc-row-q">{q?.question ?? row.id}</Text>
                  <Text className="blk-qc-row-a">
                    {row.selected.join("、") || "自定义回答"}
                    {row.custom ? `：${row.custom}` : ""}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}
      </View>
    );
  }

  // ── 挂起态：交互卡 ────────────────────────────────────────────────────────
  const canSubmit = answersOf() !== null;
  return (
    <View className="blk-qc blk-qc-pending">
      <View className="blk-qc-head">
        <Text className="blk-qc-title">需要你的确认</Text>
        <Text className="blk-qc-sub">回答后对话继续</Text>
      </View>
      {questions.map((q) => {
        const sel = selected[q.id] ?? [];
        return (
          <View key={q.id} className="blk-qc-item">
            {q.header ? <Text className="blk-qc-item-header">{q.header}</Text> : null}
            <Text className="blk-qc-item-q">{q.question}</Text>
            {q.detail ? <Text className="blk-qc-item-detail">{q.detail}</Text> : null}
            {q.options && q.options.length > 0 ? (
              <View className="blk-qc-options">
                {q.options.map((o) => (
                  <Text
                    key={o.label}
                    className={`blk-qc-option${sel.includes(o.label) ? " blk-qc-option-on" : ""}`}
                    onClick={() => toggle(q, o.label)}
                  >
                    {o.label}
                  </Text>
                ))}
              </View>
            ) : null}
            <Input
              className="blk-qc-input"
              value={customs[q.id] ?? ""}
              placeholder="或输入自定义回答…"
              onInput={(e) => setCustoms((prev) => ({ ...prev, [q.id]: e.detail.value }))}
            />
          </View>
        );
      })}
      <View className="blk-qc-actions">
        <Text className="blk-qc-cancel" onClick={cancel}>
          取消问询
        </Text>
        <Text className={`blk-qc-submit${canSubmit ? "" : " blk-blk-qc-submit-off"}`} onClick={() => canSubmit && submit()}>
          提交回答
        </Text>
      </View>
    </View>
  );
}
