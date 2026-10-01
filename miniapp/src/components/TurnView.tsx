// One chat turn: the user message, or the assistant's block sequence
// (text / thinking / tool / skill / command / error).
//
// The streaming rule lives here: a TEXT block renders as plain text while its
// turn is streaming and switches to rendered markdown once the turn closes —
// re-parsing markdown per chunk is the classic mini-program perf trap.
//
// Machinery (thinking / tool / skill / command) folds under ONE activity
// group per consecutive run, collapsed by default, with a plain-language
// header (no tool names). Text and error blocks always render outside. The
// grouping helper and open-state derivation come from @platform/core — the
// exact same derivation the web surface renders.

import Taro from "@tarojs/taro";
import { Text, View } from "@tarojs/components";
import {
  groupHasError,
  groupTurnBlocks,
  isGroupOpen,
  useChatStore,
  type ActivityGroup as ActivityGroupModel,
  type AssistantTurn,
  type Block,
  type Turn,
} from "@platform/core";
import { Markdown } from "./Markdown";
import { CronCard } from "./CronCard";
import { DelegationCard } from "./DelegationCard";

function ToolBlock({ block, onToggle }: { block: Extract<Block, { kind: "tool" }>; onToggle: () => void }) {
  const stateLabel = block.state === "running" ? "运行中" : block.state === "error" ? "失败" : "完成";
  return (
    <View className={`blk blk-tool blk-tool-${block.state}`}>
      <View className="blk-head" onClick={onToggle}>
        <Text className="blk-icon">🔧</Text>
        <Text className="blk-title">{block.name}</Text>
        <Text className={`blk-state blk-state-${block.state}`}>{stateLabel}</Text>
      </View>
      {block.open ? (
        <Text className="blk-pre" selectable userSelect>
          {formatPayload(block.result ?? block.partial ?? block.args)}
        </Text>
      ) : null}
    </View>
  );
}

