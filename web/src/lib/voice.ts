// voice.ts — the browser side of the voice lane (voice-lane).
//
// Every call goes to /api/voice/* on this origin; the forwarding key lives on
// the server (design D1). This module is web-only on purpose: it needs
// FormData uploads, binary responses, MediaRecorder and HTMLAudioElement —
// none of which the shared @platform/core http transport (mini-program
// compatible) models.

export interface VoiceConfig {
  enabled: boolean;
  asrModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
}

export interface VoiceStatus {
  available: boolean;
  reason: "disabled" | "no_key" | null;
  // Whose account the forwarded call bills: the user's bound 词元 account or
  // the deployment key. Never the key itself.
  keySource: "user" | "deployment" | null;
  config: VoiceConfig;
}

export class VoiceError extends Error {
  status: number;
  code: string | null;
  // Credential-shaped failures carry the panel whose connect card fixes them
  // (same shape as chat-connect-guidance).
  connect: { panel: string } | null;
  constructor(message: string, status: number, code: string | null, connect: { panel: string } | null) {
    super(message);
    this.name = "VoiceError";
    this.status = status;
    this.code = code;
    this.connect = connect;
  }
}

async function fail(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; connect?: { panel: string } };
  throw new VoiceError(body.error || `${fallback} (${res.status})`, res.status, body.code ?? null, body.connect ?? null);
}

export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  const res = await fetch("/api/voice/status", { credentials: "same-origin" });
  if (!res.ok) return fail(res, "Failed to read voice status");
  return res.json();
}

export async function updateVoiceConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig> {
  const res = await fetch("/api/config/voice", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return fail(res, "Failed to save voice settings");
  return ((await res.json()) as { config: VoiceConfig }).config;
}

export async function transcribeAudio(blob: Blob, fileName: string): Promise<{ text: string; keySource: string | null }> {
  const form = new FormData();
  form.append("file", blob, fileName);
  const res = await fetch("/api/voice/transcriptions", { method: "POST", credentials: "same-origin", body: form });
  if (!res.ok) return fail(res, "Transcription failed");
  return res.json();
}

// A credential-shaped failure flips the server-side binding (401 on the user's
// key marks it stale; 503 means nothing resolves at all). Callers re-read
// availability so the voice entries reflect whatever key is left instead of
// offering an action that will fail again.
export function isCredentialFailure(err: unknown): boolean {
  const status = (err as { status?: number } | null | undefined)?.status;
  return status === 401 || status === 503;
}

export async function synthesizeSpeech(input: string): Promise<{ blob: Blob; truncated: boolean }> {
  const res = await fetch("/api/voice/speech", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) return fail(res, "Speech synthesis failed");
  return { blob: await res.blob(), truncated: res.headers.get("x-voice-truncated") === "1" };
}

// ── recording ───────────────────────────────────────────────────────────────

export function recordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined"
  );
}

// Opus-in-WebM where the browser has it (Chromium, Firefox), MP4/AAC on
// Safari. The extension rides on the upload name — the 词元 lane sniffs the
// container from it.
// The insertion rule lives in @platform/core (shared with the mini-program and
// the app) — see packages/core/src/voice-recorder.ts composeTranscript.

// ── playback: one player for the whole page (design D5) ─────────────────────

type PlayerListener = () => void;
let audioEl: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let playingId: string | null = null;
const listeners = new Set<PlayerListener>();

function release() {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  audioEl = null;
}

function setPlaying(id: string | null) {
  playingId = id;
  for (const l of listeners) l();
}

export const speechPlayer = {
  subscribe(listener: PlayerListener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  playingId(): string | null {
    return playingId;
  },
  // Starting one turn's playback stops any other; resolves once playback
  // actually started (autoplay refusal rejects and leaves nothing playing).
  async play(id: string, blob: Blob): Promise<void> {
    this.stop();
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    audioEl = el;
    objectUrl = url;
    const done = () => {
      if (audioEl !== el) return;
      release();
      setPlaying(null);
    };
    el.onended = done;
    el.onerror = done;
    setPlaying(id);
    try {
      await el.play();
    } catch (e) {
      done();
      throw e;
    }
  },
  stop() {
    if (audioEl) {
      audioEl.onended = null;
      audioEl.onerror = null;
      audioEl.pause();
    }
    release();
    if (playingId !== null) setPlaying(null);
  },
};
