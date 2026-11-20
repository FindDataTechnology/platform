// ── Zhiyu room attachments (openspec: zhiyu-room-attachments-and-voice) ──────
//
// The bytes of a room attachment belong to the ROOM. Not to the sender's
// personal library (POST /api/documents writes to the sender's own cell, so
// every other member and every guest would get a 403), and not to any cell's
// lifespan (a room is a cross-user object that outlives whichever cells happen
// to be awake). So storage lives here, beside zhiyu.db, on the same
// CELL_DATA_ROOT hostPath.
//
// Three terminal states, and they are three because two of them get confused:
//
//   ready   — we have text a seat can read (extracted, or a transcript)
//   opaque  — this space cannot read that type. A PNG is NOT a failure; saying
//             so is the honest answer, and "failed" would page someone.
//   failed  — processing broke (bad file, upstream refused). Retryable, and
//             the bytes stay downloadable.
//
// `extracting` is a transient state that only the audio/video lane uses:
// transcription takes tens of seconds and a request cannot hang for it.
//
// Read authority is the MESSAGE ROW's visibility, full stop. There is no second
// access model here — a private-window attachment must not become a room-wide
// URL, and a guest must not reach anything but shared rows.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXT_TYPE_MAP, extractSourceText } from "../../documents.js";

// Deployment-tunable via env; the shipped numbers are the ceiling on a cheap
// node, not a universal truth (see design D-config).
export function attachmentLimits(env = process.env) {
  const n = (v, dflt) => {
    const parsed = Number(v);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : dflt;
  };
  // Byte-valued knobs. The env var IS bytes (its name says so), so there is no
  // unit conversion here — converting twice is how the default silently became
  // 20 TB during review.
  return {
    docMaxBytes: n(env.ZHIYU_ATTACHMENT_DOC_MAX_BYTES, 20 * 1024 * 1024),
    audioMaxBytes: n(env.ZHIYU_ATTACHMENT_AUDIO_MAX_BYTES, 25 * 1024 * 1024),
    memberDailyBytes: n(env.ZHIYU_ATTACHMENT_MEMBER_DAILY_BYTES, 200 * 1024 * 1024),
    roomMaxBytes: n(env.ZHIYU_ATTACHMENT_ROOM_MAX_BYTES, 200 * 1024 * 1024),
    guestFileBytes: n(env.ZHIYU_ATTACHMENT_GUEST_FILE_BYTES, 10 * 1024 * 1024),
    guestDailyBytes: n(env.ZHIYU_ATTACHMENT_GUEST_DAILY_BYTES, 30 * 1024 * 1024),
    inlineMaxChars: n(env.ZHIYU_ATTACHMENT_INLINE_MAX_CHARS, 6000),
    inlineTotalChars: n(env.ZHIYU_ATTACHMENT_INLINE_TOTAL_CHARS, 12000),
    retainMs: n(env.ZHIYU_ATTACHMENT_RETAIN_MS, 30 * 24 * 60 * 60 * 1000),
    extractConcurrency: n(env.ZHIYU_ATTACHMENT_EXTRACT_CONCURRENCY, 2),
  };
}

const AUDIO_MIME = /^audio\//i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|amr|weba|mp4|mov|mkv|webm)$/i;

export function newAttachmentId() {
  return `att_${randomBytes(12).toString("hex")}`;
}

export function isAudio(name, mime) {
  return AUDIO_MIME.test(String(mime ?? "")) || AUDIO_EXT.test(String(name ?? ""));
}

// Whether this space has a reader for the file's type at all. One source of
// truth: the same EXT_TYPE_MAP the document library uses, so "readable here"
// and "readable in the library" can never drift.
export function canExtract(name) {
  const dot = String(name ?? "").lastIndexOf(".");
  const ext = dot >= 0 ? String(name).slice(dot).toLowerCase() : "";
  return Boolean(EXT_TYPE_MAP[ext]);
}

// The storage path is built from the server-generated id and NOTHING else. The
// original name is a display field; letting it touch the path is how a
// `../../etc/passwd` upload becomes someone's Tuesday.
export function attachmentDir(root, roomId, aid) {
  const safeRoom = createHash("sha256").update(String(roomId)).digest("hex").slice(0, 32);
  return path.join(root, safeRoom, aid);
}

