// ── Meeting capture panel (openspec: add-meeting-capture, 5.1) ───────────────
//
// The room's meeting affordance, kept deliberately small: open a meeting, join
// it (which claims YOUR stream), see who is in and whose stream is still open,
// and end it. Everything it shows comes from the meeting read face, and the two
// facts that are easy to misread are stated in the UI rather than implied:
//
//   • 「到达顺序」 — the messages of one meeting arrive in device-arrival order.
//     There is no shared clock across phones, so claiming a strict timeline
//     would be precise-looking and wrong (design D5).
//   • 「待确认」 — a stream that named nobody is waiting for a human. It is not
//     "being processed"; it will never dispatch until someone answers.
//
// The panel does not offer a download or a re-record: those belong to the
// capture lane, which this file must not duplicate.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface MeetingRow {
  id: string;
  roomId: string;
  title: string;
  ownerEmail: string;
  status: "open" | "ended";
  createdAt: number;
  endedAt: number | null;
}

interface ParticipantRow {
  meetingId: string;
  memberId: string;
  memberRef: string;
  captureId: string | null;
  state: "joined" | "finished" | "abandoned";
  joinedAt: number;
  finishedAt: number | null;
}

interface MeetingView {
  meeting: MeetingRow;
  participants: ParticipantRow[];
  delivered: number;
  awaitingConfirmation: number;
  orderBasis: "arrival";
}

async function jcall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
  return data as T;
}

export function MeetingPanel({
  roomId,
  onError,
  onRecordMine,
}: {
  roomId: string;
  onError?: (msg: string) => void;
  /** Opens the capture lane in meeting mode for MY seat
   *  (openspec: meeting-capture-client-wiring, D4). The panel deliberately does
   *  not embed a recorder: a second implementation of slicing/retry would drift
   *  from the capture lane, and the lane already knows how to do it. */
  onRecordMine?: (ctx: { meetingId: string; roomId: string }) => void;
}) {
  const { t } = useTranslation();
  const [meeting, setMeeting] = useState<MeetingRow | null>(null);
  const [view, setView] = useState<MeetingView | null>(null);
  // 我在这一场里的那一路（add-meeting-discovery）：null = 我还没加入。
  // 没有它，「已加入」就无从渲染，刷新一次就会把已经认领的那一路再问一遍。
  const [mine, setMine] = useState<ParticipantRow | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const fail = useCallback(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      onError?.(msg);
    },
    [onError],
  );

  const refresh = useCallback(async () => {
    if (!meeting) return;
    try {
      setView(await jcall<MeetingView>("GET", `/api/zhiyu/meetings/${encodeURIComponent(meeting.id)}`));
      const open = await jcall<{ meeting: MeetingRow | null; participant: ParticipantRow | null }>(
        "GET",
        `/api/zhiyu/rooms/${encodeURIComponent(roomId)}/meetings/open`,
      );
      // 只在同一场时采信：另一个标签页可能已经结束了它并开了新的一场。
      setMine(open.meeting?.id === meeting.id ? open.participant : null);
    } catch (err) {
      fail(err);
    }
  }, [meeting, roomId, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // On mount, discover what is already running in this room (add-meeting-discovery).
  //
  // Before this, the panel only ever knew about a meeting IT had created in this
  // page: reload the page — or walk in as the second person — and the meeting was
  // invisible, so 「加入」could not be clicked at all. Discovery is read-only and
  // non-blocking: a failure here must not hide the 「发起」affordance.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const open = await jcall<{ meeting: MeetingRow | null; participant: ParticipantRow | null }>(
          "GET",
          `/api/zhiyu/rooms/${encodeURIComponent(roomId)}/meetings/open`,
        );
        if (!alive || !open.meeting) return;
        setMeeting(open.meeting);
        setMine(open.participant);
      } catch {
        /* 发现失败不阻塞：面板还能发起新会议 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [roomId]);

  const open = async () => {
    setBusy(true);
    try {
      const out = await jcall<{ meeting: MeetingRow }>("POST", `/api/zhiyu/rooms/${encodeURIComponent(roomId)}/meetings`, {
        title: title.trim(),
      });
      setMeeting(out.meeting);
      setTitle("");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    if (!meeting) return;
    setBusy(true);
    try {
      const out = await jcall<{ participant: ParticipantRow }>(
        "POST",
        `/api/zhiyu/meetings/${encodeURIComponent(meeting.id)}/join`,
        {},
      );
      setMine(out.participant);
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    if (!meeting) return;
    setBusy(true);
    try {
      const out = await jcall<{ meeting: MeetingRow }>(
        "POST",
        `/api/zhiyu/meetings/${encodeURIComponent(meeting.id)}/end`,
        {},
      );
      setMeeting(out.meeting);
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t px-4 py-3" data-testid="zhiyu-meeting-panel">
      <div className="flex items-center gap-2">
        <Label htmlFor="meeting-title" className="text-xs text-muted-foreground">
          {t("zhiyu.meeting.titleLabel")}
        </Label>
        <Input
          id="meeting-title"
          className="h-7 max-w-48"
          value={title}
          placeholder={t("zhiyu.meeting.titlePlaceholder")}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="zhiyu-meeting-title"
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void open()} data-testid="zhiyu-meeting-open">
          {t("zhiyu.meeting.open")}
        </Button>
        {meeting && meeting.status === "open" && (
          <>
            <span className="text-xs text-muted-foreground" data-testid="zhiyu-meeting-running">
              {t("zhiyu.meeting.running", { by: meeting.ownerEmail })}
            </span>
            {mine ? (
              <>
                <span className="text-xs text-muted-foreground" data-testid="zhiyu-meeting-joined">
                  {t("zhiyu.meeting.joined")}
                </span>
                {/* Only after joining: a stream belongs to a participant, and
                    the server refuses to bind one that never joined (409). */}
                {onRecordMine && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onRecordMine({ meetingId: meeting.id, roomId })}
                    data-testid="zhiyu-meeting-record-mine"
                  >
                    {t("zhiyu.meeting.recordMine")}
                  </Button>
                )}
              </>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void join()} data-testid="zhiyu-meeting-join">
                {t("zhiyu.meeting.join")}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void end()} data-testid="zhiyu-meeting-end">
              {t("zhiyu.meeting.end")}
            </Button>
          </>
        )}
        {meeting && meeting.status === "ended" && (
          <span className="text-xs text-muted-foreground" data-testid="zhiyu-meeting-ended">
            {t("zhiyu.meeting.ended")}
          </span>
        )}
      </div>

      {view && (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="zhiyu-meeting-view">
          <div className="flex flex-wrap gap-3">
            <span>
              {t("zhiyu.meeting.participants", { count: view.participants.length })}
            </span>
            <span data-testid="zhiyu-meeting-delivered">
              {t("zhiyu.meeting.delivered", { count: view.delivered })}
            </span>
            <span data-testid="zhiyu-meeting-awaiting">
              {t("zhiyu.meeting.awaiting", { count: view.awaitingConfirmation })}
            </span>
            {/* Stated, not implied: phones have no shared clock. */}
            <span data-testid="zhiyu-meeting-order">{t("zhiyu.meeting.orderArrival")}</span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {view.participants.map((p) => (
              <li key={p.memberRef} className="flex gap-2" data-testid={`zhiyu-meeting-participant-${p.memberRef}`}>
                <span>{p.memberRef}</span>
                <span>
                  {p.state === "finished"
                    ? t("zhiyu.meeting.streamFinished")
                    : p.state === "abandoned"
                      ? t("zhiyu.meeting.streamAbandoned")
                      : t("zhiyu.meeting.streamJoined")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