function formatPayload(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function BlockView({ block, streaming, onToggle }: { block: Block; streaming: boolean; onToggle: () => void }) {
  switch (block.kind) {
    case "text":
      return (
        <View className="blk blk-text">
          {streaming ? (
            <Text className="blk-text-plain" selectable userSelect>
              {block.text}
            </Text>
          ) : (
            <Markdown text={block.text} />
          )}
        </View>
      );
    case "thinking":
      return (
        <View className="blk blk-thinking">
          <View className="blk-head" onClick={onToggle}>
            <Text className="blk-icon">💭</Text>
            <Text className="blk-title">{streaming && block.open ? "思考中…" : "思考过程"}</Text>
            <Text className="blk-toggle">{block.open ? "收起" : "展开"}</Text>
          </View>
          {block.open ? (
            <Text className="blk-pre blk-thinking-text" selectable userSelect>
              {block.text}
            </Text>
          ) : null}
        </View>
      );
    case "tool":
      // agent 建的定时任务渲染为任务卡片(spec: agent-scheduling-tools),
      // 其余工具保持通用折叠块。
      if (block.name.endsWith("__cron_create")) {
        return <CronCard block={block} />;
      }
      // 委派任务卡片(spec: agent-delegation-tools);progress/result 保持通用块。
      if (block.name.endsWith("__delegate_task")) {
        return <DelegationCard block={block} />;
      }
      return <ToolBlock block={block} onToggle={onToggle} />;
    case "skill":
      return (
        <View className="blk blk-skill">
          <View className="blk-head" onClick={onToggle}>
            <Text className="blk-icon">⚡</Text>
            <Text className="blk-title">技能 {block.name}</Text>
            {block.args ? <Text className="blk-toggle">{block.args}</Text> : null}
          </View>
        </View>
      );
    case "command":
      return (
        <View className="blk blk-command">
          <View className="blk-head" onClick={onToggle}>
            <Text className="blk-icon">▶</Text>
            <Text className="blk-title">/{block.name}</Text>
          </View>
          {block.message ? <Text className="blk-pre">{block.message}</Text> : null}
        </View>
      );
    default:
      return null;
  }
}

// The collapsed header's plain-language line — never a tool name. Mirrors the
// web ActivityGroup header (steps count executions; thinking is duration).
function groupLabel(turn: AssistantTurn, group: ActivityGroupModel): { text: string; live: boolean; errored: boolean } {
  const executions = group.blocks.filter((b) => b.kind !== "thinking").length;
  const runningIndex = group.blocks.findIndex((b) => b.kind === "tool" && b.state === "running");
  if (turn.streaming) {
    if (executions === 0) return { text: "正在思考…", live: true, errored: false };
    const step =
      runningIndex >= 0
        ? group.blocks.slice(0, runningIndex).filter((b) => b.kind !== "thinking").length + 1
        : executions + 1;
    return { text: `正在执行第 ${step} 步…`, live: true, errored: false };
  }
  const seconds =
    turn.activityStartedAt && turn.activityEndedAt
      ? Math.max(1, Math.round((turn.activityEndedAt - turn.activityStartedAt) / 1000))
      : null;
  if (groupHasError(group)) return { text: `执行中遇到问题 · 已执行 ${executions} 步`, live: false, errored: true };
  if (seconds && executions > 0) return { text: `已思考 ${seconds} 秒 · 执行了 ${executions} 步`, live: false, errored: false };
  if (seconds) return { text: `已思考 ${seconds} 秒`, live: false, errored: false };
  return { text: `执行了 ${executions} 步`, live: false, errored: false };
}

function ActivityGroupView({
  turn,
  group,
  renderInner,
}: {
  turn: AssistantTurn;
  group: ActivityGroupModel;
  renderInner: (b: Block, i: number) => JSX.Element | null;
}) {
  const toggleGroup = useChatStore((s) => s.toggleGroup);
  const open = isGroupOpen(turn, group);
  const label = groupLabel(turn, group);
  return (
    <View className={`blk-group${label.errored ? " blk-group-error" : ""}${open ? " blk-group-open" : ""}`}>
      <View className="blk-head grp-head" onClick={() => toggleGroup(turn.id, group.startIndex)}>
        <Text className="blk-icon">{label.live ? "⏳" : label.errored ? "⚠️" : "✦"}</Text>
        <Text className={`grp-title${label.live ? " grp-title-live" : ""}${label.errored ? " grp-title-error" : ""}`}>
          {label.text}
        </Text>
        <Text className="blk-toggle">{open ? "▾" : "▸"}</Text>
      </View>
      {open ? (
        <View className="grp-body">{group.blocks.map((b, i) => renderInner(b, group.startIndex + i))}</View>
      ) : null}
    </View>
  );
}

export function TurnView({
  turn,
  onRegenerate,
  onReload,
}: {
  turn: Turn;
  onRegenerate?: () => void;
  // Interrupted-answer recovery: passed for the latest interrupted assistant
  // turn — refetches the session so the server's full transcript replaces the
  // locally truncated one.
  onReload?: () => void;
}) {
  const toggleBlock = useChatStore((s) => s.toggleBlock);

  if (turn.role === "user") {
    // 汇总注回(spec: agent-delegation-tools):任务系统注入的 turn,渲染为
    // 任务署名样式,不是用户气泡。
    if (turn.taskSummary) {
      return (
        <View className="turn turn-task-summary" data-testid="mp-task-summary">
          <Text className="turn-task-summary-label">📋 任务汇总</Text>
          <Text className="turn-task-summary-text" selectable userSelect>
            {turn.text}
          </Text>
        </View>
      );
    }
    return (
      <View className="turn turn-user">
        <Text className="turn-user-text" selectable userSelect>
          {turn.text}
        </Text>
      </View>
    );
  }

  // Reply actions: copy on every completed turn (plain text of the turn's
  // text blocks — weapp's setClipboardData shows its own success toast),
  // regenerate only where the page passes the callback (latest assistant
  // turn, idle, a user turn exists).
  const handleCopy = () => {
    const text = turn.blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text)
      .join("\n\n");
    Taro.setClipboardData({ data: text }).catch(() => {
      Taro.showToast({ title: "复制失败", icon: "none" });
    });
  };

  // Master collapse: consecutive machinery blocks fold under one group; text
  // and error stay outside. Groups are keyed by their start block index.
  const renderInner = (b: Block, i: number) => (
    <BlockView key={i} block={b} streaming={turn.streaming} onToggle={() => toggleBlock(turn.id, i)} />
  );
  const groups = groupTurnBlocks(turn.blocks);
  const groupByStart = new Map(groups.map((g) => [g.startIndex, g]));
  const grouped = new Set<number>();
  for (const g of groups) {
    for (let i = g.startIndex + 1; i < g.startIndex + g.blocks.length; i++) grouped.add(i);
  }

  return (
    <View className="turn turn-assistant">
      {turn.blocks.map((b, i) => {
        if (grouped.has(i)) return null;
        const group = groupByStart.get(i);
        if (group) {
          return (
            <ActivityGroupView key={`group-${group.startIndex}`} turn={turn} group={group} renderInner={renderInner} />
          );
        }
        return renderInner(b, i);
      })}
      {!turn.streaming ? (
        <View className="turn-actions">
          <Text className="turn-action" onClick={handleCopy}>
            复制
          </Text>
          {onRegenerate ? (
            <Text
              className="turn-action"
              onClick={() => {
                onRegenerate();
              }}
            >
              重新生成
            </Text>
          ) : null}
        </View>
      ) : null}
      {turn.streaming ? <Text className="turn-cursor">▍</Text> : null}
      {turn.interrupted ? (
        <View className="turn-interrupted-row">
          <Text className="turn-interrupted">回答已中断</Text>
          {onReload ? (
            <Text className="turn-reload" onClick={onReload} data-testid="mp-turn-reload">
              重新加载回答
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
