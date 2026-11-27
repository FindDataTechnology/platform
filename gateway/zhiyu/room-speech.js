// ── Room speech: a seat's message spoken aloud (add-room-voice-and-catalog) ──
//
// A room is a gateway object, so the synthesis happens HERE — same rule as
// voice-forward.js: the DEPLOYMENT credential only, never a member's account
// (a shared room's audio billed to one member is wrong, and a guest has no
// account at all).
//
// Three things this file adds on top of the forwarder:
//   1. THREE-LAYER voice resolution (seat → post → deployment). The post layer
//      materialises into the seat at summon time (fleet-room-bridge carries the
//      post's declared voice into the invite, acceptSeats writes it onto the
//      member row), so the gateway answers it with ONE local read instead of a
//      cross-process call per message. A layer whose entry is no longer in the
//      catalog is SKIPPED and reported — the catalog changes over time and an
//      old declaration going stale must not break speech.
//   2. A CACHE keyed on hash(text, model, voice, format): the same sentence
//      replayed by five members is ONE upstream synthesis, not five.
//   3. A per-(room, day) CHARACTER QUOTA. It only ever blocks the AUTOMATIC
//      path: a busy room with auto-read on must not burn the budget silently,
//      but a person who explicitly taps ▶ still gets their audio.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveVoice, voiceCatalog } from "../../server/voice-catalog.js";

/** Defaults; the spec pins that these EXIST and are configurable, not the values. */
export const SPEECH_DEFAULTS = Object.freeze({
  dailyChars: 20_000,
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  cacheMaxBytes: 64 * 1024 * 1024,
});

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

export function createRoomSpeech({
  store,
  voiceForward,
  catalog = voiceCatalog,
  dataRoot,
  env = process.env,
  dailyChars = Number(env.ZHIYU_SPEECH_DAILY_CHARS) || SPEECH_DEFAULTS.dailyChars,
  cacheTtlMs = SPEECH_DEFAULTS.cacheTtlMs,
  cacheMaxBytes = SPEECH_DEFAULTS.cacheMaxBytes,
  now = Date.now,
}) {
  const cacheRoot = path.join(dataRoot, "zhiyu-speech-cache");
  try {
    fs.mkdirSync(cacheRoot, { recursive: true });
  } catch (err) {
    console.warn(`[zhiyu-speech] cache dir unavailable (${err?.message || err}); synthesis will not be cached`);
  }

  const cachePath = (key) => path.join(cacheRoot, `${key}.audio`);
  const cacheMetaPath = (key) => path.join(cacheRoot, `${key}.json`);

  function cacheGet(key) {
    try {
      const meta = JSON.parse(fs.readFileSync(cacheMetaPath(key), "utf8"));
      if (!meta || meta.expiresAt < now()) return null;
      return { audio: fs.readFileSync(cachePath(key)), contentType: meta.contentType };
    } catch {
      return null;
    }
  }

  function cachePut(key, { audio, contentType, model, voice }) {
    try {
      fs.writeFileSync(cachePath(key), audio);
      fs.writeFileSync(cacheMetaPath(key), JSON.stringify({ contentType, model, voice, expiresAt: now() + cacheTtlMs }));
      prune();
    } catch (err) {
      // A full disk must degrade to "uncached", never to "cannot speak".
      console.warn(`[zhiyu-speech] cache write failed (${err?.message || err})`);
    }
  }

  // Age out expired entries and enforce the byte ceiling. Cheap enough to run
  // after each write; a cache is an optimisation, never a storage plan.
  function prune() {
    let files = [];
    try {
      files = fs.readdirSync(cacheRoot).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    let total = 0;
    const rows = [];
    for (const f of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(cacheRoot, f), "utf8"));
        const size = fs.statSync(path.join(cacheRoot, f.replace(/\.json$/, ".audio"))).size;
        if (meta.expiresAt < now()) {
          fs.rmSync(path.join(cacheRoot, f));
          fs.rmSync(path.join(cacheRoot, f.replace(/\.json$/, ".audio")), { force: true });
          continue;
        }
        total += size;
        rows.push({ f, size, at: meta.expiresAt });
      } catch {
        /* a half-written entry is garbage, not an error */
      }
    }
    if (total <= cacheMaxBytes) return;
    for (const r of rows.sort((a, b) => a.at - b.at)) {
      if (total <= cacheMaxBytes) break;
      fs.rmSync(path.join(cacheRoot, r.f), { force: true });
      fs.rmSync(path.join(cacheRoot, r.f.replace(/\.json$/, ".audio")), { force: true });
      total -= r.size;
    }
  }

  const quotaKey = (roomId) => `speech_chars:${roomId}:${dayKey(now())}`;
  const quotaUsed = (roomId) => Number(store.metaGet(quotaKey(roomId)) ?? 0) || 0;
  function quotaAdd(roomId, chars) {
    const next = quotaUsed(roomId) + chars;
    store.metaSet(quotaKey(roomId), String(next));
    return next;
  }

  /**
   * Resolve the voice for one seat's message. Exported for the route and for
   * tests: the three layers, in the order the spec pins them.
   */
  function resolveForMessage({ senderMemberId }) {
    const seat = senderMemberId ? store.memberById(senderMemberId) : null;
    const cfg = voiceForward.config();
    return resolveVoice(
      {
        seat: seat?.voice ?? null,
        deployment: cfg.ttsModel && cfg.ttsVoice ? { model: cfg.ttsModel, voice: cfg.ttsVoice } : null,
      },
      { catalog },
    );
  }

  /**
   * Speak one message. Returns `{ok,audio,contentType,voiceUsed,cached}` or a
   * structured refusal — the caller maps statuses onto HTTP.
   *
   * @param {{roomId:string, seq:number, mode?: "on_demand"|"auto", senderMemberId?:string}} args
   */
  async function speakMessage({ roomId, seq, mode = "on_demand", senderMemberId = null }) {
    const row = store.messageAt(roomId, seq);
    if (!row) return { ok: false, status: 404, body: { error: "not found" } };
    if (row.kind !== "agent") {
      // Human messages are never spoken automatically, and there is nothing to
      // synthesise for a system/event row.
      return { ok: false, status: 400, body: { error: "not an agent message", code: "not_agent_message" } };
    }
    const text = String(row.content ?? "").trim();
    if (!text) return { ok: false, status: 400, body: { error: "message has no text", code: "empty_message" } };

    const resolved = resolveForMessage({ senderMemberId: senderMemberId ?? row.senderMemberId ?? null });
    const entry = resolved.entry;
    const model = entry?.model ?? "";
    const voice = entry?.voice ?? "";
    const format = voiceForward.config().ttsFormat || "mp3";
    const key = createHash("sha256").update(`${text}\u0000${model}\u0000${voice}\u0000${format}`).digest("hex").slice(0, 32);

    const cached = cacheGet(key);
    if (cached) {
      return { ok: true, audio: cached.audio, contentType: cached.contentType, voiceUsed: model && voice ? `${model}:${voice}` : "upstream-default", cached: true, resolved };
    }

    // The quota gate blocks ONLY the automatic path: an explicit tap is a
    // person deciding to spend, and it is exactly the fallback the spec names.
    if (mode === "auto" && quotaUsed(roomId) >= dailyChars) {
      return {
        ok: false,
        status: 429,
        body: { error: "今日合成字符额度已用完，自动朗读已暂停；可手动播放", code: "speech_quota_exceeded", quota: { used: quotaUsed(roomId), daily: dailyChars } },
      };
    }

    const out = await voiceForward.speak({ text, model, voice, format });
    if (!out.ok) return { ok: false, status: out.status, body: out.body };

    quotaAdd(roomId, text.length);
    cachePut(key, { audio: out.audio, contentType: out.contentType, model, voice });
    return { ok: true, audio: out.audio, contentType: out.contentType, voiceUsed: out.voiceUsed, cached: false, resolved };
  }

  return { speakMessage, resolveForMessage, quotaUsed, dailyChars };
}

