// The pending-ask card (add-user-questions parity): renders each question
// with its options (single/multi select + free text), and submits through
// answer_question — first-wins; the ask's own tool_end closes the card. The
// composer gates while the card is open (the chat screen keys off the same
// store field).

import { useState } from "react";
import { Text, View, TextInput, Pressable, StyleSheet, ScrollView } from "react-native";
import { palette } from "./palette";
import { useTranslation } from "react-i18next";

interface QuestionItem {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export function QuestionCard({
  askId,
  questions,
  onSubmit,
}: {
  askId: string;
  questions: QuestionItem[];
  onSubmit: (msg: { type: "answer_question"; askId: string; answers?: { id: string; selected: string[]; custom?: string }[]; cancelled?: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [customs, setCustoms] = useState<Record<string, string>>({});

  const toggle = (qid: string, label: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qid] ?? [];
      if (!multi) return { ...prev, [qid]: cur.includes(label) ? [] : [label] };
      return {
        ...prev,
        [qid]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      };
    });
  };

  const submit = () => {
    const answers = questions.map((q) => ({
      id: q.id,
      selected: selected[q.id] ?? [],
      custom: customs[q.id]?.trim() || undefined,
    }));
    onSubmit({ type: "answer_question", askId, answers });
  };

  return (
    <View style={styles.card}>
      {questions.map((q, qi) => (
        <View key={q.id} style={styles.question}>
          {q.header && <Text style={styles.header}>{q.header}</Text>}
          <Text style={styles.questionText}>
            {qi + 1}. {q.question}
          </Text>
          {q.detail && <Text style={styles.detail}>{q.detail}</Text>}
          {q.options?.map((opt) => {
            const on = (selected[q.id] ?? []).includes(opt.label);
            return (
              <Pressable key={opt.label} style={[styles.option, on && styles.optionOn]} onPress={() => toggle(q.id, opt.label, Boolean(q.multiSelect))}>
                <Text style={[styles.optionText, on && { color: palette.primary, fontWeight: "600" }]}>{opt.label}</Text>
                {opt.description && <Text style={styles.optionDesc}>{opt.description}</Text>}
              </Pressable>
            );
          })}
          <TextInput
            style={styles.custom}
            value={customs[q.id] ?? ""}
            onChangeText={(v) => setCustoms((p) => ({ ...p, [q.id]: v }))}
            placeholder={q.options?.length ? t("ask.optional") : t("ask.answerHere")}
            placeholderTextColor={palette.muted}
            multiline
          />
        </View>
      ))}
      <View style={styles.actions}>
        <Pressable style={styles.cancel} onPress={() => onSubmit({ type: "answer_question", askId, cancelled: true })}>
          <Text style={styles.cancelText}>{t("ask.skip")}</Text>
        </Pressable>
        <Pressable style={styles.submit} onPress={submit}>
          <Text style={styles.submitText}>{t("ask.submit")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.primary + "55",
    borderRadius: 12,
    padding: 14,
    marginVertical: 8,
    gap: 10,
  },
  question: { gap: 6 },
  header: { fontSize: 12, fontWeight: "700", color: palette.primary, letterSpacing: 1 },
  questionText: { fontSize: 15, color: palette.ink, lineHeight: 21 },
  detail: { fontSize: 13, color: palette.muted, lineHeight: 18 },
  option: {
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: palette.paper,
  },
  optionOn: { borderColor: palette.primary, backgroundColor: palette.primary + "10" },
  optionText: { fontSize: 14, color: palette.ink },
  optionDesc: { fontSize: 12, color: palette.muted, marginTop: 2, lineHeight: 16 },
  custom: {
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: palette.ink,
    backgroundColor: palette.paper,
    minHeight: 38,
  },
  actions: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
  cancel: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: palette.line },
  cancelText: { fontSize: 14, color: palette.muted },
  submit: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10, backgroundColor: palette.primary },
  submitText: { fontSize: 14, color: "#fff", fontWeight: "600" },
});
