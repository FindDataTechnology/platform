// 结构化输入请求卡片（add-input-request-cards 4.4）：request_input 工具块的
// 小程序呈现。与 web 的 InputRequestCard 同构——同一行、同一端点、同一套
// 校验；只是控件换成了 Taro 的原生组件。
//
// 挂起=交互卡（按字段 kind 渲染），终态=静态摘要（已答的值 / 取消 / 过期 /
// 已升级）。待答状态取共享 core 的 pendingInputRequests 切片，因此重连水合
// 与多端先答先得都不需要小程序自己再实现一遍。

import { useState } from "react";
import { Input, Text, View } from "@tarojs/components";
import type { Block, InputCard, InputField, InputRequestView } from "@platform/core";
import { useChatStore } from "@platform/core";

type ToolBlockModel = Extract<Block, { kind: "tool" }>;

function parseResult(raw: unknown): { state?: string; values?: Record<string, unknown> | null; requestId?: string } | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function cardOfArgs(args: unknown): InputCard | null {
  const card = (args as { card?: InputCard } | null)?.card;
  return card && Array.isArray(card.fields) ? card : null;
}

function labelFor(value: unknown): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null || value === undefined) return "";
  return String(value);
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: InputField;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <View className="ir-field" onClick={() => onChange(!(value === true))}>
        <Text className="ir-field-label">
          {value === true ? "☑" : "☐"} {field.label}
        </Text>
      </View>
    );
  }
  if (field.kind === "enum") {
    return (
      <View className="ir-field">
        <Text className="ir-field-label">{field.label}</Text>
        <View className="ir-options">
          {(field.options ?? []).map((o) => (
            <Text
              key={o.value}
              className={String(value ?? "") === o.value ? "ir-option ir-option-on" : "ir-option"}
              onClick={() => onChange(o.value)}
            >
              {o.label}
            </Text>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View className="ir-field">
      <Text className="ir-field-label">
        {field.label}
        {field.required ? " *" : ""}
        {field.unit ? `（${field.unit}）` : ""}
      </Text>
      <Input
        className="ir-input"
        type={field.kind === "number" ? "number" : "text"}
        value={value === undefined || value === null ? "" : String(value)}
        placeholder={field.placeholder ?? (field.kind === "file" ? "资源引用或链接" : "请输入")}
        onInput={(e) =>
          onChange(field.kind === "number" ? Number(e.detail.value) : e.detail.value)
        }
      />
    </View>
  );
}

export function InputRequestCard({ block }: { block: ToolBlockModel }) {
  const pendingMap = useChatStore((s) => s.pendingInputRequests ?? {});
  const result = parseResult(block.result);
  const card = cardOfArgs(block.args);
  const live: InputRequestView | null = result?.requestId ? (pendingMap[result.requestId] ?? null) : null;
  const isPending = block.state === "running" && live !== null;
  const activeCard = live?.card ?? card;
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isPending) {
    const state = result?.state ?? (block.state === "error" ? "cancelled" : "answered");
    const label =
      state === "answered" ? "已提交" : state === "escalated" ? "已升级待人工处理" : state === "expired" ? "已过期（无人应答）" : "已取消";
    const vals = (result?.values as Record<string, unknown> | null) ?? null;
    return (
      <View className="ir-card ir-card-settled">
        <Text className="ir-title">{label}</Text>
        {activeCard ? <Text className="ir-sub">{activeCard.title}</Text> : null}
        {vals && activeCard
          ? activeCard.fields
              .filter((f) => vals[f.key] !== undefined && vals[f.key] !== null && vals[f.key] !== "")
              .map((f) => (
                <View key={f.key}>
                  <Text className="ir-line">
                    {f.label}：{labelFor(vals[f.key])}
                  </Text>
                </View>
              ))
          : null}
      </View>
    );
  }

  const submit = async () => {
    if (!live) return;
    const missing = live.card.fields.filter((f) => f.required && (values[f.key] === undefined || values[f.key] === ""));
    if (missing.length > 0) {
      setError(`请先填写：${missing.map((f) => f.label).join("、")}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/input-requests/${encodeURIComponent(live.requestId)}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        setError(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!live) return;
    await fetch(`/api/input-requests/${encodeURIComponent(live.requestId)}/cancel`, { method: "POST" }).catch(
      () => {},
    );
  };

  return (
    <View className="ir-card">
      <View className="ir-head">
        <Text className="ir-title">{live.card.title}</Text>
        <Text className="ir-sub">
          剩余 {Math.max(0, Math.round((live.expiresAt - Date.now()) / 60000))} 分钟
        </Text>
      </View>
      {live.card.detail ? <Text className="ir-detail">{live.card.detail}</Text> : null}
      {live.card.fields.map((f) => (
        <FieldRow
          key={f.key}
          field={f}
          value={values[f.key]}
          onChange={(next) => setValues((prev) => ({ ...prev, [f.key]: next }))}
        />
      ))}
      {error ? <Text className="ir-error">{error}</Text> : null}
      <View className="ir-actions">
        <Text className="ir-btn" onClick={() => void cancel()}>
          取消
        </Text>
        <Text className={busy ? "ir-btn ir-btn-primary ir-btn-busy" : "ir-btn ir-btn-primary"} onClick={() => void submit()}>
          {busy ? "提交中…" : "提交"}
        </Text>
      </View>
    </View>
  );
}