export function createAttachmentStore({ store, root, env = process.env, log = console, transcribe = null, onSettled = null }) {
  const limits = attachmentLimits(env);

  // Bounded extraction queue (design D12): the gateway is one process serving
  // every room, so a 20MB PPTX must not block the event loop for everyone.
  const queue = [];
  let running = 0;
  const pump = () => {
    while (running < limits.extractConcurrency && queue.length) {
      const job = queue.shift();
      running += 1;
      Promise.resolve()
        .then(job)
        .catch((err) => log.error(`[zhiyu-attach] extract job failed: ${err?.message || err}`))
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  };
  // Run-now-if-free, else queue. Returns nothing: the caller already answered
  // the request (text extraction is synchronous, but it must not hold the loop).
  const enqueue = (job) => {
    queue.push(job);
    pump();
  };

  async function writeBytes(roomId, aid, buffer) {
    const dir = attachmentDir(root, roomId, aid);
    await mkdir(dir, { recursive: true });
    const rel = path.join(path.relative(root, dir), "original");
    const tmp = `${path.join(dir, "original")}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, buffer);
    await rename(tmp, path.join(dir, "original"));
    return rel;
  }

  const relToAbs = (rel) => path.join(root, rel);

  async function readBytes(att) {
    if (!att || att.purged) return null;
    // The path is resolved from the STORE's location column (never from the
    // public projection, which does not carry it) and containment is asserted
    // lexically so a hand-edited row cannot escape the root.
    const rel = store.attachmentLocation(att.id);
    if (!rel) return null;
    const abs = path.resolve(relToAbs(rel));
    if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
    try {
      return await readFile(abs);
    } catch {
      return null;
    }
  }

  /**
   * Store one uploaded file for `roomId`, riding message row `rowSeq`.
   * Returns the public attachment (already inserted). Extraction is dispatched
   * to the queue; the caller told the client the terminal state for text files
   * only after this resolves (see the route).
   */
  async function accept({ roomId, rowSeq, ownerMemberId, sourceKind = "member", name, mime, buffer }) {
    const aid = newAttachmentId();
    const audio = isAudio(name, mime);
    const location = await writeBytes(roomId, aid, buffer);
    const att = store.attachmentAdd({
      id: aid,
      roomId,
      rowSeq,
      ownerMemberId,
      sourceKind,
      name: String(name ?? "").slice(0, 300),
      mime: String(mime ?? "").slice(0, 200),
      bytes: buffer.length,
      // Audio starts in `extracting`: its terminal state arrives after
      // transcription. Everything else starts here and is settled below.
      status: audio ? "extracting" : "opaque",
      location,
    });
    return { attachment: att, audio, buffer };
  }

  /**
   * Settle a stored attachment into its terminal state. Text files extract
   * inline-ish (queue, but the route awaits this variant); audio transcribes
   * asynchronously and reports completion through `onSettled`.
   */
  async function settleText(att, buffer, { name }) {
    const type = EXT_TYPE_MAP[extOf(String(name ?? att.name))];
    if (!type) {
      // No reader for this extension at all: opaque, and that is the final word.
      return store.attachmentSetResult(att.id, { status: "opaque" });
    }
    if (buffer.length > limits.docMaxBytes) {
      return store.attachmentSetResult(att.id, { status: "opaque", error: "too_large_to_extract" });
    }
    try {
      const text = await extractSourceText({ type, buffer, name: att.name });
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return store.attachmentSetResult(att.id, { status: "failed", error: "extraction_empty" });
      return store.attachmentSetResult(att.id, { status: "ready", extractedText: trimmed });
    } catch (err) {
      return store.attachmentSetResult(att.id, { status: "failed", error: String(err?.message || err).slice(0, 300) });
    }
  }

  function extOf(name) {
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot).toLowerCase() : "";
  }

  /**
   * Audio lane: transcribe, then settle. Runs off the request (tens of seconds),
   * and reports through `onSettled` so the room can leave a readable trace row.
   * A transcription refusal lands as `failed` with the reason — never a silent
   * attachment that says "processing" forever.
   */
  async function settleAudio(att, buffer) {
    try {
      if (!transcribe) throw new Error("transcription lane not configured");
      const out = await transcribe({ buffer, mime: att.mime, filename: att.name });
      if (!out?.ok) throw new Error(out?.body?.error || out?.error || "transcription failed");
      const text = String(out.text ?? "").trim();
      if (!text) return store.attachmentSetResult(att.id, { status: "failed", error: "transcript_empty" });
      const settled = store.attachmentSetResult(att.id, { status: "ready", extractedText: text });
      try {
        onSettled?.(settled);
      } catch (err) {
        log.warn(`[zhiyu-attach] settled hook failed: ${err?.message || err}`);
      }
      return settled;
    } catch (err) {
      return store.attachmentSetResult(att.id, { status: "failed", error: String(err?.message || err).slice(0, 300) });
    }
  }

  /**
   * Purge bytes for one attachment: the row survives (the card must be able to
   * say 已过期) but the text and the file are gone.
   */
  async function purge(att) {
    if (!att || att.purged) return false;
    const rel = store.attachmentLocation(att.id) ?? "";
    const abs = path.resolve(relToAbs(rel));
    if (rel && abs.startsWith(path.resolve(root) + path.sep)) {
      await rm(path.dirname(abs), { recursive: true, force: true }).catch((err) =>
        log.warn(`[zhiyu-attach] purge ${att.id} failed: ${err?.message || err}`),
      );
    }
    store.attachmentMarkPurged(att.id);
    return true;
  }

  /**
   * Retention tick (spec: 附件字节按保留期回收). Ended rooms only, bytes only,
   * idempotent, counts reported. Orphans — locations whose row is gone — are
   * swept in the same pass so a hand-deleted row cannot leak disk forever.
   */
  async function retentionSweep({ olderThanMs = limits.retainMs, limit = 200 } = {}) {
    let purged = 0;
    for (const att of store.attachmentsToPurge({ olderThanMs, limit })) {
      if (await purge(att)) purged += 1;
    }
    let orphans = 0;
    const known = new Set(store.attachmentsAllLocations().map((r) => path.resolve(relToAbs(r.location))));
    const { readdir } = await import("node:fs/promises");
    let roomDirs = [];
    try {
      roomDirs = await readdir(root, { withFileTypes: true });
    } catch {
      roomDirs = [];
    }
    for (const d of roomDirs) {
      if (!d.isDirectory()) continue;
      const roomPath = path.join(root, d.name);
      let aids = [];
      try {
        aids = await readdir(roomPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const a of aids) {
        if (!a.isDirectory()) continue;
        const dir = path.join(roomPath, a.name);
        if (known.has(path.resolve(path.join(dir, "original")))) continue;
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        orphans += 1;
      }
    }
    return { purged, orphans };
  }

  return { limits, accept, settleText, settleAudio, enqueue, readBytes, purge, retentionSweep, extOf };
}

// ── Prompt-side bounded inline (design D5) ──────────────────────────────────
//
// The room prompt is a PRODUCT: 40 rows × every seated agent. Inlining every
// attachment's text would blow the window and bill the same bytes once per
// seat. So: the newest attachment in the window gets its text, everything
// older degrades to a one-line pointer, and both are capped.

export function buildAttachmentBlock({ rows, store, limits = attachmentLimits() }) {
  const inlineMax = limits.inlineMaxChars;
  const totalMax = limits.inlineTotalChars;
  const withAtt = rows.filter((r) => r.kind === "human" && r.meta?.attachment?.id);
  if (!withAtt.length) return "";
  const newest = withAtt[withAtt.length - 1];
  let used = 0;
  const lines = [];
  for (const row of withAtt) {
    const ref = row.meta.attachment;
    const att = store.attachmentGet(ref.id);
    if (!att) continue;
    const isNewest = row.seq === newest.seq;
    const status = att.purged ? "expired" : att.status;
    if (!isNewest || status !== "ready") {
      // Older-but-readable attachments still need to say WHERE to read them —
      // "a file was here and you can open it" is the whole reason the pointer
      // exists. Non-ready states say their own honest reason instead.
      const reason =
        status === "expired"
          ? "（已过期，不可再取）"
          : status === "opaque"
            ? "（本空间不能读取该类型，可在房间内查看）"
            : status === "extracting"
              ? "（处理中，可在房间内查看）"
              : status === "failed"
                ? "（处理失败，可在房间内查看）"
                : "（完整文件在房间内可查看）";
      lines.push(`（附件）${att.name}${reason}`);
      continue;
    }
    const text = store.attachmentText(att.id) ?? "";
    if (!text) {
      lines.push(`（附件）${att.name}（无可用正文，可在房间内查看）`);
      continue;
    }
    const budget = Math.max(0, Math.min(inlineMax, totalMax - used));
    if (budget <= 0) {
      lines.push(`（附件）${att.name} — 完整文件在房间内可查看`);
      continue;
    }
    const slice = text.length > budget ? text.slice(0, budget) : text;
    used += slice.length;
    lines.push(
      [
        `（附件正文）${att.name} — 共 ${text.length} 字`,
        slice,
        text.length > slice.length ? "（已截断；完整文件在房间内可查看）" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return lines.length ? `\n\n附件：\n${lines.join("\n")}` : "";
}
