// Conversation outline rail (add-chat-outline) — the mini-program twin of
// the web ChatOutline. Phones have no hover: tap the edge control to expand,
// tap an entry to jump (jumping also collapses the card so the transcript is
// unobstructed), "—" collapses without jumping. The >= 3-entry threshold is
// the parent's decision, mirroring the web rail.

import { useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";

export interface OutlineEntry {
  id: string;
  // First line of the user prompt, pre-truncated by CSS ellipsis here.
  text: string;
}

interface Props {
  entries: OutlineEntry[];
  onJump: (id: string) => void;
}

export function OutlineRail({ entries, onJump }: Props) {
  const [expanded, setExpanded] = useState(false);

  const jump = (id: string) => {
    setExpanded(false);
    onJump(id);
  };

  if (expanded) {
    return (
      <View className="outline-rail">
        <View className="outline-card">
          <View className="outline-card-head">
            <Text className="outline-card-title">会话大纲</Text>
            <Text className="outline-collapse" onClick={() => setExpanded(false)}>
              —
            </Text>
          </View>
          <ScrollView scrollY className="outline-card-list">
            {entries.map((e, i) => (
              <View
                key={e.id}
                className="outline-entry"
                onClick={() => {
                  jump(e.id);
                }}
              >
                <Text className="outline-entry-idx">{i + 1}</Text>
                <Text className="outline-entry-text">{e.text}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    );
  }

  return (
    <View className="outline-rail">
      <View
        className="outline-edge"
        aria-label="对话大纲"
        onClick={() => {
          setExpanded(true);
        }}
      >
        <Text className="outline-edge-glyph">≡</Text>
      </View>
    </View>
  );
}
