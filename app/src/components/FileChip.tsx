// Workspace-file chip (artifact strip, add-resource-library parity): a file
// link an assistant turn produced, tappable to SAVE it into the resource
// library (the whole point of the strip). Save state is remembered for the
// session so a second tap never re-attempts a doomed duplicate save.

import { useState } from "react";
import { Text, View, Pressable, StyleSheet, Alert } from "react-native";
import { saveResource, type FileRef } from "@platform/core";
import { palette } from "./palette";
import { useTranslation } from "react-i18next";

export function FileChip({ name, fileRef }: { name: string; fileRef: FileRef }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (saved || busy) return;
    setBusy(true);
    try {
      await saveResource({ path: fileRef.rel });
      setSaved(true);
    } catch (e) {
      Alert.alert(t("artifact.saveFailed"), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable style={[styles.chip, saved && styles.saved]} onPress={() => void save()} disabled={saved || busy}>
      <Text style={styles.glyph}>{saved ? "✓" : "📄"}</Text>
      <Text style={styles.name} numberOfLines={1}>
        {name}
      </Text>
      <Text style={styles.action}>{saved ? t("artifact.saved") : busy ? t("artifact.saving") : t("artifact.save")}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    alignSelf: "flex-start",
    marginVertical: 3,
    maxWidth: "100%",
  },
  saved: { borderColor: palette.good + "66" },
  glyph: { fontSize: 13 },
  name: { fontSize: 13, color: palette.ink, maxWidth: 200 },
  action: { fontSize: 12, color: palette.primary, fontWeight: "600" },
});
