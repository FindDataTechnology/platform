// Markdown rendering for assistant text (task 4.1 lands the full renderer;
// this is the streaming-safe core the chat lane needs from day one):
// fenced code blocks render monospace with a background, everything else
// renders as paragraph text with simple heading/list emphasis. The parsing
// convention matches the other clients: fences are ``` blocks.

import { Text, View, StyleSheet } from "react-native";
import { palette } from "./palette";

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
      {runs.map((run, ri) =>
        ri % 2 === 1 ? (
          <Text key={ri} style={styles.inlineCode}>
            {run}
          </Text>
        ) : (
          <Text key={ri}>{run}</Text>
        ),
      )}
    </Text>
  );
}

export function Markdown({ text }: { text: string }) {
  const parts: ReturnType<typeof renderLine>[] = [];
  // Split on fenced blocks; even indexes are prose, odd are code.
  const segments = text.split(/```(?:[a-zA-Z0-9_-]*\n)?/);
  segments.forEach((segment, i) => {
    if (i % 2 === 1) {
      parts.push(
        <View key={`code-${i}`} style={styles.codeBlock}>
          <Text style={styles.code} selectable>
            {segment.replace(/\n$/, "")}
          </Text>
        </View>,
      );
    } else {
      segment.split("\n").forEach((line, j) => parts.push(renderLine(line, `${i}-${j}`)));
    }
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
