// ── Fake 词元 gateway (ciyuan-account-lane + voice-lane e2e) ──────────────────
//
// Serves the endpoints the binding flow and the voice lane use, with scenarios
// settable at runtime via POST /__mode {login, keys, models, asr, tts} so one
// process plays the whole script (bind → wrong password → probe 401 → healed;
// transcribe ok → 401 → ok):
//
//   POST /api/v1/auth/login        {email, password} → {data:{access_token}}
//   POST /api/v1/keys              {name, group_id}  → {data:{id, key}}
//   GET  /v1/models                (Bearer)          → 200 | 401
//   POST /v1/audio/transcriptions  (Bearer, multipart) → {text} | 401 | 502
//   POST /v1/audio/speech          (Bearer, JSON)    → audio/mpeg bytes | 502
//
// The minted key is constant so specs can assert it never shows up in the UI.
// The speech bytes are a real 0.4 s mp3 (ffmpeg sine, 693 bytes) so the
// browser's audio element actually plays them.
import { createServer } from "node:http";

const PORT = Number(process.env.CIYUAN_STUB_PORT || process.env.E2E_CIYUAN_PORT || 3197);
export const E2E_CIYUAN_MINTED_KEY = ["sk", "e2e-ciyuan-minted-key"].join("-");
export const E2E_VOICE_TRANSCRIPT = "E2E 语音转写文本";
const TINY_MP3 = Buffer.from(
  "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMQAAAAAAAAAAAAAA//OEwAAAAAAAAAAAAEluZm8AAAAPAAAAEwAAAogAVVVVVVVeXl5eXmhoaGhocXFxcXFxe3t7e3uEhISEhI6Ojo6Ol5eXl5eXoaGhoaGqqqqqqrS0tLS0vb29vb29x8fHx8fQ0NDQ0Nra2tra4+Pj4+Pj7e3t7e329vb29v//////AAAAAExhdmM2Mi4yOAAAAAAAAAAAAAAAACQDAAAAAAAAAAKIvVE7uQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//MUxAACeDrAAUMAAXd3dziAYGBgbh6H//MUxAECgDrYAYsAAH+QQMKhJIGTzgAL//MUxAICwELZ4coAAj+mCEWApCKFpcFd//MUxAIC2DaIAAB2AQzomfm2Sqv6QdUA//MUxAEB4DcOgABWI0OAgwBbTpXV9Wp+//MUxAQC2DqEAAB2AVN0d4Ww1t0qAEOA//MUxAMB+DcOgABWI4cAUzUrAA4hmqAX//MUxAYCQDbB4ACeIcVmBgAOIXYGJO4j//MUxAgCEDbF4ACeIRUANJCrDOw87QBF//MUxAoCAD8SgANSJpCfhozuCyoAygU2//MUxA0CCDcagABeI6Hnkgt8AAogbUIA//MUxA8CQDqpQAJwIN26QtUARICuA+sS//MUxBECWDax4ACwIdIAQ4CLIL6RKgAO//MUxBIB+DcOgABeIyF2AnLPQmoHRJD6//MUxBUB4DcOgABWI9EPALYHY3J1/pAr//MUxBgCEDbF4ACeIQVIFwvjbYWHfZNM//MUxBoC2D8egUcAAqdvUOUMPWd/w6pM//MUxBkEYEbIAY8AAEFNRTMuMTAwqqqq//MUxBIBWAZoQcAAAqqqqqqqqqqqqqqq",
  "base64",
);

const state = { login: "ok", keys: "ok", models: 200, asr: "ok", tts: "ok" };
// Every voice request the stub saw (auth header + a few parsed facts), so a
// spec can assert the platform forwarded with the right key and shape.
const voiceSeen = [];

export function createCiyuanStub() {
  return createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const isJson = /json/i.test(String(req.headers["content-type"] ?? ""));
      let body = null;
      if (isJson && raw.length) {
        try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; }
      }
      const json = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "POST" && req.url === "/__mode") {
        Object.assign(state, body ?? {});
        return json(200, { ok: true, state });
      }
      if (req.method === "GET" && req.url === "/__voice-seen") {
        return json(200, { seen: voiceSeen });
      }
      if (req.method === "POST" && req.url === "/__voice-reset") {
        voiceSeen.length = 0;
        return json(200, { ok: true });
      }
      if (req.url === "/api/v1/auth/login") {
        if (state.login === "401") return json(401, { message: "invalid credentials" });
        if (state.login === "500") return json(500, { message: "boom" });
        return json(200, { code: 0, data: { access_token: "jwt-e2e-login-token", user: { email: body?.email } } });
      }
      if (req.url === "/api/v1/keys") {
        if (!String(req.headers.authorization ?? "").includes("jwt-e2e-login-token")) {
          return json(401, { message: "not logged in" });
        }
        if (state.keys === "500") return json(500, { message: "group not allowed" });
        return json(200, { code: 0, data: { id: 4242, key: E2E_CIYUAN_MINTED_KEY, name: body?.name, group_id: body?.group_id } });
      }
      if (req.url === "/v1/models") {
        if (String(req.headers.authorization ?? "") !== `Bearer ${E2E_CIYUAN_MINTED_KEY}` || state.models !== 200) {
          return json(state.models === 200 ? 401 : state.models, { error: "unauthorized" });
        }
        return json(200, { data: [] });
      }
      if (req.url === "/v1/audio/transcriptions") {
        const text = raw.toString("latin1");
        voiceSeen.push({
          lane: "asr",
          auth: req.headers.authorization ?? null,
          multipart: /^multipart\/form-data/.test(String(req.headers["content-type"] ?? "")),
          fileName: /filename="([^"]+)"/.exec(text)?.[1] ?? null,
          hasModel: /name="model"/.test(text),
          bytes: raw.length,
        });
        if (state.asr === "401") return json(401, { error: { code: "invalid_api_key", message: "unauthorized" } });
        if (state.asr === "502") return json(502, { error: { code: "lane_upstream_unavailable" } });
        return json(200, { text: E2E_VOICE_TRANSCRIPT });
      }
      if (req.url === "/v1/audio/speech") {
        voiceSeen.push({ lane: "tts", auth: req.headers.authorization ?? null, body });
        if (state.tts === "401") return json(401, { error: { code: "invalid_api_key" } });
        if (state.tts === "502") return json(502, { error: { code: "lane_upstream_unavailable" } });
        res.writeHead(200, { "content-type": "audio/mpeg", "content-length": TINY_MP3.length });
        return res.end(TINY_MP3);
      }
      json(404, { error: "nope" });
    });
  });
}

// CLI mode for the e2e harness.
if (process.argv[1]?.endsWith("ciyuan-stub.js")) {
  createCiyuanStub().listen(PORT, "127.0.0.1", () => {
    console.log(`[ciyuan-stub] listening on 127.0.0.1:${PORT}`);
  });
}
