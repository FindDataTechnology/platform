// @live meeting-capture entry — the half `meeting-capture-client-wiring` added.
//
// The three tests in live-meeting-capture.spec.js drive the MEETING (open /
// join / end) and the panel. None of them ever asks the question this change is
// about: "can a person who joined this meeting record their own stream from the
// entry, and does that stream land in the room attributed to them?"
//
// A synthetic microphone is used deliberately and honestly:
//   --use-fake-device-for-media-stream  gives getUserMedia something to read
//   --use-file-for-fake-audio-capture   feeds it a REAL spoken WAV
// The WAV is produced locally with `say` + `afconvert` (2.85s of speech), so the
// production ASR has genuine audio to transcribe rather than silence.
//
// THE FIELD NAME IS NOT THE ONE THE TASK TEXT USED. A session capture declares
// its owner (the authenticated subject on the create call), and metaFor() omits
// the inferred `seatOwnerMemberId` whenever a declaration exists:
//
//     const declared = capture?.speakerMode === "session" ? (capture.owner ?? null) : null;
//     const seatOwner = declared ? null : (member ?? null);
//     ...(declared ? { declaredMemberId: declared } : {}),
//     ...(seatOwner ? { seatOwnerMemberId: seatOwner } : {})
//
// So the assertion is `meta.capture.declaredMemberId === my memberRef` +
// `mode === "per_stream"`: same substance — "this message is MY stream" — under
// the field the shipped code writes. Asserting seatOwnerMemberId would fail on
// correct behaviour.
//
// `launchOptions` must sit at the top level of the file (Playwright refuses it
// inside a describe block: it forces a new worker).

import { test, expect } from "@playwright/test";
import { LIVE_SERVICE_URL, pinLocaleEn, logtoSignIn } from "./live-helpers.js";

