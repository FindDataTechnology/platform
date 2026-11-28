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

### Android 公开分发（不需要任何商店账号）

tag 构建（`.github/workflows/app-build.yml`）把 APK 挂到 GitHub Release；运维机随后跑

```bash
DL_HOST=cheap3 node scripts/mobile-release-sync.mjs v<版本>
```

它取 APK、算 sha256、rsync 到 `https://platform.finddatatech.cloud/dl/app/<版本>/`，并合并写
`/dl/app/app-releases.json`（**App 内「检查更新」唯一读取的文件**），最后逐个 URL 做 200 校验。

版本号只有一个源：`app/app.json` 的 `expo.version`。改版本后跑 `npm run version:sync`，
`test/version-sync.test.mjs` 会拦住漏改。

### iOS 为什么还没有公开下载

TestFlight 与 App Store 都需要付费的 **Apple Developer Program**（$99/年）。账号未就位前，
iOS 只有两条路：自编译（见上文）或内部 adhoc 分发。官网下载区据此只显示 Android，
并写明原因——不做指向不存在产物的假链接。

### 更新（不含 OTA）

App 内「设置 → 检查更新」读上面的清单，有新版本时给出下载入口（交系统浏览器），**不自行
安装、不依赖商店**。OTA（`expo-updates`，只发 JS 不发二进制）需要先有稳定二进制分发通道，
留作后续独立提案。

## Maestro e2e

`.maestro/` 四条流（配对/聊天/Tab/语言切换），CI 见 `.github/workflows/app-e2e.yml`；本地 `maestro test .maestro/tabs.yaml`。

## 范围（v1）

对齐小程序主链（聊天/定时/资源/分享）+ 设置页；不做离线推送、OTA、深链、双主题（见 openspec `add-mobile-app`）。
