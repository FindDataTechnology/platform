# 壹座 · Yizuo — Universal Client (Android / iOS)

壹座官方通用客户端：连接任意自建壹座实例。首次使用在网页端 **设置 → 已配对设备** 生成绑定码，App 扫码（或输入地址 + 6 位码）完成设备配对。

## 开发

```bash
npm install
npm run start        # Expo dev server（真机用 Expo Go / 开发构建）
npm run typecheck    # tsc
npm run test:unit    # 单测 + 真实例集成冒烟 + i18n CJK 门
```

`@platform/core` 通过 `file:../packages/core` 引用（与 web/miniapp 同模式），仓库根目录下开发。

## 自编译（开源自足路径）

无需 EAS：本地出原生工程并构建。

```bash
npm install
npx expo prebuild --platform android   # 生成 app/android/
cd android && ./gradlew assembleDebug  # → app/build/outputs/apk/debug/
npx expo prebuild --platform ios       # 需 macOS + Xcode；生成 app/ios/
# iOS: cd ios && pod install && xcodebuild …（或 xed ios 打开工程）
```

包标识 `com.finddata.platform`（iOS bundle 同名）；签名用自己的开发者证书即可。

## 官方构建（维护者）

EAS Build（`eas.json` 的 `release` profile）：`eas build --profile release --platform all`；Android 产物为 signed APK 挂 GitHub Releases，iOS 走 `eas submit` 上 TestFlight。

## Maestro e2e

`.maestro/` 四条流（配对/聊天/Tab/语言切换），CI 见 `.github/workflows/app-e2e.yml`；本地 `maestro test .maestro/tabs.yaml`。

## 范围（v1）

对齐小程序主链（聊天/定时/资源/分享）+ 设置页；不做离线推送、OTA、深链、双主题（见 openspec `add-mobile-app`）。
