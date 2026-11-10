// ZhiyuEmbedPage.tsx — the visitor-facing room: the widget iframe shell AND
// the full-page join-link view (add-zhiyu-website-embed group 5/6).
//
// Auth comes from the widget lane only (no platform login): on load the page
// POSTs a visit with the URL token and persists the issued tty in
// sessionStorage (per tab — guests never silently merge strangers). Everything
// the visitor sees is one banner line, the shared stream they were here for,
// and a composer capped by the same room's honesty system-events.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

interface EmbedSender {
  kind: "user" | "facade" | "agent" | "guest";
  display: string;
  onBehalfOf: string | null;
}

interface EmbedRow {
  seq: number;
  kind: "human" | "agent" | "system" | "event";
  senderMemberId?: string | null;
  fromAgent?: boolean;
  visibility: string;
  content: string;
  meta: Record<string, unknown> | null;
  provenance?: string | null;
  createdAt: number;
  sender?: EmbedSender | null;
}

interface VisitState {
  ref: string;
  display: string;
  memberId: string;
  roomId: string;
  title: string;
}

const EVENT_LABEL: Record<string, string> = {
  room_ended: "本次会话已结束",
  budget_exhausted: "今日接待额度已用完，请稍后再来或留言等真人",
  reply_cap_hit: "本轮席位已满员作答，其余席位保持静默",
  agent_failed: "接待席位暂时出了点问题",
  // Busy is not broken (clarify-zhiyu-guest-failure-copy): the server marks
  // 429/5xx/connection failures retryable, and telling a visitor "出了点问题"
  // when asking again would have worked pushes them away for nothing.
  agent_failed_retryable: "接待席位正忙，请稍后再问一次",
  agent_declined_insolvent: "接待席位暂时无法应答",
  agent_busy: "接待席位正在回答，请稍候",
  needs_you: "已为你呼叫真人",
  member_joined: "有人来到了会话",
  guest_joined: "一位访客进入了会话",
  guest_identified: "访客身份已确认",
  reply_cap_changed: "应答上限已调整",
  budget_changed: "每日预算已调整",
};

