// 收件箱里的一张卡（add-input-request-cards 4.6）：字段渲染与聊天内的
// InputRequestCard 共用同一套规矩，只是没有工具块、提交后回调刷新列表。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Send, X } from "lucide-react";
import type { InputField, InputRequestView } from "@platform/core";
import { cn } from "@/lib/utils";

const inputClass =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary";

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: InputField;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const id = `inbox-ir-${field.key}`;
  if (field.kind === "boolean") {
    return (
      <label className="flex items-center gap-2 text-xs text-foreground" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-border"
        />
        {field.label}
      </label>
    );
  }
  if (field.kind === "enum") {
    return (
      <div className="flex flex-wrap gap-1.5">
        {(field.options ?? []).map((o) => {
          const active = String(value ?? "") === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              data-selected={active ? "true" : "false"}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs transition-colors",
                active
                  ? "border-primary bg-primary/10 font-medium text-foreground"
                  : "border-border bg-background text-foreground hover:bg-muted",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }
  if (field.kind === "multiline") {
    return (
      <textarea
        id={id}
        rows={2}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className={cn(inputClass, "resize-y")}
      />
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type={field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text"}
        value={typeof value === "number" || typeof value === "string" ? String(value) : ""}
        onChange={(e) =>
          onChange(field.kind === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)
        }
        placeholder={field.placeholder}
        className={inputClass}
      />
      {field.unit && <span className="shrink-0 text-xs text-muted-foreground">{field.unit}</span>}
    </div>
  );
}

export function InputRequestInboxCard({
  request,
  onSettled,
}: {
  request: InputRequestView;
  onSettled?: () => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const f of request.card.fields) if (f.default !== undefined) out[f.key] = f.default;
    return out;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const missing = request.card.fields
      .filter((f) => f.required)
      .filter((f) => {
        const v = values[f.key];
        return v === undefined || v === null || v === "";
      })
      .map((f) => f.key);
    if (missing.length > 0) {
      setError(t("inputRequest.fillRequired", { fields: missing.join("、") }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/input-requests/${encodeURIComponent(request.requestId)}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.message || body?.error || `HTTP ${res.status}`);
        return;
      }
      onSettled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    await fetch(`/api/input-requests/${encodeURIComponent(request.requestId)}/cancel`, { method: "POST" }).catch(
      () => {},
    );
    onSettled?.();
  };

  return (
    <div
      className="rounded-md border border-border bg-background px-3 py-2"
      data-testid="input-request-inbox-card"
    >
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="min-w-0 truncate font-medium text-foreground">{request.card.title}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {t("inputRequest.expiresIn", {
            minutes: Math.max(0, Math.round((request.expiresAt - Date.now()) / 60000)),
          })}
        </span>
      </div>
      {request.card.detail && (
        <div className="mb-2 whitespace-pre-wrap text-xs text-muted-foreground">{request.card.detail}</div>
      )}
      <div className="space-y-2">
        {request.card.fields.map((f) => (
          <div key={f.key} className="space-y-1">
            {f.kind !== "boolean" && (
              <div className="text-xs font-medium text-foreground">
                {f.label}
                {f.required && <span className="ml-0.5 text-destructive">*</span>}
              </div>
            )}
            <FieldControl
              field={f}
              value={values[f.key]}
              onChange={(next) => setValues((prev) => ({ ...prev, [f.key]: next }))}
            />
          </div>
        ))}
      </div>
      {error && (
        <div role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => void cancel()}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" aria-hidden="true" />
          {t("inputRequest.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Send className="h-3 w-3" aria-hidden="true" />}
          {t("inputRequest.submit")}
        </button>
      </div>
    </div>
  );
}
