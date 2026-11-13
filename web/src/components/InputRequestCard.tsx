// ── InputRequestCard (add-input-request-cards) ──────────────────────────────
//
// `request_input` 工具块的两面，形状照 QuestionCard 的先例：
//
//   pending  — 交互卡：按 card.fields[].kind 渲染七种字段，必填校验在本地先
//              过一遍（服务端仍会独立校验，本地这道只为即时反馈），提交走
//              POST /api/input-requests/:id/answer。
//   settled  — 只读摘要：已答的按键值、取消/过期/已升级各自的说法。历史重放
//              与实时收敛走同一个形状。
//
// 待答状态从 store 的 pendingInputRequests 读（按 requestId）；这张卡不一定
// 属于本回合——回合结束后它仍然待答，所以它不绑 toolCallId，只绑请求 id。

import { CheckCircle2, CircleHelp, Clock3, Loader2, Send, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  useChatStore,
  type Block,
  type InputCard,
  type InputField,
  type InputRequestView,
} from "@platform/core";
import { memo, useMemo, useState } from "react";

type ToolBlockModel = Extract<Block, { kind: "tool" }>;

interface Props {
  block: ToolBlockModel;
}

// 工具结果（JSON 字符串）→ 读回请求 id 与终态。历史重放时 store 里没有
// 这张卡，只能靠工具结果自述。
function parseResult(raw: unknown): { requestId?: string; state?: string; values?: Record<string, unknown> | null } | null {
  const text = typeof raw === "string" ? raw : null;
  if (!text) return typeof raw === "object" && raw ? (raw as Record<string, unknown>) : null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function cardOfArgs(args: unknown): InputCard | null {
  const card = (args as { card?: InputCard } | null)?.card;
  return card && Array.isArray(card.fields) ? card : null;
}

function emptyValues(card: InputCard): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of card.fields) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}

