// Markdown rendering for assistant text (task 4.1 lands the full renderer;
// this is the streaming-safe core the chat lane needs from day one):
// fenced code blocks render monospace with a background, everything else
// renders as paragraph text with simple heading/list emphasis. The parsing
// convention matches the other clients: fences are ``` blocks, and an
// `echarts` fence becomes a live chart (automate-nonweb-acceptance 1.2) —
// same contract as the web client's chat-chart-rendering.

import { Text, View, StyleSheet } from "react-native";
import { palette } from "./palette";
import { ChartView } from "./ChartView";
import { chartOptionFromFence, tokenizeFences } from "@/lib/markdown-fences";

function renderLine(line: string, key: string) {
  const heading = line.match(/^(#{1,4})\s+(.*)$/);
  if (heading) {
    const size = [20, 18, 16, 15][heading[1].length - 1];
    return (
      <Text key={key} style={[styles.base, { fontSize: size, fontWeight: "600", marginTop: 8 }]}>
        {heading[2]}
      </Text>
    );
  }
  if (/^\s*[-*]\s+/.test(line)) {
    return (
      <Text key={key} style={[styles.base, styles.listItem]}>
        • {line.replace(/^\s*[-*]\s+/, "")}
      </Text>
    );
  }
  if (/^\s*\d+\.\s+/.test(line)) {
    return (
      <Text key={key} style={[styles.base, styles.listItem]}>
        {line.trim()}
      </Text>
    );
  }
  if (/^\s*\|.*\|\s*$/.test(line)) {
    // Table rows (spec: scrollable content): monospace keeps columns legible
    // in v1 — a native grid lands with the full renderer pass.
    return (
      <Text key={key} style={styles.tableRow} selectable>
        {line.trim()}
      </Text>
    );
  }
  if (!line.trim()) return <View key={key} style={styles.gap} />;
  // Inline code: split on backticks; even runs plain, odd runs monospace.
  const runs = line.split(/`([^`]+)`/);
  return (
    <Text key={key} style={styles.base}>
      {/* The runs are positional by construction — alternating plain/code
          spans of one line, never reordered — so the run index is the
          identity. */}
      {runs.map((run, ri) =>
        ri % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional split runs, never reordered
          <Text key={ri} style={styles.inlineCode}>
            {run}
          </Text>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional split runs, never reordered
          <Text key={ri}>{run}</Text>
        ),
      )}
    </Text>
  );
}

export function Markdown({ text }: { text: string }) {
  const parts: ReturnType<typeof renderLine>[] = [];
  tokenizeFences(text).forEach((token, i) => {
    if (token.kind === "code") {
      const option = chartOptionFromFence(token);
      if (option) {
        // biome-ignore lint/suspicious/noArrayIndexKey: token index is the stable identity of a fence block
        parts.push(<ChartView key={`chart-${i}`} option={option} />);
        return;
      }
      parts.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: token index is the stable identity of a code block
        <View key={`code-${i}`} style={styles.codeBlock}>
          <Text style={styles.code} selectable>
            {token.body.replace(/\n$/, "")}
          </Text>
        </View>,
      );
      return;
    }
    token.body.split("\n").forEach((line, j) => {
      parts.push(renderLine(line, `${i}-${j}`));
    });
  });
  return <View style={styles.wrap}>{parts}</View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 0 },
  base: { fontSize: 15, lineHeight: 23, color: palette.ink },
  listItem: { paddingLeft: 12, paddingVertical: 1 },
  tableRow: { fontSize: 12.5, lineHeight: 18, color: palette.ink, fontFamily: "Menlo" },
  inlineCode: { fontFamily: "Menlo", fontSize: 13.5, backgroundColor: palette.codeBg },
  gap: { height: 6 },
  codeBlock: {
    backgroundColor: palette.codeBg,
    borderRadius: 8,
    padding: 10,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: palette.line,
  },
  code: {
    fontFamily: "Menlo",
    fontSize: 13,
    lineHeight: 19,
    color: palette.ink,
  },
});
