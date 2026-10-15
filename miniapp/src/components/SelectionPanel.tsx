// Half-screen selection panel: the unified surface for agent / model /
// preset switching (replaces three native Picker wheels in the header).
//
// Contract (spec: redesign-mp-chat-layout): tapping a row applies the choice
// immediately — the panel STAYS OPEN so two dimensions can be set in one
// sitting; the mask or ✕ dismisses without further change. Disabled while a
// config switch is pending (the page guards too; the prop is for styling).
//
// Pure markup: rows arrive as {id, label}; all protocol sends live in the
// chat page's onPick.

import { ScrollView, Text, View } from "@tarojs/components";

export interface PanelRow {
  id: string;
  label: string;
}

export type PanelPickKind = "agent" | "model" | "preset";

interface Props {
  visible: boolean;
  agents: PanelRow[];
  models: PanelRow[];
  presets: PanelRow[];
  showPresets: boolean;
  currentAgent: string | null;
  currentModel: string | null;
  currentPreset: string | null;
  disabled: boolean;
  onPick: (kind: PanelPickKind, id: string) => void;
  onClose: () => void;
}

export function SelectionPanel({
  visible,
  agents,
  models,
  presets,
  showPresets,
  currentAgent,
  currentModel,
  currentPreset,
  disabled,
  onPick,
  onClose,
}: Props) {
  const section = (title: string, rows: PanelRow[], current: string | null, kind: PanelPickKind) => {
    if (rows.length === 0) return null;
    return (
      <View className="sel-section">
        <Text className="sel-section-title">{title}</Text>
        {rows.map((r) => {
          const active = r.id === current;
          return (
            <View
              key={r.id}
              className={`sel-option${active ? " sel-option-active" : ""}${disabled ? " sel-option-disabled" : ""}`}
              onClick={() => {
                if (!disabled) onPick(kind, r.id);
              }}
            >
              <Text className="sel-option-label">{r.label}</Text>
              {active ? <Text className="sel-check">✓</Text> : null}
            </View>
          );
        })}
      </View>
    );
  };

  return (
    <View className={`sel-root${visible ? " sel-root-open" : ""}`}>
      <View className="sel-mask" onClick={onClose} />
      <View className="sel-panel">
        <View className="sel-panel-head">
          <Text className="sel-panel-title">会话设置</Text>
          <Text className="sel-panel-close" onClick={onClose}>
            ✕
          </Text>
        </View>
        <ScrollView scrollY className="sel-scroll">
          {section("智能体", agents, currentAgent, "agent")}
          {section("模型", models, currentModel, "model")}
          {showPresets ? section("模式", presets, currentPreset, "preset") : null}
        </ScrollView>
      </View>
    </View>
  );
}