function missingRequired(card: InputCard, values: Record<string, unknown>): string[] {
  return card.fields
    .filter((f) => f.required)
    .filter((f) => {
      const v = values[f.key];
      return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    })
    .map((f) => f.key);
}

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
  const { t } = useTranslation();
  const id = `ir-field-${field.key}`;
  if (field.kind === "boolean") {
    return (
      <label className="flex items-center gap-2 text-xs text-foreground" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          data-testid="input-request-boolean"
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
              data-testid="input-request-option"
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
  if (field.kind === "file") {
    return (
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("inputRequest.filePlaceholder")}
          data-testid="input-request-file"
          className={inputClass}
        />
        <Upload className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }
  if (field.kind === "multiline") {
    return (
      <textarea
        id={id}
        rows={3}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        data-testid="input-request-multiline"
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
        data-testid="input-request-input"
        className={inputClass}
      />
      {field.unit && <span className="shrink-0 text-xs text-muted-foreground">{field.unit}</span>}
    </div>
  );
}

function SettledFace({ state, values, card }: { state: string; values: Record<string, unknown> | null; card: InputCard | null }) {
  const { t } = useTranslation();
  const label =
    state === "answered"
      ? t("inputRequest.answered")
      : state === "escalated"
        ? t("inputRequest.escalated")
        : state === "expired"
          ? t("inputRequest.expired")
          : state === "pending"
            ? t("inputRequest.pending")
            : t("inputRequest.cancelled");
  return (
    <div
      data-testid="input-request-card"
      data-state={state}
      className={cn(
        // 1px hairline accent, not a 2px side tab: design-lint's
        // `side-tab-border` rule names >=2px left/right borders as the "AI UI"
        // tell, and this card is new debt the ratchet will not accept.
        "overflow-hidden rounded-md border border-border border-l bg-muted/40",
        state === "answered" ? "border-l-success" : "border-l-border",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        {state === "answered" ? (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-success" aria-hidden="true" />
        ) : state === "escalated" || state === "expired" || state === "pending" ? (
          <Clock3 className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <X className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
        {card && <span className="min-w-0 truncate text-muted-foreground">{card.title}</span>}
      </div>
      {values && card && (
        <ul className="space-y-1 border-t border-border px-3 py-2 text-xs">
          {card.fields
            .filter((f) => values[f.key] !== undefined && values[f.key] !== null && values[f.key] !== "")
            .map((f) => (
              <li key={f.key} className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-muted-foreground">{f.label}</span>
                <span className="truncate font-medium text-foreground">
                  {typeof values[f.key] === "boolean"
                    ? values[f.key]
                      ? t("inputRequest.yes")
                      : t("inputRequest.no")
                    : String(values[f.key])}
                  {f.unit ? ` ${f.unit}` : ""}
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function InputRequestCardBase({ block }: Props) {
  const { t } = useTranslation();
  const pendingMap = useChatStore((s) => s.pendingInputRequests ?? {});
  const settledMap = useChatStore((s) => s.settledInputRequests ?? {});
  const result = useMemo(() => parseResult(block.result), [block.result]);
  const card = cardOfArgs(block.args);
  const requestId = result?.requestId;
  // 工具还没返回时没有 requestId：按**工具调用 id** 从待答投影里认领（服务端
  // 在提卡帧上带了 toolCallId）。没有这一条，等待窗口内卡片只能是只读的
  // 「等待填写」——人看着一张填不了的卡（2026-11-11 线上实测）。
  const live: InputRequestView | null = requestId
    ? (pendingMap[requestId] ?? null)
    : (Object.values(pendingMap).find((r) => r.toolCallId && r.toolCallId === block.id) ?? null);
  // 可交互只看「这张请求还在待答里」——**不再要求回合还在跑**：等人的时间可以
  // 超过 harness 的 MCP 调用超时（实测 dsh 侧 60s 就返回 Request timed out），
  // 那时工具已经返回，卡片却仍该可填。行是唯一真源，回合状态不是。
  const isPending = live !== null;
  // settled 与 live 用同一套认领：工具还没返回时没有 requestId，只能按 toolCallId
  // 找到「这次调用提的那张卡」的终态（否则收敛后仍停在只读的「等待填写」）。
  const settled =
    (requestId ? settledMap[requestId] : null) ??
    Object.values(settledMap).find((r) => r.toolCallId && r.toolCallId === block.id) ??
    null;
  const activeCard = live?.card ?? card;

  const [values, setValues] = useState<Record<string, unknown>>(() =>
    activeCard ? emptyValues(activeCard) : {},
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isPending) {
    return (
      <SettledFace
        // 三个来源按可信度排：settled 事件（服务器终态，含之后才到的答案）>
        // 工具结果（人当场填的情况）> 兜底。工具返回「挂起中」不算终态——那时
        // 既不是已作答也不该显示成「已提交」。
        state={
          settled?.state ??
          (result?.state && result.state !== "pending"
            ? result.state
            : block.state === "error"
              ? "cancelled"
              : "pending")
        }
        values={settled?.values ?? (result?.values as Record<string, unknown> | null) ?? null}
        card={activeCard}
      />
    );
  }

  const submit = async () => {
    if (!live) return;
    const missing = missingRequired(live.card, values);
    if (missing.length > 0) {
      setError(t("inputRequest.fillRequired", { fields: missing.join("、") }));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/input-requests/${encodeURIComponent(live.requestId)}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.message || body?.error || `HTTP ${res.status}`);
      }
      // 成功后不改本地：settled 事件 / 会话同步会把这张卡收敛成只读摘要。
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!live) return;
    await fetch(`/api/input-requests/${encodeURIComponent(live.requestId)}/cancel`, { method: "POST" }).catch(
      () => {},
    );
  };

  const expiresIn = Math.max(0, Math.round((live.expiresAt - Date.now()) / 60000));

  return (
    <div
      data-testid="input-request-card"
      data-state="pending"
      className="overflow-hidden rounded-md border border-border border-l border-l-primary bg-card"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium text-foreground">{live.card.title}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {t("inputRequest.expiresIn", { minutes: expiresIn })}
        </span>
      </div>
      <div className="space-y-3 px-3 py-2">
        {live.card.detail && (
          <div className="whitespace-pre-wrap text-xs text-muted-foreground">{live.card.detail}</div>
        )}
        {live.card.fields.map((f) => (
          <div key={f.key} className="space-y-1.5" data-testid="input-request-field">
            {f.kind !== "boolean" && (
              <div className="text-sm font-medium text-foreground">
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
        {error && (
          <div role="alert" className="text-xs text-destructive">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={cancel}
            data-testid="input-request-cancel"
            className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" aria-hidden="true" />
            {t("inputRequest.cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            data-testid="input-request-submit"
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-3 w-3" aria-hidden="true" />
            )}
            {t("inputRequest.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}

export const InputRequestCard = memo(InputRequestCardBase);

// 供机场收件箱复用：一张不含工具块的卡（直接从行渲染）。
export function StandaloneInputRequestCard({ request }: { request: InputRequestView }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="input-request-standalone"
      className="rounded-md border border-border border-l border-l-primary bg-card p-3"
    >
      <div className="flex items-center gap-2 text-xs">
        <CircleHelp className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium text-foreground">{request.card.title}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {t("inputRequest.expiresIn", {
            minutes: Math.max(0, Math.round((request.expiresAt - Date.now()) / 60000)),
          })}
        </span>
      </div>
    </div>
  );
}
