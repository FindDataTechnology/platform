// voice-adapter — the browser's RecorderAdapter for the shared voice state
// machine (openspec: add-voice-input-mobile, design D1).
//
// Everything browser-specific about recording lives here, and nothing else
// does: the five phases, the no-auto-send rule, cancel-leaves-nothing and the
// empty-take rule are the machine's job (packages/core/src/voice-recorder.ts).
//
// Three behaviours are inherited from the pre-refactor Composer and must not
// drift (see design.md 附录 A):
//   • getUserMedia({ audio: true }) is both "ask permission" and "open the
//     microphone" — so requestPermission() keeps the stream and start() reuses
//     it, instead of prompting twice;
//   • only non-empty chunks are collected, and the blob's type follows
//     recorder.mimeType → chosen mimeType → "audio/webm";
//   • a zero-byte take comes back as `empty: true` so the machine can return
//     to idle without a request.
//
// The environment is injectable so this file can be exercised in node with no
// DOM (scripts/test-voice-web-adapter.mjs).

import type { RecorderAdapter, RecordedTake } from "@platform/core";
import { encodeWav } from "./wav-encoder.ts";

// Container preference: Opus-in-WebM where the browser has it (Chromium,
// Firefox), MP4/AAC on Safari. The extension rides on the upload name — the
// 词元 lane sniffs the container from it. Moved here from lib/voice.ts when the
// recorder became an adapter: nothing but the recorder ever needed it.
//
// This is now the FALLBACK list, not the normal path. The lane refuses webm,
// ogg AND fragmented mp4 (measured 2026-11-15: all three 400), and
// MediaRecorder can produce nothing else — so the normal path captures PCM and
// encodes a complete WAV (openspec: fix-voice-transcription-container). The
// list stays because a browser with no Web Audio still has to record something.
export function pickRecordingFormat(
  isTypeSupported: (mimeType: string) => boolean = (mimeType) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType),
): { mimeType: string | undefined; fileName: string } {
  const candidates: Array<[string, string]> = [
    ["audio/webm;codecs=opus", "recording.webm"],
    ["audio/webm", "recording.webm"],
    ["audio/mp4", "recording.m4a"],
    ["audio/ogg;codecs=opus", "recording.ogg"],
  ];
  for (const [mimeType, fileName] of candidates) {
    if (isTypeSupported(mimeType)) return { mimeType, fileName };
  }
  return { mimeType: undefined, fileName: "recording.webm" };
}

/** What the normal path always produces: a complete, accepted container. */
export const WAV_TAKE_FILE_NAME = "recording.wav";
export const WAV_TAKE_MIME = "audio/wav";

/**
 * A PCM tap on the microphone stream (fix-voice-transcription-container D1).
 * Abstracted so the adapter's decisions stay testable in node without a DOM;
 * the browser implementation is `createBrowserPcmCapture` below.
 */
export interface PcmCapture {
  readonly sampleRate: number;
  start(): void;
  /** Stops the graph and returns every captured buffer, in order. */
  stop(): Float32Array[];
}

/**
 * The browser's PCM tap: ScriptProcessor rather than AudioWorklet because a
 * worklet needs its own module URL (and would be one more thing to break under
 * a CSP), while this runs everywhere the recorder runs at all. At one mono
 * channel the main-thread cost is negligible.
 *
 * The tap is routed through a zero-gain node on purpose: a ScriptProcessor only
 * fires while connected to a destination, and connecting it directly would play
 * the microphone back through the speakers.
 */
export function createBrowserPcmCapture(stream: MediaStreamLike): PcmCapture | null {
  const Ctor =
    (globalThis as unknown as { AudioContext?: new () => AudioContextLike }).AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext;
  if (!Ctor) return null;
  let ctx: AudioContextLike | null = null;
  let source: { connect(n: unknown): void; disconnect(): void } | null = null;
  let node: ScriptProcessorLike | null = null;
  let mute: { gain: { value: number }; connect(n: unknown): void } | null = null;
  let buffers: Float32Array[] = [];

  return {
    get sampleRate() {
      return ctx?.sampleRate ?? 48_000;
    },
    start() {
      ctx = new Ctor();
      source = ctx.createMediaStreamSource(stream) as unknown as { connect(n: unknown): void; disconnect(): void };
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (ev) => {
        // Copy: the engine reuses the channel buffer after the callback.
        buffers.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
      };
      mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
    },
    stop() {
      try {
        node?.disconnect();
        source?.disconnect();
      } catch {
        // Tearing down a closed context is best-effort.
      }
      node = null;
      const out = buffers;
      buffers = [];
      const closing = ctx;
      ctx = null;
      try {
        void closing?.close?.();
      } catch {
        // Same.
      }
      return out;
    },
  };
}

