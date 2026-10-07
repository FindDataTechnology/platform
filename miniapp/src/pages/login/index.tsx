// First sign-in on a device: bind this WeChat to a platform account by
// SCANNING the QR on the web's Settings → 微信小程序 page (openspec:
// add-mp-scan-bind). The same single-use 6-digit code is also printed there for
// typing, which is what the manual field below is for.
//
// The code is minted from an authenticated WEB session and redeemed once here —
// no password is ever entered in (or reachable from) the mini program. After
// that the openid stays bound and every later launch is silent.

import { useState } from "react";
import { Input, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { loginWithBindCode, logout } from "@/lib/auth";
import { scanBindCode } from "@/lib/bind-scan";
import PageHeader from "@/components/PageHeader";
import { baseUrl as currentBaseUrl, setBaseUrl, token } from "@/lib/config";
import { runtime } from "@/lib/runtime";

export default function LoginPage() {
  const router = useRouter();
  const [bindCode, setBindCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // `?server=1` (the chat page's disconnect line → 修改) opens with the
  // server field expanded, so the address being used is visible immediately.
  const [showServer, setShowServer] = useState(router?.params?.server === "1");
  const [serverDraft, setServerDraft] = useState(currentBaseUrl());
  const hasToken = Boolean(token());

  // The one redemption path — scanned and typed codes are the same secret and
  // take the same exchange, errors, and exit.
  const redeem = async (code: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await loginWithBindCode(code);
      Taro.showToast({ title: "绑定成功", icon: "success" });
      // Returning to the chat page fires its foreground hook, which re-boots
      // the runtime with the fresh token.
      setTimeout(() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/chat/index" }) }), 400);
    } catch (err) {
      setError((err as Error).message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    if (busy) return;
    setError("");
    const outcome = await scanBindCode();
    if ("cancelled" in outcome) return;
    if ("error" in outcome) {
      // The scan yielded no code: say so and send nothing (see the
      // miniprogram-auth spec's unscannable-payload scenario).
      setError(outcome.error);
      return;
    }
    setBindCode(outcome.code);
    await redeem(outcome.code);
  };

  const submit = () => {
    const normalized = bindCode.trim();
    if (!/^\d{6}$/.test(normalized)) {
      setError("请输入 6 位数字绑定码");
      return;
    }
    void redeem(normalized);
  };

  // Unbind deletes the server-side binding — destructive, so it confirms
  // like revoke and cron delete do (critique re-run P2).
  const unbind = () => {
    Taro.showModal({
      title: "退出登录",
      content: "将解绑当前微信并清除本机登录状态，确定？",
      success: (r) => {
        if (r.confirm) void doUnbind();
      },
    });
  };

  const doUnbind = async () => {
    await logout();
    Taro.showToast({ title: "已退出登录", icon: "none" });
    setBindCode("");
  };

  return (
    <View className="login-page">
      <PageHeader title="登录" />
      <View className="login-card">
        <Text className="login-title">登录 Platform</Text>

        <View className="login-scan" onClick={scan}>
          <Text className="login-scan-text">{busy ? "绑定中…" : "扫码绑定"}</Text>
        </View>
        <Text className="login-scan-hint">
          在电脑浏览器打开「{currentBaseUrl()}」，登录后进入「设置 → 微信小程序」，扫描页面上的二维码即可完成绑定。
        </Text>

        <View className="login-or">
          <Text className="login-or-text">或手动输入 6 位绑定码</Text>
        </View>

        <View className="login-field">
          <Text className="login-label">绑定码</Text>
          <Input
            className="login-input login-code-input"
            type="number"
            value={bindCode}
            onInput={(e) => setBindCode(e.detail.value)}
            placeholder="6 位数字"
            placeholderClass="login-placeholder"
            maxlength={6}
          />
        </View>

        {error ? <Text className="login-error">{error}</Text> : null}

        <View className={`login-submit login-submit-ghost ${busy ? "login-submit-disabled" : ""}`} onClick={submit}>
          <Text className="login-submit-text login-submit-text-ghost">绑定当前微信</Text>
        </View>

        <Text
          className="login-skip"
          onClick={() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/chat/index" }) })}
        >
          暂不登录，先看看 ›
        </Text>

        <Text
          className="login-guide"
          onClick={() => void Taro.navigateTo({ url: "/pages/bind-guide/index" })}
        >
          查看图文教程 ›
        </Text>

        <Text className="login-server-toggle" onClick={() => setShowServer((v) => !v)}>
          高级：服务器地址 ›
        </Text>
        {showServer ? (
          <View className="login-field">
            <Input
              className="login-input"
              value={serverDraft}
              onInput={(e) => setServerDraft(e.detail.value)}
              placeholder="http://localhost:3000 或网关地址"
              placeholderClass="login-placeholder"
            />
            <Text
              className="picker-link"
              onClick={() => {
                const next = serverDraft.trim().replace(/\/+$/, "");
                const changed = Boolean(next) && next !== currentBaseUrl();
                if (changed) setBaseUrl(next);
                Taro.showToast({ title: "已保存，重连中…", icon: "none" });
                setShowServer(false);
                // A different origin invalidates the stored token; boot fresh
                // so the auth probe runs against the new address.
                if (changed) void runtime.switchBase();
                else runtime.reconnectNow();
              }}
            >
              保存并重连
            </Text>
          </View>
        ) : null}

        {hasToken ? (
          <Text className="login-unbind" onClick={unbind}>
            退出登录并解绑当前微信
          </Text>
        ) : null}
      </View>
    </View>
  );
}