// Taro binding for the mini-program recorder adapter (openspec:
// add-voice-input-mobile, task 2.1). Kept separate from recorder.ts so that
// file stays importable in node for the contract tests.
//
// `wx.getRecorderManager()` is a process-wide singleton — there is exactly one
// recorder per mini program, so the adapter replaces its handlers per take.

import Taro from "@tarojs/taro";
import { createMiniRecorderAdapter, uploadTakeToVoice, type MiniRecorderManager } from "./recorder";
import { authHeaders, refreshToken } from "./auth";
import { baseUrl } from "./config";

export type { MiniTake } from "./recorder";
export { VoiceUploadError } from "./recorder";

/** The adapter bound to this mini program's recorder + permission APIs. */
export function taroRecorder(maxDurationMs?: number) {
  return createMiniRecorderAdapter({
    isSupported: () => typeof Taro.getRecorderManager === "function",
    getRecorderManager: () => Taro.getRecorderManager() as unknown as MiniRecorderManager,
    getAuthSetting: async () => {
      try {
        const res = await Taro.getSetting();
        const scope = (res?.authSetting ?? {})["scope.record"];
        // undefined = never asked, false = denied, true = granted.
        return typeof scope === "boolean" ? scope : undefined;
      } catch {
        return undefined;
      }
    },
    requestAuth: async () => {
      try {
        await Taro.authorize({ scope: "scope.record" });
        return true;
      } catch {
        return false;
      }
    },
    maxDurationMs,
  });
}

/** Open the system settings sheet so a denied user can flip the switch. */
export async function openRecordSettings(): Promise<void> {
  try {
    await Taro.openSetting();
  } catch {
    /* the page falls back to its readable hint */
  }
}

/** Upload a take through Taro.uploadFile with the one-retry-on-401 rule. */
export function uploadTake(take: Parameters<typeof uploadTakeToVoice>[1]) {
  return uploadTakeToVoice(
    {
      apiBase: baseUrl(),
      authHeaders,
      refreshToken,
      uploadFile: async ({ url, filePath, name, header }) => {
        const res = await Taro.uploadFile({ url, filePath, name, header });
        return { statusCode: res.statusCode, data: String(res.data ?? "") };
      },
    },
    take,
  );
}