/** Register the HTTP face. Kept separate so the module above stays transport-free. */
export function registerZhiyuRoomSpeech(app, { store, authorize, speech, express, catalog = voiceCatalog }) {
  // 座席音色（add-room-voice-and-catalog）：三层回落的第一层要有一个人工入口，
  // 否则「座席优先」在代码里点不到。本场指定属房间事实，所以主办或该席的主人可改；
  // 值必须以目录准入——录一个目录外的音色，上游会静默换默认音还回 200。
  app.post("/api/zhiyu/rooms/:id/seat-voice", express.json({ limit: "2kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const target = store.memberById(String(req.body?.memberId ?? ""));
    if (!target || target.roomId !== auth.room.id) return res.status(404).json({ error: "member not found" });
    const mine =
      auth.isOwner ||
      (target.kind === "facade" || target.kind === "agent" ? target.onBehalfOf === auth.user.email : target.ref === auth.user.email);
    if (!mine) return res.status(403).json({ error: "room owner or seat owner required" });
    const raw = req.body?.voice;
    if (raw === null) {
      store.memberSetVoice(target.id, null);
      return res.json({ member: store.memberById(target.id) });
    }
    const model = typeof raw?.model === "string" ? raw.model.trim() : "";
    const voice = typeof raw?.voice === "string" ? raw.voice.trim() : "";
    const entry = catalog.entryFor({ model, voice });
    if (!entry) {
      const opts = catalog.get().entries.map((e) => `${e.model}/${e.voice} (${e.label})`).join(", ");
      return res.status(400).json({ error: `unknown voice pair "${model}/${voice}"; select one of: ${opts}`, code: "voice_not_in_catalog" });
    }
    store.memberSetVoice(target.id, { model: entry.model, voice: entry.voice });
    res.json({ member: store.memberById(target.id) });
  });

  app.post("/api/zhiyu/rooms/:id/messages/:seq/speech", express.json({ limit: "2kb" }), async (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const seq = Number(req.params.seq);
    if (!Number.isFinite(seq) || seq < 1) return res.status(400).json({ error: "bad seq" });
    const mode = req.body?.mode === "auto" ? "auto" : "on_demand";
    const out = await speech.speakMessage({
      roomId: auth.room.id,
      seq,
      mode,
      senderMemberId: typeof req.body?.senderMemberId === "string" ? req.body.senderMemberId : null,
    });
    if (!out.ok) return res.status(out.status).json(out.body);
    res.setHeader("content-type", out.contentType);
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-voice-used", out.voiceUsed);
    res.setHeader("x-voice-cached", out.cached ? "1" : "0");
    res.send(out.audio);
  });
}
