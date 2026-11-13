// recorder — the app's RecorderAdapter for the shared voice state machine
// (openspec: add-voice-input-mobile, design D1).
//
// Deliberately free of `expo-audio` imports so this file runs under plain node
// (app/test/recorder.test.mjs): the AudioRecorder instance and the permission
// calls come in through ExpoRecorderEnv. The hook that owns the real recorder
// lives in recorder-expo.ts, because expo-audio creates it inside a component
// lifecycle (`useAudioRecorder`).
//
// Two app-specific facts shape the code:
//   • expo-audio's `stop()` resolves to void and leaves the file at
//     `recorder.uri` — so "nothing was captured" is `uri === null`, and that
//     becomes `empty: true` so the machine skips the upload;
//   • there is no 401 retry in the HTTP transport (platform.ts is a plain
//     fetch), so the upload below carries the one-retry law itself, the same
//     shape the mini-program uses.

import type { RecorderAdapter, RecordedTake } from "@platform/core";

export interface ExpoTake {
  uri: string;
  durationMs: number;
}

/** The slice of expo-audio's AudioRecorder this adapter uses. */
export interface ExpoRecorderLike {
  prepareToRecordAsync(options?: unknown): Promise<void>;
  record(options?: unknown): void;
  stop(): Promise<void>;
  uri: string | null;
  currentTime?: number;
  isRecording?: boolean;
}

export interface ExpoRecorderEnv {
  recorder: ExpoRecorderLike;
  /** AudioModule.requestRecordingPermissionsAsync() → granted. */
  requestPermission(): Promise<boolean>;
  /** Recording options (RecordingPresets.*); forwarded to prepareToRecordAsync. */
  recordingOptions?: unknown;
  /** Optional hook to flip the audio mode (allowsRecording) before recording. */
  beforeStart?(): Promise<void>;
}

function baseName(uri: string): string {
  const tail = uri.split("/").pop() ?? "";
  return tail || "recording.m4a";
}

export function createExpoRecorderAdapter(env: ExpoRecorderEnv): RecorderAdapter<ExpoTake> {
  let startedAt = 0;
  let discarding = false;

  return {
    isSupported: () => Boolean(env.recorder),

    async requestPermission(): Promise<boolean> {
      try {
        return await env.requestPermission();
      } catch {
        return false;
      }
    },

    async start(): Promise<void> {
      // prepareToRecordAsync must run before every take (expo-audio recycles
      // the recorder; recording twice without preparing fails on Android).
      await env.recorder.prepareToRecordAsync(env.recordingOptions);
      if (env.beforeStart) await env.beforeStart();
      discarding = false;
      startedAt = Date.now();
      env.recorder.record();
    },

    async stop(): Promise<RecordedTake<ExpoTake> | null> {
      const elapsed = startedAt > 0 ? Date.now() - startedAt : 0;
      await env.recorder.stop();
      // A cancel that landed while stop() was in flight voids the artifact.
      if (discarding) return null;
      const uri = env.recorder.uri;
      if (!uri) return null;
      return {
        artifact: { uri, durationMs: elapsed },
        fileName: baseName(uri),
        durationMs: elapsed,
        empty: false,
      };
    },

    async cancel(): Promise<void> {
      // Void the take FIRST, then ask the recorder to stop without awaiting it:
      // a recorder that is mid-flush can leave stop() pending for seconds, and
      // the machine awaits cancel() — a hung cancel would freeze the control
      // (and the page) on a take we already decided to throw away.
      discarding = true;
      env.recorder.uri = null;
      try {
        void env.recorder.stop().catch(() => {});
      } catch {
        // Nothing was recording — the take is already gone.
      }
    },
  };
}

// ── upload ──────────────────────────────────────────────────────────────────

export interface VoiceUploadDeps {
  /** POST a multipart body to `path`; the app's core http already prefixes the base URL. */
  post(path: string, body: FormData): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  /** Single-flight silent re-exchange (runtime.refresher.refreshOnce). */
  refresh(): Promise<unknown>;
}

export class VoiceUploadError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly connect: { panel: string } | null;
  constructor(message: string, status: number, code: string | null, connect: { panel: string } | null) {
    super(message);
    this.name = "VoiceUploadError";
    this.status = status;
    this.code = code;
    this.connect = connect;
  }
}

function bodyOf(raw: unknown): { error?: string; code?: string; connect?: { panel: string }; text?: string } {
  return raw && typeof raw === "object" ? (raw as Record<string, never>) : {};
}

/**
 * Send one take to /api/voice/transcriptions.
 *
 * A 401 means the pairing token lapsed: re-exchange silently and retry EXACTLY
 * once. Anything after that is reported as-is — a dead binding must not become
 * a request storm.
 */
export async function uploadExpoTake(deps: VoiceUploadDeps, take: RecordedTake<ExpoTake>): Promise<{ text: string }> {
  const build = () => {
    const form = new FormData();
    // React Native's FormData takes a file descriptor object; the cast is the
    // same one the document-attachment path uses.
    form.append("file", {
      uri: take.artifact.uri,
      name: take.fileName,
      type: "audio/m4a",
    } as unknown as Blob);
    return form;
  };

  let res = await deps.post("/api/voice/transcriptions", build());
  if (res.status === 401) {
    await deps.refresh();
    res = await deps.post("/api/voice/transcriptions", build());
  }
  const raw = await res.json().catch(() => ({}));
  const body = bodyOf(raw);
  if (!res.ok) {
    // English on purpose: app/src/lib carries no CJK literals (no-cjk gate) —
    // the page maps a failure to its localized string.
    throw new VoiceUploadError(
      body.error || `Transcription failed (${res.status})`,
      res.status,
      body.code ?? null,
      body.connect ?? null,
    );
  }
  return { text: typeof body.text === "string" ? body.text : "" };
}