const IDENTIFIER = process.env.PAAS_TEST_IDENTIFIER || "";
const PASSWORD = process.env.PAAS_TEST_PASSWORD || "";
const FAKE_MIC = process.env.LIVE_FAKE_MIC || "/tmp/mc-speech.wav";

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      // The live project bypasses any ambient proxy; keep that here since this
      // use() replaces the project's args array wholesale.
      "--proxy-server=direct://",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${FAKE_MIC}`,
    ],
  },
});

test("a joined participant records from the entry and the room receives their own stream @live", async ({ page }) => {
  test.skip(!IDENTIFIER || !PASSWORD, "PAAS_TEST_IDENTIFIER/PAAS_TEST_PASSWORD required");
  test.setTimeout(300_000);

  await pinLocaleEn(page);
  await logtoSignIn(page, { identifier: IDENTIFIER, password: PASSWORD });
  await page.goto(`${LIVE_SERVICE_URL}/zhiyu`, { waitUntil: "domcontentloaded" });

  // A room + an open meeting through the API: the clicks are spent on the thing
  // under test, not on three pages of setup.
  const setup = await page.evaluate(async () => {
    const call = async (m, p, b) => {
      const r = await fetch(p, {
        method: m,
        headers: b === undefined ? {} : { "Content-Type": "application/json" },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const room = await call("POST", "/api/zhiyu/rooms", { title: "E2E 入口录音（自动清理）" });
    const roomId = room.body?.room?.id ?? null;
    if (!roomId) return { failedAt: "room" };
    const opened = await call("POST", `/api/zhiyu/rooms/${roomId}/meetings`, { title: "E2E 入口会议" });
    const meetingId = opened.body?.meeting?.id ?? null;
    if (!meetingId) return { roomId, failedAt: "meeting" };
    return { roomId, meetingId, opened: opened.status };
  });
  expect(setup.failedAt, `setup failed: ${JSON.stringify(setup)}`).toBeUndefined();
  expect(setup.opened).toBe(201);

  try {
    // ① 还没加入：入口不该出现（它要等服务端说「你是这一场的人」）
    await page.goto(`${LIVE_SERVICE_URL}/zhiyu/${setup.roomId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("zhiyu-meeting-panel")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("zhiyu-meeting-record-mine"), "未加入时没有「记录我这一路」").toHaveCount(0);

    // ② 加入之后：入口出现。这一步红就是「我的那一路」又在按名单顺序猜。
    const joined = await page.evaluate(async (id) => {
      const r = await fetch(`/api/zhiyu/meetings/${id}/join`, { method: "POST" });
      const j = await r.json().catch(() => null);
      return {
        status: r.status,
        memberRef: j?.participant?.memberRef ?? null,
        memberId: j?.participant?.memberId ?? null,
        captureId: j?.participant?.captureId ?? null,
      };
    }, setup.meetingId);
    expect(joined.status).toBe(200);
    expect(joined.memberRef, "我自己的席位（memberRef）").toBeTruthy();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("zhiyu-meeting-record-mine"), "加入后入口出现").toBeVisible({ timeout: 30_000 });

    // ③ 从入口开录：对话框打开即是「会议上下文里的那一次采集」。
    // 房间输入框只在转写完成之后才渲染（它与合并文本同一块），所以「预填」
    // 的断言放在 ⑤ 发送之前——在这里断言会拿不到元素，那是渲染时机不是缺陷。
    await page.getByTestId("zhiyu-meeting-record-mine").click();
    await expect(page.getByTestId("capture-dialog")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("capture-start").click();
    await expect(page.getByTestId("capture-stop"), "开录后出现停止").toBeVisible({ timeout: 30_000 });
    // 假麦克风循环喂 2.85s 语音；录 4 秒足够 ASR 拿到一句话。
    await page.waitForTimeout(4_000);
    await page.getByTestId("capture-stop").click();
    await expect(page.getByTestId("capture-finish"), "停止后可结束").toBeVisible({ timeout: 30_000 });
    await page.getByTestId("capture-finish").click();

    // ④ 采集本身成立——这一段与 ASR 无关，全部是确定性的：
    //    客户端带会议上下文创建 → 服务端记下 speakerMode/meetingId → 音频真的传上来
    await expect(page.getByTestId("capture-merged"), "合并视图出现（无论转写成功与否）").toBeVisible({
      timeout: 180_000,
    });
    const state = await page.evaluate(async () => {
      const list = await fetch("/api/voice/captures").then((r) => r.json()).catch(() => null);
      const c = (list?.captures ?? [])[0] ?? null;
      if (!c) return null;
      const one = await fetch(`/api/voice/captures/${c.id}`).then((r) => r.json()).catch(() => null);
      return { capture: c, chunks: one?.chunks ?? [] };
    });
    expect(state, "刚结束的那一路采集能在列表里读到").toBeTruthy();
    expect(state.capture.speakerMode, "客户端把 speakerMode=session 带到了服务端").toBe("session");
    expect(state.capture.meetingId, "采集记着它属于本场会议").toBe(setup.meetingId);
    expect(state.capture.status).toBe("finished");
    const chunk = state.chunks[0] ?? null;
    expect(chunk?.bytes ?? 0, `音频真的上传了（bytes=${chunk?.bytes}，mime=${chunk?.mime}）`).toBeGreaterThan(1000);

    // ④b 绑定成立：会议里我这一行的 captureId 正是这一路。
    //     这是真机验收（6.4）派发到「我」的软件前提，且不依赖转写内容。
    const myRow = await page.evaluate(async ({ id, memberRef }) => {
      const r = await fetch(`/api/zhiyu/meetings/${id}`);
      const j = await r.json().catch(() => null);
      return (j?.participants ?? []).find((p) => p.memberRef === memberRef) ?? null;
    }, { id: setup.meetingId, memberRef: joined.memberRef });
    expect(myRow, "会议名单里有我这一行").toBeTruthy();
    expect(myRow.captureId, "我这一行绑着刚录的那一路").toBe(state.capture.id);

    // ⑤ 「送进房间」需要文本，文本来自生产 ASR。若上游拒绝，就没有东西可送，
    //    消息归属这一步无法判定——带出处跳过，而不是判成红/绿。
    //    自动失效条件：ASR 恢复后 chunk.status === "ok"，本用例自动走完整路径。
    if (chunk?.status === "failed" && chunk?.errorCode === "upstream_error") {
      test.skip(
        true,
        "生产 ASR 上游拒绝：切片 status=failed errorCode=upstream_error，pod 日志 " +
          "[voice] upstream 400 on transcriptions (invalid_request_error)。转写为空 ⇒ 没有可送进房间的文本，" +
          "消息归属无法判定。与本变更无关（采集/绑定已在上面的断言里证过）；恢复后本用例自动跑完最后两步。",
      );
    }

    const text = (await page.getByTestId("capture-text").innerText()).trim();
    expect(text.length, `转写文本不该为空（实际 ${JSON.stringify(text)}）`).toBeGreaterThan(0);

    // ⑥ 送到房间：房间号由会议上下文预填（任务 2.2），确认仍是显式一步（散装路径语义不变）
    await expect(page.getByTestId("capture-room-input"), "房间号预填为本场会议的房间").toHaveValue(setup.roomId, {
      timeout: 20_000,
    });
    await page.getByTestId("capture-to-room").click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("confirm-dialog-confirm").click();

    // ⑦ 房间里出现了这一路，且归属是本人
    const readMeta = () =>
      page.evaluate(async (id) => {
        const r = await fetch(`/api/zhiyu/rooms/${id}/messages?limit=50`);
        const j = await r.json().catch(() => null);
        return j?.messages ?? [];
      }, setup.roomId);

    let mine = null;
    for (let i = 0; i < 45 && !mine; i++) {
      const msgs = await readMeta();
      mine =
        msgs.find(
          (m) => m?.meta?.source === "capture" && m?.meta?.capture?.declaredMemberId === joined.memberRef,
        ) ?? null;
      if (!mine) await page.waitForTimeout(2_000);
    }
    if (!mine) {
      const tail = (await readMeta()).map((m) => m?.meta).slice(-3);
      expect(mine, `房间里没有归属为 ${joined.memberRef} 的采集消息，最后三条 meta=${JSON.stringify(tail)}`).toBeTruthy();
    }
    expect(mine.meta.capture.mode, "一人一路：per_stream").toBe("per_stream");
    expect(mine.meta.meetingId, "这条消息属于本场会议").toBe(setup.meetingId);
    console.log(
      `LIVE_ENTRY_OK meeting=${setup.meetingId} text=${JSON.stringify(text.slice(0, 40))} declared=${mine.meta.capture.declaredMemberId}`,
    );
  } finally {
    await page
      .evaluate((id) => fetch(`/api/zhiyu/rooms/${id}/end`, { method: "POST" }), setup.roomId)
      .catch(() => {});
  }
});