export function ZhiyuEmbedPage() {
  // Mounted from App's standalone branch (like SharePage), NOT under a
  // <Route path>: the token comes from the URL path, not useParams.
  const { pathname } = useLocation();
  const token = pathname.split("/")[3] ?? "";
  const fullPage = pathname.startsWith("/zhiyu/join/");
  const [visit, setVisit] = useState<VisitState | null>(null);
  const [tty, setTty] = useState<string | null>(null);
  const [rows, setRows] = useState<EmbedRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A seat can take 25s+ (measured 14.5/15.3/24.4/27.0s on the four demo seats).
  // A bubble that only says "…" for half a minute reads as dead air, so the
  // wait itself is shown: elapsed seconds, and an honest hint past 15s.
  const [nowMs, setNowMs] = useState(0);
  const [ended, setEnded] = useState(false);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [metaBanner, setMetaBanner] = useState<string>("");
  const [agents, setAgents] = useState<{ kind: string; display: string }[]>([]);
  const [overlays, setOverlays] = useState<Record<string, { display: string; text: string; startedAt: number }>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  const ttyKey = useMemo(() => `zy-tty:${token}`, [token]);
  const withTty = useCallback(
    (p: string) => (tty ? `${p}${p.includes("?") ? "&" : "?"}tty=${encodeURIComponent(tty)}` : p),
    [tty],
  );

  // Visit → persist tty per tab.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cached = sessionStorage.getItem(ttyKey);
        const v = await fetch(`/zhiyu/widget/${encodeURIComponent(token)}/visit${cached ? `?tty=${encodeURIComponent(cached)}` : ""}`, { method: "POST" });
        if (!v.ok) {
          setError(v.status === 404 ? "这间会话不存在或已下架" : `无法进入会话（${v.status}）`);
          return;
        }
        const data = (await v.json()) as VisitState & { tty: string | null };
        if (cancelled) return;
        setVisit(data);
        const t = data.tty ?? cached ?? null;
        if (t) {
          setTty(t);
          sessionStorage.setItem(ttyKey, t);
        }
        const m = await fetch(`/zhiyu/widget/meta?token=${encodeURIComponent(token)}&host=${encodeURIComponent(location.host)}`);
        if (m.ok) {
          const mj = await m.json();
          if (!cancelled) {
            setMetaBanner(mj.banner ?? "");
            if (Array.isArray(mj.agents)) setAgents(mj.agents);
          }
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, ttyKey]);

  // SSE stream + overlay (answering bubble and live deltas). The visitor's
  // first screen is the TAIL window too: a busy reception room opens on the
  // recent conversation instead of replaying every row since creation.
  useEffect(() => {
    if (!tty) return;
    let cancelled = false;
    let es: EventSource | null = null;
    void (async () => {
      let lastSeq = 0;
      try {
        const r = await fetch(withTty(`/api/zhiyu/widget/${encodeURIComponent(token)}/messages?tail=200`));
        if (r.ok) {
          const d = (await r.json()) as { messages?: EmbedRow[] };
          if (cancelled) return;
          const msgs = d.messages ?? [];
          if (msgs.length) {
            setRows(msgs);
            const last = msgs[msgs.length - 1];
            if (last) lastSeq = last.seq;
          }
        }
      } catch { /* best-effort: the stream still delivers the tail */ }
      if (cancelled) return;
      es = new EventSource(withTty(`/api/zhiyu/widget/${encodeURIComponent(token)}/events${lastSeq ? `?after=${lastSeq}` : ""}`));
      es.onmessage = (ev) => {
        try {
          const row = JSON.parse(ev.data) as EmbedRow;
          if (row.kind === "system" && row.meta?.event === "room_ended") setEnded(true);
          setRows((prev) => (prev.some((r) => r.seq === row.seq) ? prev : [...prev, row]));
          if (row.kind === "agent" && row.senderMemberId) {
            const sid = row.senderMemberId;
            setOverlays((prev) => {
              if (!prev[sid]) return prev;
              const next = { ...prev };
              delete next[sid];
              return next;
            });
          }
        } catch { /* malformed frame */ }
      };
      es.addEventListener("overlay", (ev) => {
        try {
          const o = JSON.parse((ev as MessageEvent).data) as { type: string; memberId: string; display?: string; delta?: string };
          if (o.type === "agent_start") {
            setOverlays((prev) => ({ ...prev, [o.memberId]: { display: o.display ?? "", text: "", startedAt: Date.now() } }));
          } else if (o.type === "agent_delta") {
            setOverlays((prev) => {
              const cur = prev[o.memberId];
              if (!cur) return prev;
              return { ...prev, [o.memberId]: { ...cur, text: cur.text + (o.delta ?? "") } };
            });
          } else if (o.type === "agent_done") {
            setOverlays((prev) => {
              if (!prev[o.memberId]) return prev;
              const next = { ...prev };
              delete next[o.memberId];
              return next;
            });
          }
        } catch { /* malformed overlay */ }
      });
    })();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [tty, token, withTty]);

  const hasOverlays = Object.keys(overlays).length > 0;
  useEffect(() => {
    if (!hasOverlays) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasOverlays]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rows is an intentional re-scroll trigger, not a value the effect body reads
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [rows]);

  // @mention completion on the last @ fragment — names come from the widget
  // meta lineup (guests should never have to guess who answers).
  const mentionFragment = useMemo(() => {
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(composer);
    return m?.[2] ?? null;
  }, [composer]);
  const mentionCandidates = useMemo(() => {
    if (mentionFragment === null) return [];
    const frag = mentionFragment.toLowerCase();
    return agents.filter((a) => a.display.toLowerCase().includes(frag)).slice(0, 6);
  }, [mentionFragment, agents]);
  const completeMention = (display: string) => {
    setComposer((prev) => prev.replace(/@([^\s@]{0,30})$/, `@${display} `));
  };

  const send = async () => {
    const content = composer.trim();
    if (!content || !tty || busy) return;
    setBusy(true);
    try {
      const r = await fetch(withTty(`/api/zhiyu/widget/${encodeURIComponent(token)}/messages`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (r.status === 429) {
        setError("你说得有点快，请慢一点再来");
        return;
      }
      if (!r.ok) {
        setError(r.status === 409 ? "本次会话已结束" : `发送失败（${r.status}）`);
        return;
      }
      setComposer("");
      setError(null);
    } finally {
      setBusy(false);
    }
  };

  if (error && !visit) {
    return <div className="flex h-dvh items-center justify-center bg-background p-8 text-sm text-muted-foreground">{error}</div>;
  }

  // Busy-vs-broken (clarify-zhiyu-guest-failure-copy): a retryable failure reads
  // as a different label; both stay in the whitelist so neither is hidden.
  const labelFor = (meta: Record<string, unknown> | null): string | null => {
    const key = String(meta?.event ?? "");
    if (key === "agent_failed" && meta?.retryable === true) return "agent_failed_retryable";
    return EVENT_LABEL[key] ? key : null;
  };
  const visible = rows.filter((r) => r.kind !== "event" || labelFor(r.meta) !== null);
  // This visitor's own seat id — the only thing that may render as "我".
  const myMemberId = visit?.memberId ?? null;

  return (
    <div className={`flex h-dvh flex-col bg-background text-foreground ${fullPage ? "mx-auto w-full max-w-3xl" : ""}`}>
      <header className="border-b px-4 py-2.5">
        <div className="truncate text-sm font-semibold">{visit?.title ?? "接待会话"}</div>
        <div className="truncate text-xs text-muted-foreground">{metaBanner || "你是访客身份，由值守分身接待"}</div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {visible.map((row) => {
          if (row.kind === "system" || row.kind === "event") {
            const key = String(row.meta?.event ?? "");
            // A system row whose content IS the message (the greeting is the
            // flagship case) renders its text; meta-only rows keep their label.
            return (
              <div key={row.seq} className="my-1.5 text-center text-xs text-muted-foreground">
                {row.content?.trim() ? row.content : (EVENT_LABEL[labelFor(row.meta) ?? key] ?? key)}
              </div>
            );
          }
          // Attribution must compare the SENDER to this visitor's own seat
          // (fix-zhiyu-embed-sender-attribution): a reception room is
          // multi-visitor, and "kind === human" made every other visitor's
          // question render as the reader's own words.
          const mine = Boolean(myMemberId) && row.kind === "human" && row.senderMemberId === myMemberId;
          const senderLabel = mine
            ? "我"
            : row.sender
              ? row.sender.kind === "facade"
                ? `${row.sender.display}（代 ${row.sender.onBehalfOf} 出席）`
                : row.sender.display || "访客"
              : row.kind === "agent"
                ? "接待"
                : "访客";
          return (
            <div key={row.seq} className={`mb-3 flex ${mine ? "flex-row-reverse" : ""}`}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${mine ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                <div className={`mb-0.5 text-xs ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{senderLabel}</div>
                <div className="whitespace-pre-wrap break-words">{row.content}</div>
              </div>
            </div>
          );
        })}
        {Object.entries(overlays).map(([memberId, o]) => (
          <div key={memberId} className="mb-3 flex">
            <div className="max-w-[85%] rounded-2xl bg-muted px-3.5 py-2 text-sm opacity-80">
              <div className="mb-0.5 text-xs text-muted-foreground">
                {o.display} · 正在作答
                {(() => {
                  const now = nowMs || Date.now();
                  const waited = Math.max(0, Math.round((now - (o.startedAt ?? now)) / 1000));
                  if (waited < 3) return null;
                  return waited >= 15 ? `（已等 ${waited} 秒，上游较慢，仍在等）` : `（已等 ${waited} 秒）`;
                })()}
              </div>
              <div className="whitespace-pre-wrap break-words">{o.text || "…"}</div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <div className="mx-3 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}

      {!ended ? (
        <div className="relative flex items-end gap-2 border-t p-3">
          {mentionCandidates.length > 0 && (
            <div className="absolute bottom-full left-3 mb-1 w-64 rounded-md border bg-popover p-1 shadow-md">
              {mentionCandidates.map((a) => (
                <button
                  key={a.display}
                  type="button"
                  className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => completeMention(a.display)}
                >
                  @{a.display} <span className="text-xs text-muted-foreground">{a.kind === "facade" ? "（分身）" : ""}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="输入消息…可直接 @接待分身"
            className="min-h-[44px] flex-1 rounded-md border bg-background px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={!composer.trim() || busy}
            onClick={() => void send()}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            发送
          </button>
        </div>
      ) : (
        <div className="border-t px-4 py-3 text-center text-xs text-muted-foreground">本次会话已结束 — 感谢你的到访</div>
      )}
      <footer className="px-4 py-1.5 text-center text-[11px] text-muted-foreground/60">
        由 壹座·萬星智语 提供
      </footer>
    </div>
  );
}