interface AudioContextLike {
  readonly sampleRate: number;
  createMediaStreamSource(stream: MediaStreamLike): unknown;
  createScriptProcessor(bufferSize: number, inCh: number, outCh: number): ScriptProcessorLike;
  createGain(): { gain: { value: number }; connect(n: unknown): void };
  readonly destination: unknown;
  close?(): Promise<void> | void;
}

interface ScriptProcessorLike {
  onaudioprocess: ((ev: { inputBuffer: { getChannelData(ch: number): Float32Array } }) => void) | null;
  connect(n: unknown): void;
  disconnect(): void;
}

export interface MediaStreamLike {
  getTracks(): Array<{ stop(): void }>;
}

export interface BlobLike {
  size: number;
  type?: string;
}

interface MediaRecorderLike {
  mimeType?: string;
  state: "inactive" | "recording" | "paused";
  ondataavailable: ((ev: { data: BlobLike }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface BrowserRecorderEnv {
  getUserMedia?: (constraints: { audio: boolean }) => Promise<MediaStreamLike>;
  createRecorder?: (stream: MediaStreamLike, mimeType?: string) => MediaRecorderLike;
  isTypeSupported?: (mimeType: string) => boolean;
  createBlob?: (chunks: unknown[], type: string) => BlobLike;
  /** The PCM tap. Returning null (no Web Audio) falls back to MediaRecorder. */
  createPcmCapture?: (stream: MediaStreamLike) => PcmCapture | null;
}

/** True when this browser can record at all (the mic entry renders on this). */
export function browserRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined"
  );
}

function defaultEnv() {
  return {
    getUserMedia: (constraints: { audio: boolean }) =>
      navigator.mediaDevices.getUserMedia(constraints) as unknown as Promise<MediaStreamLike>,
    createRecorder: (stream: MediaStreamLike, mimeType?: string) =>
      (mimeType
        ? new MediaRecorder(stream as unknown as MediaStream, { mimeType })
        : new MediaRecorder(stream as unknown as MediaStream)) as unknown as MediaRecorderLike,
    createBlob: (chunks: unknown[], type: string) => new Blob(chunks as BlobPart[], { type }),
  };
}

function baseNameOf(mime: string | undefined, fallback: string): string {
  if (!mime) return fallback;
  const m = mime.toLowerCase();
  // The 词元 lane sniffs the container from the extension, so the name must
  // follow what the recorder ACTUALLY produced — not what we hoped for at
  // start(). Without this, a browser that can only do AAC would hand the server
  // an .webm name for aac-in-mp4 bytes.
  if (m.includes("mp4") || m.includes("aac")) return "recording.m4a";
  if (m.includes("ogg") || m.includes("opus")) return m.includes("webm") ? "recording.webm" : "recording.ogg";
  if (m.includes("webm")) return "recording.webm";
  if (m.includes("wav") || m.includes("pcm")) return "recording.wav";
  return fallback;
}

export function createBrowserRecorderAdapter(
  env: BrowserRecorderEnv = {},
  supported: () => boolean = browserRecordingSupported,
): RecorderAdapter<BlobLike> & { release(): void } {
  const fallback = defaultEnv();
  const getUserMedia = env.getUserMedia ?? fallback.getUserMedia;
  const createRecorder = env.createRecorder ?? fallback.createRecorder;
  const createBlob = env.createBlob ?? fallback.createBlob;
  const createPcmCapture = env.createPcmCapture ?? createBrowserPcmCapture;

  let stream: MediaStreamLike | null = null;
  let recorder: MediaRecorderLike | null = null;
  let pcm: PcmCapture | null = null;
  let chunks: unknown[] = [];
  let fileName = "recording.webm";
  let pickedKnown = false;
  let mimeType: string | undefined;
  /** Resolves the in-flight stop() once onstop fires (or cancel discards it). */
  let settle: ((take: RecordedTake<BlobLike> | null) => void) | null = null;

  const releaseTracks = () => {
    try {
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
    } catch {
      // Releasing the device is best-effort.
    }
    stream = null;
  };

  const discard = () => {
    const rec = recorder;
    recorder = null;
    if (rec) {
      // Detach first: a cancel must never produce an artifact, even if the
      // recorder fires onstop on its way down.
      rec.onstop = null;
      rec.ondataavailable = null;
      if (rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          // Some implementations throw when stopping an already-stopped stream.
        }
      }
    }
    const tap = pcm;
    pcm = null;
    if (tap) {
      try {
        tap.stop(); // drain and drop: a cancelled take leaves nothing behind
      } catch {
        // Best-effort.
      }
    }
    chunks = [];
    settle?.(null);
    settle = null;
    releaseTracks();
  };

