// web/src/components/voice/CaptureSession.tsx — the meeting capture surface
// (openspec: add-voice-capture-lane, 5.1–5.3).
//
// The shape mirrors the server's own promise: a capture is a series of slices,
// each slice is transcribed on its own, and the text is readable BEFORE the
// meeting ends. So the surface never shows one "processing" spinner for the
// whole recording — it shows one row per slice, and a failed row stays a
// failed row with its own retry.
//
// Four decisions worth knowing:
//   • Slicing uses stop/start on ONE MediaStream. A single recorder's
//     `timeslice` blobs are fragments of one WebM stream (only the first has a
//     header), so they are not independently decodable — each slice must be its
//     own recorder. The stop/start gap is milliseconds and is absorbed by the
//     slice grid, not by stretching the audio.
//   • Slice boundaries come from the shared planSlices grid (30s), so all three
//     clients agree on where slice N starts; the DURATION is measured from the
//     wall clock so the budget reflects the audio actually captured.
//   • Uploads are fired per slice and never awaited by the recorder: one slow
//     transcription (up to 120s upstream) must not stall the next 30s slice.
//   • Retry posts the SAME seq with NO file — the server kept the failed
//     slice's audio, and re-uploading it would burn bandwidth for nothing.
//
// Refusals are rendered from their CODE, not the server's English message, so
// each one can tell the user the true next step.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  captureProgress,
  exportCaptureText,
  formatOffset,
  planSlices,
  sliceAction,
  type CaptureSlice,
  type SliceState,
} from "@platform/core";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/ui/status-pill";
import { Textarea } from "@/components/ui/textarea";
import type { StatusKind } from "@/lib/statusTokens";
import { createBrowserPcmCapture, type PcmCapture } from "@/lib/voice-adapter.ts";
import { encodeWav } from "@/lib/wav-encoder.ts";
import {
  CaptureRequestError,
  abandonCapture,
  bindMeetingCapture,
  correctCapture,
  createCapture,
  fetchCaptureVoiceStatus,
  finishCapture,
  sendCaptureToRoom,
  sendCaptureToVoiceRoom,
  uploadCaptureChunk,
  type CaptureSegment,
  type CaptureVoiceStatus,
  type ChunkStatus,
  type ChunkUploadOutcome,
  type VoiceCapture,
  type VoiceCaptureChunk,
} from "@/lib/capture-api";

/** Server default slice (voice-capture.js CAPTURE_DEFAULTS is 30s; the shared
 *  plan takes this as its chunkMs). */
const SLICE_MS = 30_000;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set when this session records ONE person's stream for a meeting
   *  (openspec: meeting-capture-client-wiring, D4). The panel that opened it
   *  passes the meeting it belongs to; absent = the loose capture path, which
   *  must behave exactly as before. */
  meetingId?: string;
  /** The meeting's 智语 room (`zy_…`), used to prefill the send-to-room step.
   *  Prefill only — joining still needs the explicit confirmation (D3). */
  meetingRoomId?: string;
}

/** FALLBACK container, only reached when the browser has no Web Audio.
 *  The 词元 lane refuses webm/ogg/fragmented mp4 (measured 2026-11-15: all
 *  400), so the normal path encodes a complete WAV per slice instead
 *  (openspec: fix-voice-transcription-container). */
function pickAudioMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m));
}

function pendingChunk(slice: CaptureSlice): VoiceCaptureChunk {
  return {
    seq: slice.seq,
    startMs: slice.startMs,
    durationMs: slice.durationMs,
    status: "pending",
    text: "",
    attempts: 0,
    errorCode: null,
    hasAudio: true,
    bytes: 0,
    mime: null,
  };
}

function upsertChunk(list: VoiceCaptureChunk[], chunk: VoiceCaptureChunk): VoiceCaptureChunk[] {
  const index = list.findIndex((c) => c.seq === chunk.seq);
  if (index < 0) return [...list, chunk].sort((a, b) => a.seq - b.seq);
  const next = [...list];
  next[index] = chunk;
  return next;
}

function pillKind(status: ChunkStatus): StatusKind {
  if (status === "done") return "neutral";
  if (status === "failed") return "failed";
  if (status === "transcribing") return "running";
  return "waiting";
}

