// server/voice-containers.js — "which audio container is this?", shared by the
// forwarding gate, the probe script and the tests.
//
// Why this exists (openspec: fix-voice-transcription-container, D4): the 词元
// audio lane's backing engine only accepts COMPLETE, seekable files. Measured
// 2026-11-15 by posting real audio to /v1/audio/transcriptions:
//
//   wav (RIFF/PCM) ........ 200      mp3 ................ 200
//   finalized mp4/aac ..... 200      fragmented mp4 ..... 400
//   webm/opus ............ 400      ogg/opus ........... 400
//
// and every rejected-content 400 takes the shared audio account out of rotation
// for ~a minute, so one caller's bad file breaks transcription for everybody.
// Refusing the measured-bad shapes HERE — before any upstream request — turns a
// shared outage into a single 415.
//
// Deliberately conservative: only the shapes we measured are rejected.
// Anything unrecognised is forwarded, because a gate stricter than the lane
// would reject audio the lane would have accepted.

/** Containers the lane rejects today. Keep in sync with the probe's table. */
export const REJECTED_AUDIO_CONTAINERS = Object.freeze(["webm", "ogg", "mp4-fragmented"]);

/** Containers measured as accepted (complete files). */
export const ACCEPTED_AUDIO_CONTAINERS = Object.freeze(["wav", "mp3", "mp4"]);

/** What the 415 names so the caller knows what to send instead. */
export const ACCEPTED_AUDIO_LABEL = "WAV / MP3 / M4A";

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

function ascii(buf, at, len) {
  if (at + len > buf.length) return "";
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[at + i]);
  return s;
}

function isMp3FrameSync(buf, at) {
  // 11 set bits: 0xFF Ex/Fx. (0xFF 0xFB / 0xF3 / 0xF2 in practice.)
  return buf[at] === 0xff && (buf[at + 1] & 0xe0) === 0xe0;
}

/**
 * Walk top-level MP4 boxes without reading their payloads (cheap even for a
 * 25 MB take). A file is FRAGMENTED when the top level carries `moof`, or when
 * `moov` carries `mvex` — that is exactly what MediaRecorder writes, and it is
 * what the lane refuses. A finalized file has mdat then moov and neither box.
 *
 * The walk stops at the first box whose size is 0 or runs past the buffer (a
 * live/truncated stream), which is fine: by then we have either seen the
 * fragment markers or we treat it as a normal mp4.
 */
function mp4IsFragmented(buf, limit = 4 * 1024 * 1024) {
  let at = 0;
  const end = Math.min(buf.length, limit);
  while (at + 8 <= end) {
    let size = (buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3];
    const type = ascii(buf, at + 4, 4);
    if (type === "moof") return true;
    if (type === "moov") {
      // Look for `mvex` anywhere inside this moov (usually within the first
      // hundred bytes; scan the box body, still bounded).
      const body = Math.min(size > 8 ? size : 0, end - at);
      for (let i = at + 8; i + 4 <= at + body; i++) {
        if (buf[i] === 0x6d && buf[i + 1] === 0x76 && buf[i + 2] === 0x65 && buf[i + 3] === 0x78) return true;
      }
    }
    size = size >>> 0;
    if (size < 8) return false; // 0 = "to end of file"; anything < 8 is bogus
    at += size;
  }
  return false;
}

/**
 * Classify the leading bytes of an upload.
 *
 * Returns one of: "wav" | "mp3" | "mp4" | "mp4-fragmented" | "webm" | "ogg" | "unknown".
 * "unknown" means "we have no measured opinion" — the caller forwards it.
 */
export function sniffAudioContainer(buf) {
  if (!buf || buf.length < 12) return "unknown";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WAVE") return "wav";
  if (ascii(buf, 0, 4) === "OggS") return "ogg";
  if (EBML_MAGIC.every((b, i) => buf[i] === b)) return "webm";
  if (ascii(buf, 0, 3) === "ID3") return "mp3";
  if (isMp3FrameSync(buf, 0)) return "mp3";
  if (ascii(buf, 4, 4) === "ftyp") return mp4IsFragmented(buf) ? "mp4-fragmented" : "mp4";
  return "unknown";
}

/** True when the lane is measured to refuse this container. */
export function isRejectedContainer(container) {
  return REJECTED_AUDIO_CONTAINERS.includes(container);
}

/** A human-readable container name for logs, never a raw byte dump. */
export function describeContainer(container) {
  switch (container) {
    case "wav":
      return "WAV/PCM";
    case "mp3":
      return "MP3";
    case "mp4":
      return "MP4/AAC";
    case "mp4-fragmented":
      return "fragmented MP4 (MediaRecorder 的流式产物)";
    case "webm":
      return "WebM/Matroska";
    case "ogg":
      return "OGG/Opus";
    default:
      return "未知容器";
  }
}
