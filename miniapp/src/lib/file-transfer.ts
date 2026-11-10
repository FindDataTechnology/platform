// 小程序的文件取回/预览/转发(openspec: add-resource-library 8.3)。
//
// 小程序三条与 web 不同的硬约束,都收在这一个适配器里:
//   1. 没有 fetch/Blob:Taro.downloadFile 拿临时文件,再交给原生查看器。
//   2. downloadFile 不走 core 的 HTTP 传输,Authorization 必须自己带;401 时
//      静默重登一次再重试(与 taro-http 同一规则)。
//   3. 把文件带出微信只能靠 wx.shareFileMessage —— 基础库/版本不满足时,界面
//      隐藏"转发"而不是点了报错。

import Taro from "@tarojs/taro";
import { authHeaders, refreshToken } from "./auth";
import { baseUrl } from "./config";

// openDocument 的文件类型(与平台枚举一致;Taro 的 fileType 就是这七个键)。
type DocFileType = "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "pdf";
const DOC_EXTS: DocFileType[] = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf"];
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

export function extOfPath(p: string): string {
  const m = /\.([a-z0-9]+)$/i.exec((p || "").trim());
  return m?.[1]?.toLowerCase() ?? "";
}

/** /api/files?root=... 的相对路径 → 可下载的绝对地址。 */
export function absoluteFileUrl(path: string): string {
  return path.startsWith("http") ? path : `${baseUrl()}${path}`;
}

/** 平台能否原生打开这类文件(doc/xls/ppt/pdf)。图片走 previewImage。 */
export function canPreviewFile(name: string): boolean {
  const ext = extOfPath(name);
  return DOC_EXTS.includes(ext as DocFileType) || IMAGE_EXTS.includes(ext);
}

function downloadOnce(url: string, retried: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    Taro.downloadFile({
      url,
      header: authHeaders(),
      success: (res) => {
        if (res.statusCode === 401 && !retried) {
          void refreshToken().then((ok) => {
            if (!ok) {
              reject(new Error("登录已过期,请重新登录"));
              return;
            }
            downloadOnce(url, true).then(resolve, reject);
          });
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`下载失败(${res.statusCode})`));
          return;
        }
        resolve(res.tempFilePath);
      },
      fail: () => reject(new Error("下载失败,请检查网络")),
    });
  });
}

/** 取回文件的临时路径(带认证;401 静默重登一次)。 */
export function downloadToTemp(path: string): Promise<string> {
  return downloadOnce(absoluteFileUrl(path), false);
}

/** 原生预览:文档走 openDocument,图片走 previewImage。 */
export async function previewStoredFile(path: string, name: string): Promise<void> {
  const temp = await downloadToTemp(path);
  const ext = extOfPath(name);
  if (IMAGE_EXTS.includes(ext)) {
    await Taro.previewImage({ urls: [temp] });
    return;
  }
  await Taro.openDocument({ filePath: temp, fileType: ext as DocFileType, showMenu: true });
}

// wx.shareFileMessage:基础库 2.16.1+。Taro 的类型里没有它,按能力探测使用。
type ShareFn = (opts: { filePath: string; fileName?: string; success?: () => void; fail?: (e: unknown) => void }) => void;
declare const wx: { shareFileMessage?: ShareFn } | undefined;

export function canShareFile(): boolean {
  try {
    return typeof wx !== "undefined" && typeof wx?.shareFileMessage === "function" && Taro.canIUse("shareFileMessage");
  } catch {
    return false;
  }
}

/** 转发到微信聊天。返回 false 表示当前环境不支持(界面应隐藏该入口)。 */
export async function shareFileToChat(path: string, name: string): Promise<boolean> {
  if (!canShareFile()) return false;
  const temp = await downloadToTemp(path);
  return new Promise<boolean>((resolve, reject) => {
    wx?.shareFileMessage?.({
      filePath: temp,
      fileName: name,
      success: () => resolve(true),
      fail: (e) => {
        // 用户主动取消不算失败,静默即可。
        const msg = String((e as { errMsg?: string })?.errMsg || "");
        if (msg.includes("cancel")) resolve(true);
        else reject(new Error("转发失败"));
      },
    });
  });
}