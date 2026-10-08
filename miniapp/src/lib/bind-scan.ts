// Scan-to-bind, in one place (openspec: add-mp-scan-bind, D3).
//
// The camera, the payload parser, and the app's reaction to both live here so
// the login page's primary button and the guide page's trailing 立即扫码绑定
// cannot drift apart. Redeeming the code stays with the caller: it needs the
// page's busy/error state and its own navigation.
//
// A cancelled scan is not a failure. WeChat rejects the promise with
// `scanCode:fail cancel` when the user backs out of the camera, and showing an
// error for that would punish the most ordinary thing a user can do.

import Taro from "@tarojs/taro";
import { parseBindPayload } from "./bind-qr";

export type ScanOutcome = { code: string } | { error: string } | { cancelled: true };

const CAMERA_FAILED = "无法打开相机，请检查相机权限后重试，也可以手动输入绑定码";

export async function scanBindCode(): Promise<ScanOutcome> {
  let raw = "";
  try {
    const res = await Taro.scanCode({ scanType: ["qrCode"] });
    raw = String(res?.result ?? "");
  } catch (err) {
    const message = String((err as { errMsg?: string })?.errMsg ?? "");
    if (/cancel/i.test(message)) return { cancelled: true };
    return { error: CAMERA_FAILED };
  }
  return parseBindPayload(raw);
}