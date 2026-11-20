// web/src/lib/wav-encoder.ts — turn captured PCM into a COMPLETE WAV file.
//
// Why this exists (openspec: fix-voice-transcription-container, design D1):
// the 词元 audio lane accepts only complete, seekable files. `MediaRecorder`
// produces a live stream — webm/opus (Chrome, Firefox) or fragmented mp4 — and
// the lane refuses every one of those with 400, taking the shared audio account
// out of rotation for about a minute each time. A WAV is complete by
// construction: the header is written at close, so the bytes we hand over are
// always a finished file. Measured 2026-11-15: wav / mp3 / finalized m4a are
// accepted; webm / ogg / fragmented mp4 are not.
//
// Pure data transformation on purpose: no DOM, no `AudioContext`, no `Blob`.
// That is what lets scripts/test-wav-encoder.mjs exercise the exact code the
// browser runs, instead of a copy of it.

/** Speech recognition gains nothing above this, and it caps the cost at 32 KB/s. */
export const WAV_TARGET_SAMPLE_RATE = 16_000;

/** 44-byte canonical header + PCM16 payload. */
const HEADER_BYTES = 44;

/** Average the channels down to one. Silence in, silence out (never NaN). */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  const [only] = channels;
  if (!only) return new Float32Array(0);
  if (channels.length === 1) return only;
  const frames = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    // A shorter channel contributes silence, never NaN.
    for (const c of channels) sum += c[i] ?? 0;
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Linear-interpolation resample. Speech does not need a windowed sinc here, and
 * linear is the one thing every engine computes identically — which matters
 * because this file is asserted by its own sample counts, not listened to.
 */
export function resampleLinear(pcm: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0) return new Float32Array(0);
  if (fromRate === toRate || pcm.length === 0) return pcm;
  const outLen = Math.max(1, Math.round((pcm.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = pos - i0;
    const a = pcm[i0] ?? 0;
    const b = pcm[i1] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function clampToInt16(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  const s = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return Math.round(s * 0x7fff);
}

/** A complete mono WAV: 44-byte header + little-endian PCM16.
 *  The explicit `<ArrayBuffer>` is what makes the result usable as a `BlobPart`
 *  under TS 5.7+ typed-array generics — the buffer really is an ArrayBuffer. */
export function encodeWavPcm16(pcm: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // chunk size: file − 8
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = rate × channels × 2
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  let at = HEADER_BYTES;
  for (let i = 0; i < pcm.length; i++, at += 2) view.setInt16(at, clampToInt16(pcm[i] ?? 0), true);
  return new Uint8Array(buf);
}

export interface WavEncodeInput {
  /** One Float32Array per captured buffer, in capture order. */
  chunks: Float32Array[];
  /** The sample rate the audio graph ran at (typically 48000). */
  sampleRate: number;
  /** 16 kHz by default; pass the source rate to keep it untouched. */
  targetSampleRate?: number;
}

export interface WavEncodeResult {
  bytes: Uint8Array<ArrayBuffer>;
  sampleRate: number;
  durationMs: number;
}

/**
 * Concatenate the captured buffers, downmix to mono, resample, and finish the
 * file. Always returns a valid WAV — an empty take yields the 44-byte header,
 * which the caller reports as `empty` rather than uploading.
 */
export function encodeWav({ chunks, sampleRate, targetSampleRate = WAV_TARGET_SAMPLE_RATE }: WavEncodeInput): WavEncodeResult {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  const pcm = targetSampleRate && targetSampleRate !== sampleRate ? resampleLinear(joined, sampleRate, targetSampleRate) : joined;
  const rate = targetSampleRate || sampleRate;
  return {
    bytes: encodeWavPcm16(pcm, rate),
    sampleRate: rate,
    durationMs: rate > 0 ? Math.round((pcm.length / rate) * 1000) : 0,
  };
}
