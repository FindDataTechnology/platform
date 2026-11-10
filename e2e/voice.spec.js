// voice.spec.js — the voice lane end to end against the hermetic fake 词元
// (e2e/ciyuan-stub.js serves /v1/audio/*). One script, serial on purpose:
// the server's voice config and the 词元 binding are shared state.
//
//   status → entries render → audio file transcribes into the composer →
//   microphone records (fake device) and transcribes → a bound account's key
//   rides the forward and a 401 flips it stale with a connect CTA → 朗读
//   plays real bytes → the Models-section card changes the voice the next
//   synthesis carries → disabled hides every entry.

import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gotoChat, pinLocaleEn } from "./helpers.js";

const STUB = `http://127.0.0.1:${process.env.E2E_CIYUAN_PORT || 3197}`;
const TRANSCRIPT = "E2E 语音转写文本";
const WAV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/voice-tiny.wav");

async function stubMode(patch) {
  const r = await fetch(`${STUB}/__mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  expect(r.ok).toBeTruthy();
}
async function voiceSeen() {
  return (await (await fetch(`${STUB}/__voice-seen`)).json()).seen;
}
async function voiceReset() {
  await fetch(`${STUB}/__voice-reset`, { method: "POST" });
}

// A finished assistant turn with prose, through the e2e store seam — no LLM.
async function injectAnswer(page, text) {
  await page.evaluate((t) => {
    const s = window.__chatStore.getState();
    s.apply({ type: "agent_start" });
    s.apply({ type: "text", delta: t });
    s.apply({ type: "done" });
  }, text);
  await expect(page.getByTestId("turn-assistant").last()).toHaveAttribute("data-streaming", "false");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await stubMode({ asr: "ok", tts: "ok", login: "ok", keys: "ok", models: 200 });
  // Start from the defaults whatever an earlier run left behind.
  await request.put("/api/config/voice", { data: { enabled: true, asrModel: "", ttsModel: "", ttsVoice: "", ttsFormat: "mp3" } });
  await request.delete("/api/ciyuan-account");
});

test.afterAll(async ({ request }) => {
  await stubMode({ asr: "ok", tts: "ok" });
  await request.put("/api/config/voice", { data: { enabled: true, asrModel: "", ttsModel: "", ttsVoice: "", ttsFormat: "mp3" } });
  await request.delete("/api/ciyuan-account");
});

test("status reports available on the deployment key; boot config carries the switch; entries render", async ({ page, request }) => {
  const status = await (await request.get("/api/voice/status")).json();
  expect(status).toMatchObject({ available: true, reason: null, keySource: "deployment" });
  expect(JSON.stringify(status)).not.toContain("sk-");
  const cfg = await (await request.get("/api/config")).json();
  expect(cfg.voice).toEqual({ enabled: true, ttsFormat: "mp3" });

  await gotoChat(page);
  await expect(page.getByTestId("composer-voice-mic")).toBeVisible();
  await expect(page.getByTestId("composer-voice-mic")).toHaveAttribute("data-state", "idle");
  await page.getByTestId("strip-plus").click();
  await expect(page.getByTestId("composer-voice-file")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("an audio file transcribes into the composer — not into the document path", async ({ page }) => {
  await voiceReset();
  await gotoChat(page);
  await page.getByTestId("composer-input").fill("前文");
  await page.getByTestId("composer-audio-input").setInputFiles(WAV);
  await expect(page.getByTestId("composer-input")).toHaveValue(`前文 ${TRANSCRIPT}`, { timeout: 15000 });
  await expect(page.getByTestId("composer-voice-state")).toBeHidden();
  // Nothing became a document attachment.
  await expect(page.getByTestId("composer-attachment")).toHaveCount(0);
  const seen = await voiceSeen();
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ lane: "asr", multipart: true, fileName: "voice-tiny.wav", hasModel: false });
  expect(seen[0].auth).toMatch(/^Bearer sk-/);
  // Transcript inserted, nothing sent: still the welcome state.
  await expect(page.getByTestId("chat-welcome")).toBeVisible();
});

test("the microphone records (fake device), stops on the second click, and transcribes", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  await voiceReset();
  await gotoChat(page);
  const mic = page.getByTestId("composer-voice-mic");
  await mic.click();
  await expect(mic).toHaveAttribute("data-state", "recording");
  await expect(page.getByTestId("composer-voice-state")).toHaveAttribute("data-state", "recording");
  await page.waitForTimeout(700);
  await mic.click();
  await expect(page.getByTestId("composer-input")).toHaveValue(TRANSCRIPT, { timeout: 20000 });
  await expect(mic).toHaveAttribute("data-state", "idle");
  const seen = await voiceSeen();
  expect(seen).toHaveLength(1);
  expect(seen[0].lane).toBe("asr");
  expect(seen[0].fileName).toMatch(/^recording\.(webm|m4a|ogg)$/);
  expect(seen[0].bytes).toBeGreaterThan(100);
});

test("a bound 词元 account's key rides the forward; an upstream 401 flips it stale with a connect CTA", async ({ page, request }) => {
  const bind = await request.post("/api/ciyuan-account/connect", { data: { email: "voice-user@findmail.com", password: "e2e-password" } });
  expect(bind.status()).toBe(200);
  expect((await (await request.get("/api/voice/status")).json()).keySource).toBe("user");

  await voiceReset();
  await gotoChat(page);
  await page.getByTestId("composer-audio-input").setInputFiles(WAV);
  await expect(page.getByTestId("composer-input")).toHaveValue(TRANSCRIPT, { timeout: 15000 });
  expect((await voiceSeen())[0].auth).toBe(`Bearer ${["sk", "e2e-ciyuan-minted-key"].join("-")}`);

  await stubMode({ asr: "401" });
  await page.getByTestId("composer-input").fill("");
  await page.getByTestId("composer-audio-input").setInputFiles(WAV);
  const chip = page.getByTestId("composer-voice-state");
  await expect(chip).toHaveAttribute("data-state", "error", { timeout: 15000 });
  await expect(page.getByTestId("composer-voice-connect")).toBeVisible();
  const conn = await (await request.get("/api/ciyuan-account/connection")).json();
  expect(conn.stale).toBe(true);
  // The stale binding reads as absent: status falls back to the deployment key.
  expect((await (await request.get("/api/voice/status")).json()).keySource).toBe("deployment");
  await page.getByTestId("composer-voice-connect").click();
  await expect(page).toHaveURL(/\/settings\/connections\?panel=ciyuan-account/);
  await expect(page.locator("[data-panel='ciyuan-account']")).toHaveAttribute("data-panel-active", "true");

  await stubMode({ asr: "ok" });
  await request.delete("/api/ciyuan-account");
});

test("朗读 synthesises the answer and plays it; a second click stops", async ({ page }) => {
  await voiceReset();
  await gotoChat(page);
  await injectAnswer(page, "语音朗读测试文本");
  const turn = page.getByTestId("turn-assistant").last();
  await turn.hover();
  const speak = turn.getByTestId("turn-speak");
  await expect(speak).toHaveAttribute("data-state", "idle");
  await speak.click();
  await expect(speak).toHaveAttribute("data-state", "playing", { timeout: 15000 });
  const seen = await voiceSeen();
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ lane: "tts", body: { input: "语音朗读测试文本", response_format: "mp3" } });
  expect(seen[0].body.voice).toBeUndefined();
  // The fixture is 0.4 s: playback ends on its own.
  await expect(speak).toHaveAttribute("data-state", "idle", { timeout: 10000 });

  await speak.click();
  await expect(speak).toHaveAttribute("data-state", "playing", { timeout: 15000 });
  await speak.click();
  await expect(speak).toHaveAttribute("data-state", "idle");
});

test("the Models-section voice card saves a voice that the next synthesis carries", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/settings/models");
  const card = page.getByTestId("voice-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("voice-card-status")).toHaveAttribute("data-state", "available", { timeout: 15000 });
  await expect(page.getByTestId("voice-card-key-source")).toBeVisible();
  await page.getByTestId("voice-card-tts-voice").fill("alloy");
  await page.getByTestId("voice-card-save").click();
  await expect(page.getByTestId("voice-card-save")).toBeDisabled({ timeout: 10000 });

  await voiceReset();
  await gotoChat(page);
  await injectAnswer(page, "带音色朗读");
  const turn = page.getByTestId("turn-assistant").last();
  await turn.hover();
  await turn.getByTestId("turn-speak").click();
  await expect(turn.getByTestId("turn-speak")).toHaveAttribute("data-state", "playing", { timeout: 15000 });
  const seen = await voiceSeen();
  expect(seen[0].body).toMatchObject({ input: "带音色朗读", voice: "alloy" });
});

test("upstream failure on 朗读 surfaces as a toast, nothing plays", async ({ page }) => {
  await stubMode({ tts: "502" });
  await gotoChat(page);
  await injectAnswer(page, "失败朗读");
  const turn = page.getByTestId("turn-assistant").last();
  await turn.hover();
  await turn.getByTestId("turn-speak").click();
  await expect(page.getByText("语音服务暂不可用")).toBeVisible({ timeout: 15000 });
  await expect(turn.getByTestId("turn-speak")).toHaveAttribute("data-state", "idle");
  await stubMode({ tts: "ok" });
});

test("voice disabled: no microphone, no menu entry, no 朗读; the card says disabled", async ({ page, request }) => {
  const off = await request.put("/api/config/voice", { data: { enabled: false } });
  expect(off.status()).toBe(200);
  expect((await (await request.get("/api/config")).json()).voice.enabled).toBe(false);

  await gotoChat(page);
  await expect(page.getByTestId("composer-voice-mic")).toHaveCount(0);
  await page.getByTestId("strip-plus").click();
  await expect(page.getByTestId("composer-attach")).toBeVisible();
  await expect(page.getByTestId("composer-voice-file")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await injectAnswer(page, "停用时的回复");
  await expect(page.getByTestId("turn-assistant").last().getByTestId("turn-speak")).toHaveCount(0);
  await expect(page.getByTestId("turn-assistant").last().getByTestId("turn-copy")).toBeAttached();

  await page.goto("/settings/models");
  await expect(page.getByTestId("voice-card-status")).toHaveAttribute("data-state", "disabled", { timeout: 15000 });

  await request.put("/api/config/voice", { data: { enabled: true } });
});
