// 聊天里的工作区文件链接 → 可点的文件 chip(openspec: add-resource-library 8.2)。
//
// 判定规则来自 @platform/core 的 fileLinkRef:与 web 的预览抽屉共用同一条
// "这是不是一个文件"的规则,两个客户端不会各说各话。小程序不能打开任意链接,
// 所以点击不开网页,而是弹原生操作单:预览 / 转发到聊天 / 存入资源。
//
// 存入后 chip 记住状态(本次会话内),不会引导用户做第二次注定"已存在"的保存。

import { useState } from "react";
import { Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { saveErrorText } from "@/lib/resources";
import { saveResource, useChatStore, type FileRef } from "@platform/core";
import { canPreviewFile, canShareFile, previewStoredFile, shareFileToChat } from "@/lib/file-transfer";

function fileRoutePath(ref: FileRef): string {
  return `/api/files?root=${ref.root}&path=${encodeURIComponent(ref.rel)}`;
}

export function FileChip({ name, fileRef }: { name: string; fileRef: FileRef }) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const preview = () => {
    Taro.showLoading({ title: "打开中…" });
    previewStoredFile(fileRoutePath(fileRef), name)
      .then(() => Taro.hideLoading())
      .catch((e: Error) => {
        Taro.hideLoading();
        Taro.showToast({ title: e.message || "无法预览", icon: "none" });
      });
  };

  const share = () => {
    Taro.showLoading({ title: "准备中…" });
    shareFileToChat(fileRoutePath(fileRef), name)
      .then((ok) => {
        Taro.hideLoading();
        if (!ok) Taro.showToast({ title: "当前环境不支持转发文件", icon: "none" });
      })
      .catch((e: Error) => {
        Taro.hideLoading();
        Taro.showToast({ title: e.message || "转发失败", icon: "none" });
      });
  };

  const save = () => {
    if (fileRef.root !== "workspace") {
      Taro.showToast({ title: "该文件不在工作区,无法存入资源", icon: "none" });
      return;
    }
    setBusy(true);
    saveResource({ path: fileRef.rel, sessionId: useChatStore.getState().currentSessionId })
      .then(({ inserted }) => {
        setSaved(true);
        Taro.showToast({ title: inserted ? "已存入资源" : "资源库中已存在", icon: "none" });
      })
      .catch((e) => Taro.showToast({ title: saveErrorText(e), icon: "none" }))
      .finally(() => setBusy(false));
  };

  const tap = () => {
    if (busy) return;
    const actions: Array<{ label: string; run: () => void }> = [];
    if (canPreviewFile(name)) actions.push({ label: "预览", run: preview });
    if (canShareFile()) actions.push({ label: "转发到聊天", run: share });
    if (!saved && fileRef.root === "workspace") actions.push({ label: "存入资源", run: save });
    if (actions.length === 0) {
      Taro.showToast({ title: "当前环境无法打开该文件", icon: "none" });
      return;
    }
    // 单一动作直接执行,不弹只有一个选项的单。
    if (actions.length === 1) {
      actions[0].run();
      return;
    }
    Taro.showActionSheet({ itemList: actions.map((a) => a.label) })
      .then((res) => actions[res.tapIndex]?.run())
      .catch(() => {});
  };

  return (
    <Text
      className={`file-chip${saved ? " file-chip-saved" : ""}`}
      data-testid="mp-file-chip"
      data-saved={saved ? "true" : "false"}
      onClick={tap}
    >
      📄 {name}
      {saved ? " · 已存入" : ""}
    </Text>
  );
}