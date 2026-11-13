// Live acceptance for voice-lane (task 4.3) + the same release train's
// deployment evidence for chat-connect-guidance and role-nav-apps, production.
//
//   node scripts/verify-live-voice.mjs
//
// Real Logto account from .env binds the real 词元 trial account (password from
// CIYUAN_TRIAL_PASSWORD or /tmp/ciyuan-trial-newpw.txt — never committed), then
// speaks and listens for real: a genuine speech recording goes through the
// composer's voice file entry and comes back as text; one chat turn is read
// aloud through /api/voice/speech; both land usage rows on the user's minted
// key in 词元 (billing subject = the user, not the deployment). Finally the
// binding is dropped and the test key soft-deleted.
//
// VOICE_PROBE_WAV must be real speech (silence transcribes to ""); the default
// is the 16 kHz mono probe recorded for the 词元 audio-lane work.
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.env.PLATFORM_URL || "https://platform.finddatatech.cloud";
const dotenv = (k) => (readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const EMAIL = dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = dotenv("PAAS_TEST_PASSWORD");
const TRIAL_EMAIL = process.env.CIYUAN_TRIAL_EMAIL || "ciyuan-trial@findmail.com";
const TRIAL_PASSWORD =
  process.env.CIYUAN_TRIAL_PASSWORD || (existsSync("/tmp/ciyuan-trial-newpw.txt") ? readFileSync("/tmp/ciyuan-trial-newpw.txt", "utf8").trim() : null);
const WAV = process.env.VOICE_PROBE_WAV || "/tmp/ciyuan-probe.wav";
if (!EMAIL || !PASSWORD) throw new Error("PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD not set");
if (!TRIAL_PASSWORD) throw new Error("CIYUAN_TRIAL_PASSWORD not set");
if (!existsSync(WAV)) throw new Error(`VOICE_PROBE_WAV not found: ${WAV}`);

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000 }).trim();
const kexec = (script) => sh("kubectl", ["--context", "cheap", "-n", "fd-prod", "exec", "deploy/platform", "--", "sh", "-c", script]);
const psql = (sql) => sh("kubectl", ["--context", "cheap", "-n", "sub2api", "exec", "sub2api-postgres-0", "--", "psql", "-U", "sub2api", "-d", "sub2api", "-t", "-A", "-F", "|", "-c", sql]);
const usageRows = (keyId) => (keyId ? Number(psql(`SELECT count(*) FROM usage_logs WHERE api_key_id=${keyId}`)) : -1);
const latestUsage = (keyId, n = 3) => (keyId ? psql(`SELECT request_type, model FROM usage_logs WHERE api_key_id=${keyId} ORDER BY id DESC LIMIT ${n}`).replace(/\n/g, "; ") : "");

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ locale: "zh-CN" })).newPage();
let mintedKeyId = null;
try {
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("login-page").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("sso-login").click();
  const id = page.locator('input[name="identifier"]');
  await id.waitFor({ state: "visible", timeout: 30_000 }); await id.fill(EMAIL); await id.press("Enter");
  const pw = page.locator('input[name="password"]');
  await pw.waitFor({ state: "visible", timeout: 30_000 }); await pw.fill(PASSWORD); await pw.press("Enter");
  await page.waitForURL(/\/chat|\/settings/, { timeout: 60_000 });
  ok("login", true, page.url());

  const api = async (p, init) => page.evaluate(async ({ p, init }) => { const r = await fetch(p, init); return { status: r.status, body: await r.json().catch(() => null) }; }, { p, init: init ?? {} });

  // ── deployment-level facts ────────────────────────────────────────────────
  const cfg = await api("/api/config");
  ok("/api/config carries voice {enabled, ttsFormat}", cfg.body?.voice?.enabled === true && typeof cfg.body?.voice?.ttsFormat === "string", JSON.stringify(cfg.body?.voice));
  const status0 = await api("/api/voice/status");
  ok("voice status available before binding (deployment key)", status0.body?.available === true && status0.body?.keySource === "deployment", JSON.stringify({ ...status0.body, config: undefined }));
  ok("status read carries no key material", !JSON.stringify(status0.body).includes("sk-"));

  await page.goto(`${PLATFORM}/settings/models`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("voice-card").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("[data-testid='voice-card-status'][data-state='available']").waitFor({ timeout: 20_000 });
  ok("Models section shows the voice card as available (admin sees the editable form)", (await page.getByTestId("voice-card-save").count()) === 1);

  // ── bind the trial account (zero-paste) ───────────────────────────────────
  await page.goto(`${PLATFORM}/settings/connections?panel=ciyuan-account`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("ciyuan-account-card").waitFor({ state: "visible", timeout: 30_000 });
  if ((await page.getByTestId("ciyuan-account-state").getAttribute("data-state")) !== "disconnected") {
    await page.getByTestId("ciyuan-account-disconnect").click();
    await page.locator("[data-testid='ciyuan-account-state'][data-state='disconnected']").waitFor({ timeout: 30_000 });
  }
  await page.getByTestId("ciyuan-account-email").fill(TRIAL_EMAIL);
  await page.getByTestId("ciyuan-account-password").fill(TRIAL_PASSWORD);
  await page.getByTestId("ciyuan-account-connect").click();
  await page.locator("[data-testid='ciyuan-account-state'][data-state='connected']").waitFor({ timeout: 30_000 });
  const keyName = (await page.getByTestId("ciyuan-account-details").innerText()).match(/yizuo-[0-9a-f]{8}-\d{8}/)?.[0] ?? null;
  const row = keyName ? psql(`SELECT id FROM api_keys WHERE name='${keyName}' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`) : "";
  mintedKeyId = row || null;
  ok("trial account bound; minted key located in 词元", Boolean(mintedKeyId), `${keyName} → id ${mintedKeyId}`);
  const status1 = await api("/api/voice/status");
  ok("voice status now bills the user's 词元 account", status1.body?.available === true && status1.body?.keySource === "user", JSON.stringify({ ...status1.body, config: undefined }));

  // ── speech in: a real recording through the composer's voice file entry ──
  await page.goto(`${PLATFORM}/chat`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const input = page.getByTestId("composer-input");
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(4000); // bind just rewrote the cell's credential store; let hot reloads settle
  ok("microphone entry rendered (voice available)", (await page.getByTestId("composer-voice-mic").count()) === 1);
  const before = usageRows(mintedKeyId);
  const asrRes = page.waitForResponse((r) => r.url().includes("/api/voice/transcriptions"), { timeout: 90_000 });
  await page.getByTestId("composer-audio-input").setInputFiles(WAV);
  const asr = await asrRes;
  const asrBody = await asr.json().catch(() => null);
  ok("ASR forward answered 200 on the user's key", asr.status() === 200 && asrBody?.keySource === "user", `HTTP ${asr.status()} keySource=${asrBody?.keySource}`);
  await page.waitForFunction(() => (document.querySelector('[data-testid="composer-input"]')?.value ?? "").trim().length > 0, null, { timeout: 30_000 });
  const transcript = (await input.inputValue()).trim();
  ok("transcript inserted into the composer (non-empty, not sent)", transcript.length > 0 && (await page.getByTestId("turn-user").count()) === 0, JSON.stringify(transcript.slice(0, 60)));
  ok("no document attachment was created by the voice path", (await page.getByTestId("composer-attachment").count()) === 0);
  let afterAsr = before;
  for (let i = 0; i < 10 && afterAsr <= before; i++) { await page.waitForTimeout(3000); afterAsr = usageRows(mintedKeyId); }
  ok("ASR billed to the user's minted key (usage_logs row)", afterAsr > before, `rows ${before} → ${afterAsr}; latest: ${latestUsage(mintedKeyId, 1)}`);

  // ── one chat turn, then speech out ────────────────────────────────────────
  await input.fill("只回复两个字：收到");
  await input.press("Enter");
  const turn = page.getByTestId("turn-assistant").last();
  await turn.waitFor({ state: "visible", timeout: 90_000 });
  await page.locator("[data-testid='turn-assistant'][data-streaming='false']").last().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  const beforeTts = usageRows(mintedKeyId);
  await turn.hover();
  const speak = turn.getByTestId("turn-speak");
  ok("朗读 control rendered on the finished turn", (await speak.count()) === 1);
  const ttsRes = page.waitForResponse((r) => r.url().includes("/api/voice/speech"), { timeout: 90_000 });
  await speak.click();
  const tts = await ttsRes;
  // Playwright hands back an empty body for binary responses, so the byte
  // count here is only the header-level truth; the payload size is measured
  // by the same-origin probe below.
  const ttsBytes = (await tts.body()).length;
  ok("TTS forward answered 200 audio on the user's key", tts.status() === 200 && /^audio\//.test(tts.headers()["content-type"] ?? "") && tts.headers()["x-voice-key-source"] === "user", `HTTP ${tts.status()} ${tts.headers()["content-type"]} ${tts.headers()["x-voice-key-source"]} (browser-side body ${ttsBytes}B — binary responses are not captured)`);
  // Playwright 的 response.body() 在页面已消费该响应时可能读到空（本项目实测：
  // 播放器用 res.blob() 读走后 waitForResponse.body() 返回 0B，但音频确实在播）。
  // 因此这里再独立打一次同一端点，直接量字节，作为「真载荷」的判据。
  const ttsProbe = await page.evaluate(async () => {
    const r = await fetch("/api/voice/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "语音链路字节数自检" }),
    });
    const b = await r.blob();
    return { status: r.status, size: b.size, type: b.type, keySource: r.headers.get("x-voice-key-source") };
  });
  ok(
    "synthesised audio is a real payload (>1 KB)",
    ttsProbe.status === 200 && ttsProbe.size > 1024,
    `probe HTTP ${ttsProbe.status} ${ttsProbe.size}B ${ttsProbe.type} keySource=${ttsProbe.keySource}`,
  );
  await page.locator("[data-testid='turn-speak'][data-state='playing']").waitFor({ timeout: 20_000 }).then(() => ok("朗读 entered playing", true)).catch(() => ok("朗读 entered playing", false, "never reached data-state=playing"));
  let afterTts = beforeTts;
  for (let i = 0; i < 10 && afterTts <= beforeTts; i++) { await page.waitForTimeout(3000); afterTts = usageRows(mintedKeyId); }
  ok("TTS billed to the user's minted key (usage_logs row)", afterTts > beforeTts, `rows ${beforeTts} → ${afterTts}; latest: ${latestUsage(mintedKeyId, 2)}`);

  // ── disconnect → deployment key again ────────────────────────────────────
  await page.goto(`${PLATFORM}/settings/connections?panel=ciyuan-account`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("ciyuan-account-disconnect").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("ciyuan-account-disconnect").click();
  await page.locator("[data-testid='ciyuan-account-state'][data-state='disconnected']").waitFor({ timeout: 30_000 });
  const status2 = await api("/api/voice/status");
  ok("after disconnect the voice lane falls back to the deployment key", status2.body?.available === true && status2.body?.keySource === "deployment", JSON.stringify({ ...status2.body, config: undefined }));

  // ── same-train deployment evidence (chat-connect-guidance, role-nav-apps) ─
  const ctaChunks = kexec(`grep -rl 'turn-connect-cta' /app/web/dist/assets/ 2>/dev/null | wc -l | tr -d ' '`);
  ok("served bundle carries the connect CTA (chat-connect-guidance deployed)", Number(ctaChunks) >= 1, `${ctaChunks} chunk(s)`);
  const navChunks = kexec(`grep -rl '"chat","knowledge","resources","agents","apps"' /app/web/dist/assets/ 2>/dev/null | wc -l | tr -d ' '`);
  ok("served bundle carries the simple preset with apps (role-nav-apps deployed)", Number(navChunks) >= 1, `${navChunks} chunk(s)`);
  const serverGuidance = kexec(`test -f /app/server/connect-guidance.js && grep -c 'ciyuan-account' /app/server/connect-guidance.js`);
  ok("server carries connect-guidance.js", Number(serverGuidance) >= 1, `${serverGuidance} ref(s)`);
} finally {
  await browser.close();
  if (mintedKeyId) {
    const del = psql(`UPDATE api_keys SET deleted_at=now() WHERE id=${mintedKeyId} AND deleted_at IS NULL RETURNING id`);
    console.log(`  test key ${mintedKeyId} soft-deleted in 词元: ${del || "(already gone)"}`);
  }
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
