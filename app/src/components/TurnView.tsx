// One turn of the transcript. User turns are quiet bubbles (long-press to
// copy); assistant turns walk the block stream — text through Markdown,
// thinking as a collapsed line, tool/skill/command activity grouped into ONE
// collapsed row (error/pending-ask auto-open), agent-created cron tasks and
// delegations as labeled cards, errors inline — plus the ARTIFACT STRIP:
// workspace file links in the text become save-into-library chips.

import { useMemo, useState } from "react";
import { Text, View, Pressable, StyleSheet } from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  groupTurnBlocks,
  groupHasPendingAsk,
  isGroupOpen,
  groupHasError,
  fileLinkRef,
  useChatStore,
  type ActivityGroup,
  type AssistantTurn,
  type Turn,
} from "@platform/core";
import { Markdown } from "./Markdown";
import { useTranslation } from "react-i18next";
import { FileChip } from "./FileChip";
import { palette } from "./palette";

function ToolCard({ name, title, args }: { name: string; title: string; args: unknown }) {
  const { t } = useTranslation();
  return (
    <View style={styles.toolCard}>
      <Text style={styles.toolCardTitle}>{title}</Text>
      <Text style={styles.toolCardName} numberOfLines={1}>
        {name}
      </Text>
      <Text style={styles.toolCardArgs} numberOfLines={3}>
        {JSON.stringify(args).slice(0, 200)}
      </Text>
    </View>
  );
}

function ToolGroupRow({ turn, group }: { turn: AssistantTurn; group: ActivityGroup }) {
  const { t } = useTranslation();
  const pendingQuestion = useChatStore((s) => s.pendingQuestion);
  const errored = groupHasError(group);
  const openByAsk = groupHasPendingAsk(group, pendingQuestion);
  const [manualOpen, setManualOpen] = useState(false);
  const open = manualOpen || isGroupOpen(turn, group) || errored || openByAsk;
  const label = group.blocks[0];
  return (
    <View style={styles.groupWrap}>
      <Pressable style={styles.groupHeader} onPress={() => setManualOpen(!open)}>
        <Text style={[styles.groupGlyph, errored && { color: palette.danger }]}>
          {errored ? "✕" : "⚙"}
        </Text>
        <Text style={styles.groupTitle} numberOfLines={1}>
          {label?.kind === "tool" || label?.kind === "skill" || label?.kind === "command"
            ? t("turn.steps", { name: label.name, count: group.blocks.length })
            : t("turn.activity", { count: group.blocks.length })}
        </Text>
        <Text style={styles.groupChevron}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      {open && (
        <View style={styles.groupBody}>
          {group.blocks.map((b, i) => (
            <Text key={i} style={styles.groupLine} numberOfLines={3}>
              {b.kind === "tool" && `${b.state === "error" ? "✕ " : ""}${b.name}(${JSON.stringify(b.args).slice(0, 120)})`}
              {b.kind === "skill" && `✦ ${b.name}`}
              {b.kind === "command" && `$ ${b.name}`}
              {b.kind === "text" && b.text.slice(0, 160)}
              {b.kind === "thinking" && `·· ${b.text.slice(0, 120)}`}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

// The artifact strip: markdown file links in this turn's text → chips.
function ArtifactStrip({ text }: { text: string }) {
  const workspace = useChatStore((s) => s.currentWorkspace);
  const chips = useMemo(() => {
    const out: { name: string; fileRef: NonNullable<ReturnType<typeof fileLinkRef>> }[] = [];
    for (const m of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      const ref = fileLinkRef(m[2], workspace);
      if (ref) out.push({ name: m[1] || m[2], fileRef: ref });
    }
    return out.slice(0, 6);
  }, [text, workspace]);
  if (!chips.length) return null;
  return (
    <View style={styles.strip}>
      {chips.map((c, i) => (
        <FileChip key={`${c.fileRef.rel}-${i}`} name={c.name} fileRef={c.fileRef} />
      ))}
    </View>
  );
}

export function TurnView({ turn }: { turn: Turn }) {
  const { t } = useTranslation();
  const groups = useMemo(
    () => (turn.role === "assistant" ? groupTurnBlocks(turn.blocks) : []),
    [turn],
  );
  if (turn.role === "user") {
    return (
      <Pressable
        style={styles.userRow}
        onLongPress={() => void Clipboard.setStringAsync(turn.text)}
        accessibilityLabel={t("turn.copy")}
      >
        <View style={styles.userBubble}>
          <Text style={styles.userText} selectable>
            {turn.text}
          </Text>
        </View>
      </Pressable>
    );
  }
  const textAll = turn.blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("\n");
  return (
    <View style={styles.assistantRow}>
      {groups.map((g, i) => {
        const first = g.blocks[0];
        if (g.blocks.length === 1 && first.kind === "text") {
          return <Markdown key={i} text={first.text} />;
        }
        if (g.blocks.length === 1 && first.kind === "error") {
          return (
            <Text key={i} style={styles.errorText}>
              {first.message}
            </Text>
          );
        }
        if (g.blocks.length === 1 && first.kind === "thinking") {
          return (
            <Text key={i} style={styles.thinking} numberOfLines={first.open ? undefined : 1}>
              {first.open ? first.text : t("turn.thinking", { text: first.text.slice(0, 60) })}
            </Text>
          );
        }
        // Agent-created scheduled task / delegation: labeled cards (the
        // generic collapse would bury their identity).
        if (g.blocks.length === 1 && first.kind === "tool" && first.name.endsWith("__cron_create")) {
          return <ToolCard key={i} name={first.name} title={t("turn.cronCard")} args={first.args} />;
        }
        if (g.blocks.length === 1 && first.kind === "tool" && first.name.endsWith("__delegate_task")) {
          return <ToolCard key={i} name={first.name} title={t("turn.delegationCard")} args={first.args} />;
        }
        return <ToolGroupRow key={i} turn={turn} group={g} />;
      })}
      <ArtifactStrip text={textAll} />
      {turn.streaming && <Text style={styles.cursor}>▍</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 6 },
  userBubble: {
    backgroundColor: palette.primary,
    borderRadius: 14,
    borderBottomRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "85%",
  },
  userText: { color: "#fff", fontSize: 15, lineHeight: 22 },
  assistantRow: { paddingVertical: 6, gap: 4 },
  errorText: { color: palette.danger, fontSize: 14, lineHeight: 20 },
  thinking: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  cursor: { color: palette.primary, fontSize: 15 },
  toolCard: {
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 12,
    padding: 12,
    marginVertical: 4,
    gap: 4,
  },
  toolCardTitle: { fontSize: 13, fontWeight: "700", color: palette.primary },
  toolCardName: { fontSize: 12, color: palette.muted, fontFamily: "Menlo" },
  toolCardArgs: { fontSize: 12, color: palette.muted, lineHeight: 17, fontFamily: "Menlo" },
  groupWrap: {
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    marginVertical: 4,
    overflow: "hidden",
  },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  groupGlyph: { fontSize: 14, color: palette.muted },
  groupTitle: { flex: 1, fontSize: 13, color: palette.ink },
  groupChevron: { fontSize: 12, color: palette.muted },
  groupBody: { borderTopWidth: 1, borderTopColor: palette.line, padding: 10, gap: 6 },
  groupLine: { fontSize: 12, lineHeight: 17, color: palette.muted, fontFamily: "Menlo" },
  strip: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
});
