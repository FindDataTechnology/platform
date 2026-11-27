// MeetingRoomPage — join a self-hosted audio meeting (add-ai-native-meeting 3.2).
//
// This is deliberately NOT a re-implementation of a meeting app. A meeting is a
// room's extension (§design D2): the seat, the members, the message flow already
// live in the room. This page adds exactly what the room cannot do — a live
// audio channel — and nothing else:
//
//   • resolve a join token from the platform (the browser holds no secret; the
//     server mints it, the token names the meeting's media room and the seat),
//   • connect to LiveKit, publish the mic, play what others publish,
//   • show who is in (participants come from LiveKit, the same seats),
//   • leave.
//
// Recordings, transcripts-into-the-room and the agent worker run server-side and
// are already wired; this page is the human end of that channel.
//
// livekit-client is a ~150-180 KB gzip dependency; it is imported HERE and this
// page is lazy-loaded (App.tsx), so it never enters the main bundle.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import type { Room as LKRoom, RemoteParticipant, LocalParticipant } from "livekit-client";
import { Button } from "@/components/ui/button";

type Status = "connecting" | "connected" | "left" | "error";

interface TokenResp {
  token: string;
  room: string;
  url: string | null;
}

export function MeetingRoomPage() {
  const { t } = useTranslation();
  const { meetingId } = useParams<{ meetingId: string }>();
  const roomRef = useRef<LKRoom | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [mic, setMic] = useState(false);
  const [peers, setPeers] = useState<{ identity: string; name: string; speaking: boolean }[]>([]);

  const refreshRoster = useCallback(() => {
    const r = roomRef.current;
    if (!r) return;
    const list = [
      { identity: r.localParticipant.identity, name: r.localParticipant.name || r.localParticipant.identity, speaking: r.localParticipant.isSpeaking },
      ...[...r.remoteParticipants.values()].map((p: RemoteParticipant) => ({
        identity: p.identity,
        name: p.name || p.identity,
        speaking: p.isSpeaking,
      })),
    ];
    setPeers(list);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. token from the platform (gates: member, meeting open, joined)
        const res = await fetch(`/api/zhiyu/meetings/${encodeURIComponent(meetingId ?? "")}/token`, { credentials: "same-origin" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `token failed (${res.status})`);
        }
        const { token, url } = (await res.json()) as TokenResp;
        if (!url) throw new Error(t("meeting.noUrl"));
        if (cancelled) return;
        // `url` may be ROOT-RELATIVE (`/livekit`): the edge fronts LiveKit under
        // a path on whatever hostname the user is on. Resolving against this
        // page's origin is what lets one deployment be reached under more than
        // one front door (`platform.` and `paas.` both exist) without baking a
        // hostname into the server env — measured 2026-11-24: an absolute URL
        // on the server sent `platform.` visitors to the other host and the
        // SPA answered instead of LiveKit.
        const endpoint = url.startsWith("/")
          ? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${url}`
          : url;

        // 2. connect. Imported dynamically so the dependency stays in this chunk.
        const { Room, RoomEvent } = await import("livekit-client");
        const room = new Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;
        room.on(RoomEvent.ParticipantConnected, refreshRoster);
        room.on(RoomEvent.ParticipantDisconnected, refreshRoster);
        room.on(RoomEvent.ActiveSpeakersChanged, refreshRoster);
        room.on(RoomEvent.Disconnected, () => setStatus("left"));
        await room.connect(endpoint, token);
        if (cancelled) { room.disconnect(); return; }
        setStatus("connected");
        refreshRoster();
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      try { roomRef.current?.disconnect(); } catch { /* already gone */ }
      roomRef.current = null;
    };
  }, [meetingId, refreshRoster, t]);

  const toggleMic = useCallback(async () => {
    const lp: LocalParticipant | undefined = roomRef.current?.localParticipant;
    if (!lp) return;
    try {
      const next = !mic;
      await lp.setMicrophoneEnabled(next);
      setMic(next);
      refreshRoster();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [mic, refreshRoster]);

  const leave = useCallback(() => {
    roomRef.current?.disconnect();
    setStatus("left");
  }, []);

  return (
    <div className="flex h-full flex-col gap-4 p-4" data-testid="meeting-room" data-state={status}>
      <header className="flex items-center justify-between border-b pb-2">
        <h1 className="text-base font-semibold">{t("meeting.title")}</h1>
        <span className="text-xs text-muted-foreground" data-testid="meeting-status">{t(`meeting.status.${status}`)}</span>
      </header>

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="meeting-error">
          {error}
        </div>
      )}

      <section className="flex-1" data-testid="meeting-roster">
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">{t("meeting.participants", { count: peers.length })}</h2>
        <ul className="space-y-1.5">
          {peers.map((p) => (
            <li key={p.identity} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm" data-testid={`meeting-peer-${p.identity}`}>
              <span className={`h-2 w-2 rounded-full ${p.speaking ? "bg-success" : "bg-muted-foreground/30"}`} aria-hidden="true" />
              <span className="truncate">{p.name}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="flex gap-2 border-t pt-3">
        <Button
          variant={mic ? "default" : "outline"}
          onClick={() => void toggleMic()}
          disabled={status !== "connected"}
          data-testid="meeting-mic"
          data-state={mic ? "on" : "off"}
        >
          {mic ? t("meeting.micOn") : t("meeting.micOff")}
        </Button>
        <Button variant="outline" onClick={leave} disabled={status === "left"} data-testid="meeting-leave">
          {t("meeting.leave")}
        </Button>
      </footer>
    </div>
  );
}