  return {
    isSupported: supported,

    async requestPermission(): Promise<boolean> {
      // A stream may already be open (cancel between permission and start):
      // reuse it rather than prompting the user a second time.
      if (stream) return true;
      try {
        stream = await getUserMedia({ audio: true });
        return true;
      } catch {
        stream = null;
        return false;
      }
    },

    async start(): Promise<void> {
      if (!stream) throw new Error("microphone is not open");
      // Normal path: PCM → complete WAV, the one shape the lane accepts from a
      // browser. MediaRecorder is only reached when the browser has no Web
      // Audio, and that take is refused server-side with a clear 415.
      const tap = createPcmCapture(stream);
      if (tap) {
        pcm = tap;
        chunks = [];
        fileName = WAV_TAKE_FILE_NAME;
        mimeType = WAV_TAKE_MIME;
        pickedKnown = true;
        tap.start();
        return;
      }
      const picked = pickRecordingFormat(env.isTypeSupported);
      mimeType = picked.mimeType;
      fileName = picked.fileName;
      pickedKnown = picked.mimeType !== undefined;
      chunks = [];
      const rec = createRecorder(stream, mimeType);
      recorder = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      rec.onstop = () => {
        releaseTracks();
        const type = rec.mimeType || mimeType || "audio/webm";
        const blob = createBlob(chunks, type);
        chunks = [];
        recorder = null;
        const take: RecordedTake<BlobLike> = {
          artifact: blob,
          // A tier we recognised names the file up front; an unrecognised one
          // (nothing in the candidate list matched) is named from what the
          // recorder actually produced at stop time.
          fileName: pickedKnown ? fileName : baseNameOf(rec.mimeType || mimeType, fileName),
          durationMs: 0,
          empty: blob.size === 0,
        };
        settle?.(take);
        settle = null;
      };
      rec.start();
    },

    async stop(): Promise<RecordedTake<BlobLike> | null> {
      const tap = pcm;
      if (tap) {
        pcm = null;
        const captured = tap.stop();
        releaseTracks();
        const frames = captured.reduce((n, c) => n + c.length, 0);
        const encoded = encodeWav({ chunks: captured, sampleRate: tap.sampleRate });
        const blob = createBlob([encoded.bytes], WAV_TAKE_MIME);
        // An empty take still encodes to a valid 44-byte WAV, so `empty` comes
        // from the captured frames — never from the artifact's size.
        return { artifact: blob, fileName: WAV_TAKE_FILE_NAME, durationMs: encoded.durationMs, empty: frames === 0 };
      }
      const rec = recorder;
      if (!rec) {
        releaseTracks();
        return null;
      }
      if (rec.state === "inactive") {
        // Already finished on its own: nothing more will arrive.
        recorder = null;
        releaseTracks();
        settle?.(null);
        settle = null;
        return null;
      }
      const done = new Promise<RecordedTake<BlobLike> | null>((resolve) => {
        settle = resolve;
      });
      rec.stop();
      return await done;
    },

    async cancel(): Promise<void> {
      discard();
    },

    /** Explicit teardown for unmount: same effect as cancel, never uploads. */
    release(): void {
      discard();
    },
  };
}