export function CaptureSession({ open, onOpenChange, meetingId, meetingRoomId }: Props) {
  const { t, i18n } = useTranslation();

  const [voice, setVoice] = useState<CaptureVoiceStatus | null>(null);
  const [capture, setCapture] = useState<VoiceCapture | null>(null);
  const [chunks, setChunks] = useState<VoiceCaptureChunk[]>([]);
  const [retryableBySeq, setRetryableBySeq] = useState<Record<number, boolean>>({});
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finished, setFinished] = useState(false);
  const [segments, setSegments] = useState<CaptureSegment[]>([]);
  const [draft, setDraft] = useState("");
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [busySeq, setBusySeq] = useState<number | null>(null);
  const [sendingRoom, setSendingRoom] = useState(false);
  // Uploads in flight. Finishing while one is still transcribing would merge the
  // slices that already landed and then reject the straggler (the capture stops
  // recording), silently dropping the last 30s of the meeting.
  const [inFlight, setInFlight] = useState(0);
  const [stopped, setStopped] = useState<"minutes" | "usd" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState(meetingRoomId ?? "");
  const [roomOpen, setRoomOpen] = useState(false);
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [openSlice, setOpenSlice] = useState<{ seq: number; startMs: number } | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  // Per-slice PCM tap. Its lifetime is ONE slice, exactly like the recorder it
  // replaces, because each slice must be independently decodable.
  const pcmRef = useRef<PcmCapture | null>(null);
  const piecesRef = useRef<Blob[]>([]);
  const sliceRef = useRef<{ seq: number; startMs: number; startedAt: number } | null>(null);
  const timerRef = useRef<number | null>(null);
  const captureIdRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const recordingRef = useRef(false);
  // Monotonic slice cursor for one recording (see startSlice's guard).
  const seqRef = useRef(0);
  const startRef = useRef(-1);
  // Set when the recorder is being torn down for good (abandon / unmount): the
  // pending slice must be discarded, not uploaded to a capture being deleted.
  const discardRef = useRef(false);

  const corrected = Boolean(capture?.correctedAt);

  const errorText = (err: unknown): string => {
    const code = err instanceof CaptureRequestError ? err.code : "internal_error";
    return t(`voiceCapture.errors.${code}`, { defaultValue: t("voiceCapture.errors.internal_error") });
  };

  // Availability is re-read on open: the lane can be disabled or lose its key
  // between two visits, and an entry that pretends otherwise wastes a click.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    setMicError(null);
    let alive = true;
    fetchCaptureVoiceStatus()
      .then((v) => {
        if (alive) setVoice(v);
      })
      .catch(() => {
        // Read failure is not proof the lane is down: keep the controls and let
        // the create call surface the real refusal code.
        if (alive) setVoice(null);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // Elapsed clock while recording (display only; the timeline uses real
  // timestamps, this only tells the reader how long the meeting has run).
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1000);
    return () => window.clearInterval(id);
  }, [recording]);

  // Unmount: stop the mic and discard the open slice. The capture itself stays
  // on the server (TTL-bounded) — closing the dialog is not an abandon.
  useEffect(() => {
    return () => {
      discardRef.current = true;
      recordingRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      const rec = recorderRef.current;
      recorderRef.current = null;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          /* already inactive */
        }
      }
      streamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });
      streamRef.current = null;
    };
  }, []);

  const stopSlice = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== "inactive") {
      rec.stop(); // onstop → closeSlice
      return;
    }
    // The PCM path has no onstop event: closing the slice IS the stop.
    if (pcmRef.current) closeSlice();
  };

  const stopRecording = () => {
    recordingRef.current = false;
    setRecording(false);
    stopSlice();
  };

  const applyOutcome = (out: ChunkUploadOutcome) => {
    if (out.chunk) {
      const landed = out.chunk;
      setChunks((prev) => upsertChunk(prev, landed));
      if (out.retryable !== undefined) {
        setRetryableBySeq((prev) => ({ ...prev, [landed.seq]: out.retryable === true }));
      }
    }
    if (out.stopped) {
      setStopped(out.stopped);
      // At a ceiling the server still stores the slice but stops paying for
      // transcription. Stop capturing so the rest of the meeting is not turned
      // into silent buffered slices the user believes were transcribed.
      if (recordingRef.current) stopRecording();
    }
  };

  const sendSlice = async (id: string, slice: CaptureSlice, audio: Blob) => {
    setChunks((prev) => upsertChunk(prev, pendingChunk(slice)));
    setInFlight((n) => n + 1);
    try {
      applyOutcome(await uploadCaptureChunk(id, slice, audio));
    } catch {
      // The bytes never reached the server: no slice exists to retry against,
      // so the row says so instead of pretending a transcription failed.
      setChunks((prev) => upsertChunk(prev, { ...pendingChunk(slice), status: "failed", errorCode: "network" }));
      setError(t("voiceCapture.errors.network"));
    } finally {
      setInFlight((n) => Math.max(0, n - 1));
    }
  };

  const startSlice = () => {
    const stream = streamRef.current;
    const id = captureIdRef.current;
    if (!stream || !id || !recordingRef.current) return;

    // Normal path: a PCM tap for THIS slice → complete WAV on close. Each
    // slice is its own tap for the same reason it was its own recorder: a
    // streaming container's later fragments are not independently decodable,
    // and the lane refuses that container anyway.
    const tap = createBrowserPcmCapture(stream);
    if (tap) {
      pcmRef.current = tap;
      tap.start();
    }

    let rec: MediaRecorder | null = null;
    if (!tap) {
      try {
        const mime = pickAudioMime();
        rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      } catch {
        setMicError(t("voiceCapture.micUnsupported"));
        // No recorder means no slice will ever close: release the microphone
        // here instead of leaving a live stream behind.
        streamRef.current?.getTracks().forEach((track) => {
          track.stop();
        });
        streamRef.current = null;
        stopRecording();
        return;
      }
    }

    // Slice N starts on the shared 30s grid; duration is measured at close.
    // The monotonic guards matter: a timer that fires a millisecond early must
    // not reuse a seq or repeat an offset — the server would treat the retry as
    // an idempotent replay and drop the new audio.
    const elapsed = Date.now() - startedAtRef.current;
    const planned = planSlices(elapsed + 1, SLICE_MS).at(-1);
    const seq = Math.max(planned?.seq ?? 0, seqRef.current);
    const startMs = Math.max(planned?.startMs ?? elapsed, startRef.current + 1);
    seqRef.current = seq + 1;
    startRef.current = startMs;

    sliceRef.current = { seq, startMs, startedAt: Date.now() };
    piecesRef.current = [];
    recorderRef.current = rec;
    if (rec) {
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) piecesRef.current.push(ev.data);
      };
      rec.onstop = () => closeSlice();
      rec.start();
    }
    setOpenSlice({ seq, startMs });

    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => stopSlice(), SLICE_MS);
  };

  const closeSlice = () => {
    const current = sliceRef.current;
    const pieces = piecesRef.current;
    piecesRef.current = [];
    sliceRef.current = null;
    setOpenSlice(null);

    const tap = pcmRef.current;
    pcmRef.current = null;

    if (discardRef.current) {
      if (tap) {
        try {
          tap.stop(); // drain and drop: a discarded slice leaves nothing behind
        } catch {
          // Best-effort.
        }
      }
      return;
    }

    const id = captureIdRef.current;
    if (current && id) {
      const durationMs = Math.max(0, Date.now() - current.startedAt);
      let blob: Blob | null = null;
      if (tap) {
        const captured = tap.stop();
        const frames = captured.reduce((n, c) => n + c.length, 0);
        // A 44-byte empty WAV is still a valid file, but uploading silence
        // would burn a transcription attempt: an empty slice is simply not sent.
        if (frames > 0) blob = new Blob([encodeWav({ chunks: captured, sampleRate: tap.sampleRate }).bytes], { type: "audio/wav" });
      } else if (pieces.length > 0) {
        blob = new Blob(pieces, { type: pieces[0]?.type || "audio/webm" });
      }
      if (blob) void sendSlice(id, { seq: current.seq, startMs: current.startMs, durationMs }, blob);
    }
    // Keep the cadence: the next slice starts as soon as this one is closed —
    // the upload above runs in the background.
    if (recordingRef.current) startSlice();
  };

  const bindToMeeting = async (captureId: string) => {
    if (!meetingId) return;
    try {
      await bindMeetingCapture(meetingId, captureId);
      setNotice(t("zhiyu.meeting.boundMine"));
    } catch {
      // 409 not_joined / transport: the stream keeps recording. Saying so is
      // the point — a silently unbound stream is the failure this lane exists
      // to prevent, so the user gets a retryable line instead of silence.
      setNotice(t("zhiyu.meeting.bindFailed"));
    }
  };

  const start = async () => {
    if (starting || recording) return;
    if (capture && capture.status === "recording" && !finished) return;
    setError(null);
    setMicError(null);
    setNotice(null);
    setStopped(null);
    setStarting(true);
    let stream: MediaStream | null = null;
    try {
      if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setMicError(t("voiceCapture.micUnsupported"));
        return;
      }
      // Permission comes FIRST: a denied microphone must not leave an empty
      // capture row on the server.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Declare WHAT this stream is, not WHO speaks: the server derives the
      // owner from the authenticated subject (meeting-capture-client-wiring D1).
      const created = await createCapture({
        title: t("voiceCapture.defaultTitle", { time: new Date().toLocaleString(i18n.language) }),
        ...(meetingId ? { speakerMode: "session" as const, meetingId } : {}),
      });
      captureIdRef.current = created.id;
      setCapture(created);
      setChunks([]);
      setRetryableBySeq({});
      setSegments([]);
      setDraft("");
      setFinished(false);
      setRoomId(meetingRoomId ?? "");
      streamRef.current = stream;
      discardRef.current = false;
      startedAtRef.current = Date.now();
      seqRef.current = 0;
      startRef.current = -1;
      setElapsedMs(0);
      recordingRef.current = true;
      setRecording(true);
      startSlice();
      // Bind AFTER the mic is live: a bind failure must never cost the
      // recording, and an unbound stream dispatches to nobody (D2).
      if (meetingId) void bindToMeeting(created.id);
    } catch (err) {
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
      const name = (err as Error | null)?.name;
      if (name === "NotAllowedError" || name === "NotFoundError" || name === "NotReadableError") {
        setMicError(t("voiceCapture.micDenied", { error: name }));
      } else {
        setError(errorText(err));
      }
    } finally {
      setStarting(false);
    }
  };

  const finish = async () => {
    const id = captureIdRef.current;
    // A slice still uploading would be rejected once the capture is finished.
    if (!id || finishing || inFlight > 0) return;
    setFinishing(true);
    setError(null);
    try {
      const out = await finishCapture(id);
      setCapture(out.capture);
      setSegments(out.segments);
      setDraft(out.capture.mergedText ?? "");
      setFinished(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setFinishing(false);
    }
  };

  const saveCorrection = async () => {
    const id = captureIdRef.current;
    if (!id || corrected) return;
    setSavingCorrection(true);
    setError(null);
    try {
      const updated = await correctCapture(id, draft);
      setCapture(updated);
      setNotice(t("voiceCapture.saved"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSavingCorrection(false);
    }
  };

  const exportText = () => {
    const text = exportCaptureText(segments);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const name = (capture?.title || capture?.id || "capture").replace(/[\\/:*?"<>|]+/g, "_");
    anchor.href = url;
    anchor.download = `${name}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking synchronously can cancel the download in some browsers; one tick
    // later the navigation has already been handed off.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const retry = async (chunk: VoiceCaptureChunk) => {
    const id = captureIdRef.current;
    if (!id || busySeq !== null) return;
    setBusySeq(chunk.seq);
    setError(null);
    setInFlight((n) => n + 1);
    try {
      // No file on purpose: the server kept the failed slice's audio.
      const out = await uploadCaptureChunk(
        id,
        { seq: chunk.seq, startMs: chunk.startMs, durationMs: chunk.durationMs },
        null,
      );
      applyOutcome(out);
      // A retry can be refused outright (audio already purged, retries spent).
      // The slice row already says its state; the banner explains the refusal.
      if (!out.ok && out.code) {
        setError(t(`voiceCapture.errors.${out.code}`, { defaultValue: t("voiceCapture.errors.internal_error") }));
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusySeq(null);
      setInFlight((n) => Math.max(0, n - 1));
    }
  };

  const sendToRoom = async () => {
    const id = captureIdRef.current;
    if (!id) return;
    const sessionId = roomId.trim();
    if (!sessionId) {
      setRoomOpen(false);
      setError(t("voiceCapture.roomNeedId"));
      return;
    }
    setSendingRoom(true);
    setRoomOpen(false);
    setError(null);
    try {
      // A `zy_…` id is a 智语 room: same confirmation, different consequence.
      // A chat session records the meeting; a 智语 room ROUTES it — the server
      // splits the text per speaker and each stretch goes to that person's agent
      // (or waits for a human when nobody knows who spoke).
      if (sessionId.startsWith("zy_")) {
        const out = await sendCaptureToVoiceRoom(id, sessionId);
        setNotice(
          out.alreadyInRoom
            ? t("voiceCapture.roomAlready", { sessionId: out.roomId ?? sessionId })
            : t("voiceCapture.roomSent", { sessionId: out.roomId ?? sessionId }),
        );
        return;
      }
      const out = await sendCaptureToRoom(id, sessionId);
      setNotice(
        out.alreadyInRoom
          ? t("voiceCapture.roomAlready", { sessionId: out.sessionId })
          : t("voiceCapture.roomSent", { sessionId: out.sessionId }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSendingRoom(false);
    }
  };

  /** Stop the mic and throw the open slice away (abandon / unmount). */
  const teardown = () => {
    discardRef.current = true;
    recordingRef.current = false;
    setRecording(false);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* already inactive */
      }
    }
    const tap = pcmRef.current;
    pcmRef.current = null;
    if (tap) {
      try {
        tap.stop(); // drain and drop — an abandoned slice uploads nothing
      } catch {
        /* already stopped */
      }
    }
    sliceRef.current = null;
    piecesRef.current = [];
    setOpenSlice(null);
    streamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });
    streamRef.current = null;
  };

  const abandon = async () => {
    const id = captureIdRef.current;
    setAbandonOpen(false);
    teardown();
    if (!id) {
      onOpenChange(false);
      return;
    }
    try {
      await abandonCapture(id);
      setNotice(t("voiceCapture.abandoned"));
    } catch (err) {
      setError(errorText(err));
    }
    captureIdRef.current = null;
    setCapture(null);
    setChunks([]);
    setRetryableBySeq({});
    setSegments([]);
    setDraft("");
    setFinished(false);
    setStopped(null);
    setRoomId("");
    onOpenChange(false);
  };

  // Closing while the microphone is live is a destructive action (the audio
  // already uploaded is deleted) — it goes through the abandon confirmation.
  // A confirm opened on top owns Escape/backdrop first: otherwise one Escape
  // would dismiss the confirm AND the capture dialog underneath it.
  const requestClose = (next: boolean) => {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (roomOpen) {
      setRoomOpen(false);
      return;
    }
    if (abandonOpen) {
      setAbandonOpen(false);
      return;
    }
    if (recordingRef.current) {
      setAbandonOpen(true);
      return;
    }
    onOpenChange(false);
  };

  const rows = useMemo(() => {
    const list = [...chunks];
    if (openSlice) {
      list.push({
        seq: openSlice.seq,
        startMs: openSlice.startMs,
        durationMs: null,
        status: "pending",
        text: "",
        attempts: 0,
        errorCode: null,
        hasAudio: true,
        bytes: 0,
        mime: null,
      });
    }
    return list.sort((a, b) => a.seq - b.seq);
  }, [chunks, openSlice]);

  // Progress counts only slices that actually exist on the server — an open
  // slice is not "waiting to be transcribed", it is still being recorded.
  const progress = useMemo(() => {
    const states: SliceState[] = chunks.map((c) => ({
      seq: c.seq,
      status: c.status,
      attempts: c.attempts,
      retryable: retryableBySeq[c.seq],
    }));
    const durationOf = (seq: number) => {
      const own = chunks.find((c) => c.seq === seq)?.durationMs;
      return own ?? SLICE_MS;
    };
    return captureProgress(states, durationOf);
  }, [chunks, retryableBySeq]);

  const plannedSlices = useMemo(() => planSlices(elapsedMs + 1, SLICE_MS).length, [elapsedMs]);
  const percent = Math.round(progress.fraction * 100);
  const canStart = !starting && !recording && !(capture?.status === "recording" && !finished);
  const canFinish = Boolean(capture) && !recording && !finishing && !finished && inFlight === 0;
  const retryClosed = finished || (capture !== null && capture.status !== "recording");

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto" data-testid="capture-dialog">
          <DialogHeader>
            <DialogTitle>{t("voiceCapture.title")}</DialogTitle>
            <DialogDescription>{t("voiceCapture.subtitle")}</DialogDescription>
          </DialogHeader>

          {voice && !voice.available ? (
            <div
              className="rounded-md border border-status-waiting/40 bg-card px-3 py-2 text-sm"
              data-testid="capture-unavailable"
            >
              <div className="font-medium text-status-waiting">{t("voiceCapture.unavailable.title")}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t(`voiceCapture.unavailable.${voice.reason ?? "generic"}`, {
                  defaultValue: t("voiceCapture.unavailable.generic"),
                })}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" disabled={!canStart} onClick={() => void start()} data-testid="capture-start">
                  {starting
                    ? t("voiceCapture.starting")
                    : capture && finished
                      ? t("voiceCapture.restart")
                      : t("voiceCapture.start")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!recording}
                  onClick={stopRecording}
                  data-testid="capture-stop"
                >
                  {t("voiceCapture.stop")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!canFinish}
                  onClick={() => void finish()}
                  data-testid="capture-finish"
                >
                  {finishing ? t("voiceCapture.finishing") : t("voiceCapture.finish")}
                </Button>
                {recording && (
                  <span className="text-xs tabular-nums text-muted-foreground" data-testid="capture-elapsed">
                    {t("voiceCapture.elapsed", {
                      at: formatOffset(elapsedMs),
                      planned: plannedSlices,
                    })}
                  </span>
                )}
              </div>

              {recording && <p className="text-[11px] text-muted-foreground">{t("voiceCapture.finishHint")}</p>}
              {!recording && inFlight > 0 && (
                <p className="text-[11px] text-muted-foreground" data-testid="capture-wait-uploads">
                  {t("voiceCapture.waitUploads", { n: inFlight })}
                </p>
              )}

              {micError && (
                <p className="rounded-md border border-status-failed/40 bg-card px-3 py-2 text-xs text-status-failed" data-testid="capture-mic-error">
                  {micError}
                </p>
              )}
              {error && (
                <p className="rounded-md border border-status-failed/40 bg-card px-3 py-2 text-xs text-status-failed" data-testid="capture-error">
                  {error}
                </p>
              )}
              {notice && (
                <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="capture-notice">
                  {notice}
                </p>
              )}
              {stopped && (
                <div
                  className="rounded-md border border-status-waiting/40 bg-card px-3 py-2 text-xs"
                  data-testid="capture-stopped"
                >
                  <div className="font-medium text-status-waiting">{t("voiceCapture.stoppedTitle")}</div>
                  <p className="mt-1 text-foreground">
                    {stopped === "minutes" ? t("voiceCapture.stopped.minutes") : t("voiceCapture.stopped.usd")}
                  </p>
                  <p className="mt-1 text-muted-foreground">{t("voiceCapture.stopped.buffered")}</p>
                </div>
              )}

              {capture && (
                <div className="space-y-2 rounded-md border border-border p-3" data-testid="capture-progress">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="text-xs font-medium text-foreground">{t("voiceCapture.progressTitle")}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {t("voiceCapture.progressSummary", { done: progress.done, total: progress.total, pct: percent })}
                      {" · "}
                      {t("voiceCapture.transcribed", { minutes: progress.transcribedMinutes.toFixed(1) })}
                    </div>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width]"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <div className="space-y-1">
                    {rows.map((row) => {
                      const state: SliceState = {
                        seq: row.seq,
                        status: row.status,
                        attempts: row.attempts,
                        retryable: retryableBySeq[row.seq],
                      };
                      const action = sliceAction(state);
                      const isOpen = openSlice?.seq === row.seq;
                      const retryable = action === "send" && !retryClosed;
                      return (
                        <div
                          key={row.seq}
                          data-testid={`capture-row-${row.seq}`}
                          className={
                            row.status === "failed"
                              ? "flex items-center gap-2 rounded-md border border-status-failed/40 px-2 py-1.5"
                              : "flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
                          }
                        >
                          <span className="w-12 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                            {formatOffset(row.startMs)}
                          </span>
                          <span className="w-16 shrink-0 text-xs text-foreground">
                            {isOpen ? t("voiceCapture.recordingSlice", { seq: row.seq }) : t("voiceCapture.rowLabel", { seq: row.seq })}
                          </span>
                          <StatusPill status={pillKind(row.status)} label={t(`voiceCapture.state.${row.status}`)} />
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {row.status === "failed"
                              ? t(`voiceCapture.errors.${row.errorCode ?? "internal_error"}`, {
                                  // Upstream codes are not all in our dictionary;
                                  // a machine code is worse than a plain failure.
                                  defaultValue: t("voiceCapture.errors.internal_error"),
                                })
                              : row.text}
                          </span>
                          {row.status === "failed" && (
                            <span className="flex shrink-0 items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={!retryable || busySeq !== null}
                                onClick={() => void retry(row)}
                              >
                                {busySeq === row.seq ? t("voiceCapture.retrying") : t("voiceCapture.retry")}
                              </Button>
                              {!retryable && (
                                <span className="text-[11px] text-muted-foreground">
                                  {retryClosed ? t("voiceCapture.retryClosed") : t("voiceCapture.retryGaveUp")}
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {finished && (
                <div className="space-y-2 rounded-md border border-border p-3" data-testid="capture-merged">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Label htmlFor="capture-merged-text">{t("voiceCapture.mergedTitle")}</Label>
                    <span className="text-[11px] text-muted-foreground">{t("voiceCapture.mergedHint")}</span>
                  </div>
                  <Textarea
                    id="capture-merged-text"
                    data-testid="capture-text"
                    rows={8}
                    className="min-h-[160px] text-sm"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      data-testid="capture-save"
                      disabled={corrected || savingCorrection || !draft.trim()}
                      onClick={() => void saveCorrection()}
                    >
                      {savingCorrection ? t("voiceCapture.saving") : t("voiceCapture.save")}
                    </Button>
                    <Button type="button" variant="outline" data-testid="capture-export" onClick={exportText}>
                      {t("voiceCapture.export")}
                    </Button>
                    {corrected && (
                      <span className="text-[11px] text-muted-foreground" data-testid="capture-correction-spent">
                        {t("voiceCapture.correctionSpent")}
                      </span>
                    )}
                  </div>
                  {segments.length > 0 && (
                    <div className="pt-1">
                      <div className="text-xs font-medium text-muted-foreground">{t("voiceCapture.segmentsTitle")}</div>
                      <ul className="mt-1 space-y-1">
                        {segments.map((segment) => (
                          <li key={segment.seq} className="flex gap-2 text-xs">
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {formatOffset(segment.startMs)}
                            </span>
                            <span className="whitespace-pre-wrap text-foreground">{segment.text}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="space-y-1.5 border-t border-border pt-3">
                    <Label htmlFor="capture-room">{t("voiceCapture.roomLabel")}</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="capture-room"
                        value={roomId}
                        placeholder={t("voiceCapture.roomPlaceholder")}
                        onChange={(e) => setRoomId(e.target.value)}
                        data-testid="capture-room-input"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0"
                        disabled={sendingRoom}
                        onClick={() => setRoomOpen(true)}
                        data-testid="capture-to-room"
                      >
                        {t("voiceCapture.toRoom")}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {capture && (
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => setAbandonOpen(true)}
                    data-testid="capture-abandon"
                  >
                    {t("voiceCapture.abandon")}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => requestClose(false)}>
                    {t("voiceCapture.close")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={roomOpen}
        onOpenChange={setRoomOpen}
        title={t("voiceCapture.roomConfirmTitle")}
        description={t("voiceCapture.roomConfirmDescription")}
        confirmLabel={t("voiceCapture.roomConfirm")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void sendToRoom()}
        closeOnConfirm={false}
      />
      <ConfirmDialog
        open={abandonOpen}
        onOpenChange={setAbandonOpen}
        variant="danger"
        title={t("voiceCapture.abandonTitle")}
        description={t("voiceCapture.abandonDescription")}
        confirmLabel={t("voiceCapture.abandonConfirm")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void abandon()}
        closeOnConfirm={false}
      />
    </>
  );
}

/**
 * The entry a page mounts. It reads the lane's availability once and hides
 * itself when voice is off or unconfigured — an entry that cannot work must not
 * be shown (the same posture as the composer's voice controls).
 */
export function VoiceCaptureEntry() {
  const { t } = useTranslation();
  const [voice, setVoice] = useState<CaptureVoiceStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchCaptureVoiceStatus()
      .then((v) => {
        if (alive) setVoice(v);
      })
      .catch(() => {
        if (alive) setVoice(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!voice?.available) return null;

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="capture-open">
        {t("voiceCapture.open")}
      </Button>
      <CaptureSession open={open} onOpenChange={setOpen} />
    </>
  );
}
