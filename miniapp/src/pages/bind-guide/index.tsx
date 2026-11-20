// 图文绑定教程页(openspec: mp-bind-guide)。第一次用小程序的人不知道绑定码在
// 哪里,这一页把整条路走一遍:电脑打开平台 → 登录 → 设置里的「微信小程序」→
// 回到手机扫码。每一步都用 View + CSS 画出示意图(不引外部图片、不联网),
// 第一步的网址取自当前连接的账号服务器——演示沙箱地址永远不会出现在这里。
//
// 与 cron/resources 页同一约定:小程序无 i18n 运行时,直接中文字面量。

import { useState } from "react";
import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import PageHeader from "@/components/PageHeader";
import { scanBindCode } from "@/lib/bind-scan";
import { loginWithBindCode } from "@/lib/auth";
import { accountBaseUrl } from "@/lib/config";

// 四步:顺序即用户的路径,编号与示意图一一对应。
const STEPS = [
  "在电脑浏览器打开下面的网址",
  "登录你的平台账号",
  "打开「设置 → 微信小程序」,页面上会显示二维码",
  "回到手机,点击下面的「立即扫码绑定」扫描二维码",
] as const;

export default function BindGuidePage() {
  // 当前连接的账号服务器;演示沙箱地址永远不会出现在这一页。
  const site = accountBaseUrl();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const copy = () => {
    // weapp 的 setClipboardData 自带一个原生提示;这里再落一行页内确认,
    // 因为原生提示不可被测试读到,也不该是唯一的反馈。
    Taro.setClipboardData({ data: site })
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      })
      .catch(() => Taro.showToast({ title: "复制失败", icon: "none" }));
  };

  // 与登录页主按钮走同一个扫码→兑换路径,两处不会各自漂移。
  const scan = async () => {
    if (busy) return;
    setError("");
    const outcome = await scanBindCode();
    if ("cancelled" in outcome) return;
    if ("error" in outcome) {
      setError(outcome.error);
      return;
    }
    setBusy(true);
    try {
      await loginWithBindCode(outcome.code);
      Taro.showToast({ title: "绑定成功", icon: "success" });
      setTimeout(() => Taro.reLaunch({ url: "/pages/chat/index" }), 400);
    } catch (err) {
      setError((err as Error).message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="guide-page">
      <PageHeader title="扫码绑定教程" />
      <View className="guide-body">
        <Text className="guide-lede">四步完成绑定,之后打开小程序自动登录。</Text>

        {STEPS.map((text, i) => (
          <View className="guide-step" key={text}>
            <View className="guide-step-index">
              <Text className="guide-step-index-text">{i + 1}</Text>
            </View>
            <View className="guide-step-main">
              <Text className="guide-step-text">{text}</Text>
              {/* 第一步的示意图就是浏览器地址栏本身,后面三步各画一个 */}
              {i === 0 ? (
                <View className="guide-browser">
                  <View className="guide-browser-bar">
                    <View className="guide-browser-dot" />
                    <View className="guide-browser-dot" />
                    <View className="guide-browser-dot" />
                    <View className="guide-browser-addr">
                      <Text className="guide-browser-addr-text">{site}</Text>
                    </View>
                  </View>
                </View>
              ) : null}
              {i === 1 ? (
                <View className="guide-browser">
                  <View className="guide-form">
                    <View className="guide-form-field" />
                    <View className="guide-form-field" />
                    <View className="guide-form-btn" />
                  </View>
                </View>
              ) : null}
              {i === 2 ? (
                <View className="guide-browser">
                  <View className="guide-settings">
                    <View className="guide-settings-row">
                      <View className="guide-settings-icon" />
                      <View className="guide-settings-line" />
                    </View>
                    <View className="guide-settings-row guide-settings-row-active">
                      <View className="guide-settings-icon" />
                      <View className="guide-settings-line" />
                      <Text className="guide-settings-active-text">微信小程序</Text>
                    </View>
                    <View className="guide-settings-row">
                      <View className="guide-settings-icon" />
                      <View className="guide-settings-line" />
                    </View>
                  </View>
                </View>
              ) : null}
              {i === 3 ? (
                <View className="guide-phone">
                  <View className="guide-phone-screen">
                    <View className="guide-scan-frame">
                      <View className="guide-scan-corner guide-scan-tl" />
                      <View className="guide-scan-corner guide-scan-tr" />
                      <View className="guide-scan-corner guide-scan-bl" />
                      <View className="guide-scan-corner guide-scan-br" />
                      <View className="guide-scan-qr" />
                    </View>
                    <View className="guide-scan-btn" />
                  </View>
                </View>
              ) : null}
            </View>
          </View>
        ))}

        {/* 网址行:来自当前连接的账号服务器,可一键复制 */}
        <View className="guide-url" onClick={copy}>
          <Text className="guide-url-text">{site}</Text>
          <Text className="guide-url-copy">{copied ? "已复制" : "复制"}</Text>
        </View>
        {copied ? <Text className="guide-url-done">网址已复制,粘贴到电脑浏览器打开</Text> : null}

        {error ? <Text className="guide-error">{error}</Text> : null}

        <View className={`guide-scan-action ${busy ? "guide-scan-action-disabled" : ""}`} onClick={scan}>
          <Text className="guide-scan-action-text">{busy ? "绑定中…" : "立即扫码绑定"}</Text>
        </View>
        <Text className="guide-footnote">绑定码 5 分钟内有效且只用一次;扫码后本机自动登录。</Text>
      </View>
    </View>
  );
}