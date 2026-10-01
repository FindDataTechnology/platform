import { memo, useState } from "react";
// Full-width assistant turn. Blocks nest inside a left-rail so tool/thinking
// visibly belong to the same turn as the text. This is the "not siblings"
// design decision from proposal.md.
//
// The assistant name label, the streaming "Thinking…" placeholder, and the
// tool/thinking block labels resolve through the i18n bundle. Icons are
// lucide throughout — no emoji as an icon system (DESIGN.md).
import { useTranslation } from "react-i18next";
import { Check, Copy, RefreshCw, Terminal, TriangleAlert } from "lucide-react";
import { groupTurnBlocks, useChatStore, type Turn } from "@platform/core";
import { useBranding } from "@/hooks/useAppConfig";
import { Markdown } from "@/components/Markdown";
import { ActivityGroup } from "@/components/ActivityGroup";
import { ThinkingBlock } from "@/components/ThinkingBlock";
import { ToolBlock } from "@/components/ToolBlock";
import { SkillBlock } from "@/components/SkillBlock";
import { cn } from "@/lib/utils";

function AssistantTurnBase({
  turn,
  onRegenerate,
}: {
  turn: Extract<Turn, { role: "assistant" }>;
  // Re-send the last user prompt. Only the LAST assistant turn gets it, and
  // only when that turn is finished (Chat owns the wiring).
  onRegenerate?: () => void;
}) {
  const { t } = useTranslation();
  const { assistant } = useBranding();
  const toggleBlock = useChatStore((s) => s.toggleBlock);
  const [copied, setCopied] = useState(false);

  // Copy carries the answer's prose (text blocks), not the machinery.
  const answerText = turn.blocks
    .filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();

  const copy = async () => {
    if (!answerText) return;
    try {
      await navigator.clipboard.writeText(answerText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable (permissions); the button stays honest */
    }
  };

  // The inner-block renderer, shared by the group body and the two block
  // kinds that never group (text, error). Index is the ABSOLUTE block index —
  // `toggleBlock` addresses the turn's flat list, group membership is purely
  // a rendering derivation.
  const renderInnerBlock = (b: (typeof turn.blocks)[number], i: number) => {
    const key = `${turn.id}-${i}`;
    const toggle = () => toggleBlock(turn.id, i);
    switch (b.kind) {
      case "text":
        return <Markdown key={key} text={b.text} />;
      case "thinking":
        return <ThinkingBlock key={key} text={b.text} open={b.open} onToggle={toggle} />;
      case "tool":
        return <ToolBlock key={key} block={b} onToggle={toggle} />;
      case "skill":
        return (
          <SkillBlock
            key={key}
            name={b.name}
            args={b.args}
            open={b.open}
            onToggle={toggle}
          />
        );
      case "command":
        return (
          <div
            key={key}
            className="rounded-md border border-border bg-muted px-3 py-2 text-xs"
          >
            <div className="flex items-center gap-1.5 font-mono text-muted-foreground">
              <Terminal className="h-3 w-3 shrink-0" />
              /{b.name}
              {b.args ? ` ${b.args}` : ""}
            </div>
            {b.message && (
              <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                {b.message}
              </pre>
            )}
          </div>
        );
      case "error":
        return (
          <div
            key={key}
            data-testid="turn-error-block"
            className="flex items-start gap-1.5 rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 break-words">{b.message}</span>
          </div>
        );
      default:
        return null;
    }
  };

  // Master collapse: consecutive machinery blocks fold under one group whose
  // header is the only thing visible by default (see chat-activity-collapse).
  // Text/error blocks stay outside; groups are keyed by their start index.
  const groups = groupTurnBlocks(turn.blocks);
  const groupByStart = new Map(groups.map((g) => [g.startIndex, g]));
  const grouped = new Set<number>();
  for (const g of groups) {
    for (let i = g.startIndex + 1; i < g.startIndex + g.blocks.length; i++) grouped.add(i);
  }

  return (
    <article
      className={cn("group flex flex-col gap-3", turn.streaming && "opacity-100")}
      data-testid="turn-assistant"
      data-streaming={turn.streaming ? "true" : "false"}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full bg-primary/20">
          <span className="h-2 w-2 rounded-full bg-primary" />
        </span>
        <span>{t("turn.assistantName", { assistant })}</span>
        {/* Turn actions: revealed on hover, keyboard-accessible always. */}
        <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {answerText && (
            <button
              type="button"
              onClick={copy}
              aria-label={copied ? t("turn.copied") : t("turn.copy")}
              data-testid="turn-copy"
              data-copied={copied ? "true" : "false"}
              className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          )}
          {onRegenerate && !turn.streaming && (
            <button
              type="button"
              onClick={onRegenerate}
              aria-label={t("turn.regenerate")}
              data-testid="turn-regenerate"
              className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2 border-l border-border pl-4">
        {turn.blocks.map((b, i) => {
          if (grouped.has(i)) return null;
          const group = groupByStart.get(i);
          if (group) {
            return (
              <ActivityGroup
                key={`${turn.id}-group-${group.startIndex}`}
                turn={turn}
                group={group}
                renderBlock={renderInnerBlock}
              />
            );
          }
          return renderInnerBlock(b, i);
        })}
        {turn.streaming && turn.blocks.length === 0 && (
          <div className="text-xs text-muted-foreground">{t("turn.thinkingStreaming")}</div>
        )}
        {/* Disconnect truncation marker: the answer was cut off mid-stream.
            A user stop is a choice, not a truncation — no marker there. */}
        {turn.interrupted && (
          <div
            data-testid="turn-interrupted"
            className="inline-flex items-center gap-1 self-start rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] text-warning"
          >
            <TriangleAlert className="h-3 w-3 shrink-0" />
            {t("turn.interrupted")}
          </div>
        )}
      </div>
    </article>
  );
}

// Memoized: the store mutates turn objects in place and clones only the
// turns array, so a streaming delta re-renders just the tail turn's
// component instead of reconciling the whole transcript.
export const AssistantTurn = memo(AssistantTurnBase);
