// ── Voice forwarding for room surfaces (zhiyu-room-attachments-and-voice) ────
//
// A room is a gateway-side object, so an audio attachment posted to a room has
// to be transcribed HERE — no member's cell is involved, and a guest has no
// cell at all. The protocol is the same OpenAI-compatible audio lane the
// composer uses (voice-lane), and so are the refusal shapes.
//
// DELIBERATE: this forwarder resolves the DEPLOYMENT credential only
// (`VOICE_API_KEY` → `LLM_API_KEY`). It never looks at any member's bound 词元
// account, because charging a room's audio to one member's account would be
// wrong for the other members and impossible for guests. The spec makes this a
// requirement, so it is satisfied by construction rather than by a branch.

const DEFAULT_API_BASE = "https://token.finddatatech.cloud";
const ASR_TIMEOUT_MS = 120_000;

export function createVoiceForwarder({ env = process.env, fetchImpl = fetch } = {}) {
  const apiBase = () =>
    String(env.VOICE_API_BASE || env.CIYUAN_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");

  const deploymentKey = () => String(env.VOICE_API_KEY || env.LLM_API_KEY || "").trim();

  // Resolved the same way the composer does (stored → env seed → defaults),
  // minus the stored layer: the gateway has no cell DB to read it from.
  const config = () => {
    const fallback = { enabled: true, asrModel: "" };
    const raw = String(env.VOICE_CONFIG || "").trim();
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return {
        enabled: parsed?.enabled === undefined ? true : Boolean(parsed.enabled),
        asrModel: typeof parsed?.asrModel === "string" ? parsed.asrModel : "",
      };
    } catch {
      console.warn("[zhiyu-voice] VOICE_CONFIG is not valid JSON; using defaults");
      return fallback;
    }
  };

  /** → { ok: true, text } | { ok: false, status, body } */
  async function transcribe({ buffer, mime, filename }) {
    const cfg = config();
    if (!cfg.enabled) return { ok: false, status: 503, body: { error: "语音功能已停用", code: "voice_disabled" } };
    const key = deploymentKey();
    if (!key) return { ok: false, status: 503, body: { error: "语音服务未配置凭据", code: "voice_not_configured" } };

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime || "application/octet-stream" }), filename || "audio");
    if (cfg.asrModel) form.append("model", cfg.asrModel);
    form.append("response_format", "json");

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ASR_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetchImpl(`${apiBase()}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal: ac.signal,
      });
    } catch (err) {
      const aborted = err?.name === "AbortError";
      return { ok: false, status: 502, body: { error: aborted ? "语音服务响应超时" : "语音服务不可达", code: aborted ? "upstream_timeout" : "upstream_unreachable" } };
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok) {
      // Never echo the upstream body: it may repeat request details.
      return { ok: false, status: 502, body: { error: "语音服务暂不可用", code: "upstream_error", upstreamStatus: upstream.status } };
    }
    let payload = null;
    try {
      payload = await upstream.json();
    } catch {
      return { ok: false, status: 502, body: { error: "语音服务返回了无法解析的结果", code: "upstream_malformed" } };
    }
    const text = typeof payload?.text === "string" ? payload.text : "";
    return { ok: true, text };
  }

  return { transcribe, available: () => config().enabled && Boolean(deploymentKey()) };
}
