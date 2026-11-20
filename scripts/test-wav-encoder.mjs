// The WAV encoder (openspec: fix-voice-transcription-container, task 2.1).
//
// The sample counts and byte offsets ARE the assertions: the lane's acceptance
// was measured (wav 200 / webm 400), so what has to be true here is that the
// bytes we hand over are a well-formed mono PCM16 WAV of the right length —
// not merely "the function returned something".
//
//   node --test scripts/test-wav-encoder.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { WAV_TARGET_SAMPLE_RATE, downmixToMono, resampleLinear, encodeWavPcm16, encodeWav } = await import(
  "../web/src/lib/wav-encoder.ts"
);

const ascii = (bytes, at, len) => String.fromCharCode(...bytes.subarray(at, at + len));
const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
const u16 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at, true);

function headerOf(bytes) {
  return {
    riff: ascii(bytes, 0, 4),
    riffSize: u32(bytes, 4),
    wave: ascii(bytes, 8, 4),
    fmt: ascii(bytes, 12, 4),
    fmtSize: u32(bytes, 16),
    format: u16(bytes, 20),
    channels: u16(bytes, 22),
    sampleRate: u32(bytes, 24),
    byteRate: u32(bytes, 28),
    blockAlign: u16(bytes, 32),
    bits: u16(bytes, 34),
    data: ascii(bytes, 36, 4),
    dataSize: u32(bytes, 40),
  };
}

// ── downmix ─────────────────────────────────────────────────────────────────

test("downmix averages channels and never produces NaN", () => {
  const mono = downmixToMono([Float32Array.from([0.5, -0.5]), Float32Array.from([0.1, -0.3])]);
  assert.equal(mono.length, 2);
  assert.ok(Math.abs(mono[0] - 0.3) < 1e-6);
  assert.ok(Math.abs(mono[1] - -0.4) < 1e-6);
  assert.ok(mono.every((v) => Number.isFinite(v)));
  // A single channel passes through untouched (identity, not a copy that drifts).
  const one = Float32Array.from([0.25]);
  assert.equal(downmixToMono([one])[0], 0.25);
});

// ── resample: the sample counts are the point ───────────────────────────────

test("resample halves 48k→24k and triples 8k→24k, within one sample block", () => {
  const at48 = new Float32Array(48_000);
  assert.equal(resampleLinear(at48, 48_000, 24_000).length, 24_000);

  const at8 = new Float32Array(8_000);
  assert.equal(resampleLinear(at8, 8_000, 24_000).length, 24_000);

  // Duration must survive the round trip: 1s in, 1s out, ±1 sample.
  const down = resampleLinear(new Float32Array(48_000), 48_000, 16_000);
  assert.ok(Math.abs(down.length - 16_000) <= 1, `48k→16k 得到 ${down.length} 个样本`);
});

test("resample keeps a constant signal constant (no ringing, no DC drift)", () => {
  const dc = new Float32Array(1_000).fill(0.5);
  const out = resampleLinear(dc, 48_000, 16_000);
  assert.ok(out.every((v) => Math.abs(v - 0.5) < 1e-6), "常量信号重采样后必须仍是常量");
});

// ── the header: every field the lane's decoder reads ───────────────────────

test("empty input still produces a valid 44-byte WAV header", () => {
  const bytes = encodeWavPcm16(new Float32Array(0), 16_000);
  assert.equal(bytes.length, 44);
  const h = headerOf(bytes);
  assert.deepEqual(
    { riff: h.riff, wave: h.wave, fmt: h.fmt, data: h.data },
    { riff: "RIFF", wave: "WAVE", fmt: "fmt ", data: "data" },
  );
  assert.equal(h.riffSize, 36, "空数据时 RIFF 尺寸 = 36");
  assert.equal(h.fmtSize, 16);
  assert.equal(h.format, 1, "1 = PCM");
  assert.equal(h.channels, 1);
  assert.equal(h.sampleRate, 16_000);
  assert.equal(h.byteRate, 32_000, "16 kHz × 单声道 × 2 字节");
  assert.equal(h.blockAlign, 2);
  assert.equal(h.bits, 16);
  assert.equal(h.dataSize, 0);
});

test("one sample lands at the right offset with the right value", () => {
  const bytes = encodeWavPcm16(Float32Array.from([0.5]), 16_000);
  assert.equal(bytes.length, 46);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getInt16(44, true), 16_384, "0.5 × 32767 = 16383.5，四舍五入到 16384");
  assert.equal(headerOf(bytes).dataSize, 2);
});

test("out-of-range and non-finite samples clamp instead of wrapping around", () => {
  // A wrap would turn a loud passage into noise; clamping turns it into clipping.
  const bytes = encodeWavPcm16(Float32Array.from([2, -2, Number.NaN]), 16_000);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getInt16(44, true), 32_767);
  assert.equal(view.getInt16(46, true), -32_767);
  assert.equal(view.getInt16(48, true), 0, "NaN 必须是静音，不是随机值");
});

// ── the composed entry point ────────────────────────────────────────────────

test("encodeWav joins chunks in order and reports the duration", () => {
  const a = new Float32Array(24_000).fill(0.1); // 0.5s @48k
  const b = new Float32Array(24_000).fill(0.1); // 0.5s @48k
  const out = encodeWav({ chunks: [a, b], sampleRate: 48_000 });
  assert.equal(out.sampleRate, WAV_TARGET_SAMPLE_RATE);
  assert.equal(headerOf(out.bytes).sampleRate, 16_000);
  assert.ok(Math.abs(out.durationMs - 1000) <= 1, `时长应约 1000ms，实际 ${out.durationMs}`);
  assert.equal(out.bytes.length, 44 + 16_000 * 2, "1 秒 16 kHz 单声道 = 32000 字节数据");
});

test("encodeWav on an empty take is still a WAV (the caller reports empty)", () => {
  const out = encodeWav({ chunks: [], sampleRate: 48_000 });
  assert.equal(out.bytes.length, 44);
  assert.equal(out.durationMs, 0);
});

// ── the file must open in a real decoder, not just in my own assertions ─────

test("a real decoder reads the artifact as pcm_s16le mono with the right duration", () => {
  let ffprobe;
  try {
    ffprobe = execFileSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).trim();
  } catch {
    ffprobe = "";
  }
  if (!ffprobe) {
    // CI without ffmpeg: say so instead of silently passing as if it ran.
    console.log("ℹ 未装 ffprobe，跳过真解码器断言（字节级断言已在上面的用例里）");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wav-enc-"));
  const file = path.join(dir, "take.wav");
  const seconds = 1.5;
  const pcm = new Float32Array(Math.round(48_000 * seconds));
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5;
  fs.writeFileSync(file, encodeWav({ chunks: [pcm], sampleRate: 48_000 }).bytes);

  const probe = execFileSync(
    ffprobe,
    ["-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate,duration", "-of", "default=nw=1", file],
    { encoding: "utf8" },
  );
  assert.match(probe, /codec_name=pcm_s16le/);
  assert.match(probe, /channels=1/);
  assert.match(probe, /sample_rate=16000/);
  const duration = Number(/duration=([0-9.]+)/.exec(probe)?.[1] ?? "0");
  assert.ok(Math.abs(duration - seconds) < 0.01, `解出来的时长应约 ${seconds}s，实际 ${duration}s`);
  fs.rmSync(dir, { recursive: true, force: true });
});
