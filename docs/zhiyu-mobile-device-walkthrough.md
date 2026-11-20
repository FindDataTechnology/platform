# 智语移动端验收：CI 覆盖面矩阵（openspec: add-zhiyu-mobile-clients, 任务 7.2）

> **2026-11-12 改口径（用户裁决）**：这一页原来是「11 项 × 3 端 ＝ 33 行人工截图」。
> 裁决是「要真机测试的部分，改用 GitHub 的测试方案」，所以现在的验收对象变成
> **每一条断言在哪一个 CI 作业里跑**；只有机器确实验不了的，才留着由人做，并且
> 必须点名是哪一半、为什么机器验不了。
>
> 判据：**表里每一格的作业名/文件名都必须真实存在且为绿**。不存在「计划中」的格子——
> 计划中的东西写在最后一节「还剩什么不能机检」里，不混进验收。

## 0. 三条通道各自能跑到哪一步

| 通道 | CI 作业 | 跑什么 | 不能跑什么 |
|---|---|---|---|
| web（手机浏览器同源） | `.github/workflows/ci.yml` → Playwright `fast` | `e2e/zhiyu-room-window.spec.js`、`e2e/zhiyu-unread-badge.spec.js` | 真实手机视口下的触控手感（那是 CSS/渲染，不是逻辑；窄屏另有断点用例） |
| 小程序 | `.github/workflows/miniapp-ci.yml` | lint / typecheck / markdown 单测 / **构建产物闸**（`scripts/verify-miniapp-zhiyu-pages.mjs`） | 真微信客户端里的运行（无头 CI 没有微信；见 §2） |
| Android App | `.github/workflows/app-e2e.yml` → `android` 档（**`workflow_dispatch` 手动挂载**） | 真模拟器：配对 → 进房 → 尾部起播 → 加载更早（`app/.maestro/zhiyu.yaml`，实例为 `e2e/zhiyu-gateway-mock.mjs`） | iOS（macOS runner 10× 计费，已排除；见 §2） |
| 三端共用的逻辑 | `.github/workflows/ci.yml` → `npm run test:unit` | 全部 `scripts/test-zhiyu-*.mjs` / `test-voice-*.mjs` / `test-mobile-handoff.mjs` | 只跑逻辑，不跑像素 |

**为什么 App 档要把房间放在第三个实例**：房间是跨用户对象，内核挂在
`gateway/index.js`（`registerZhiyuRoutes`），`server.js`（cell）里没有
`/api/zhiyu/*`。所以 android 档里 9411/9412 两个 cell mock 都拿不出房间，
`e2e/zhiyu-gateway-mock.mjs` 挂的是**真内核**（尾部/游标/翻页语义就是生产的那套），
只手写了配对的两个端点（`/api/config`、`/api/app/pair`）。

## 1. 11 项逐条：机检跑到哪、还剩什么

| # | 走查项 | 机检（作业 · 用例） | 机器验的是 | 还剩（仅人工） |
|---|---|---|---|---|
| 1 | 进房 | `ci.yml`·`scripts/test-app-zhiyu-routes.mjs`（expo-router 真 `getRoutes` 解析 tab 树：四个 tab、zhiyu 内嵌栈、push 的 pathname 与解析结果一致）＋ `scripts/test-zhiyu-clients-share-the-machine.mjs`（三屏共用一台状态机）＋ `miniapp-ci.yml`·产物闸（两页发出且**有入口**）＋ android 档·Maestro（真点 tab → 列表 → 进房） | 路由/入口/产物存在性，Android 上真渲染 | 真微信里从抽屉点进列表 |
| 2 | 看流：尾部起播 | `ci.yml`·`e2e/zhiyu-room-window.spec.js`（500 行房间首屏不从头播）＋ `scripts/test-zhiyu-mobile-model.mjs` ＋ android 档·Maestro（**断言「第 60 条消息」在屏、`assertNotVisible`「第 1 条消息」**） | 首屏是尾部窗口（正面 + 反面两个断言），Android 上真滚屏 | iOS 上的首屏时序 |
| 3 | 上滑翻页 | 同上 ＋ android 档·Maestro（点「加载更早」后向上滚到「第 30 条消息」——与尾窗最旧的第 31 条相邻） | 前插相邻窗口、游标不回退 | 真机手势与惯性滚动 |
| 4 | 说话 → 可改再发 | `scripts/test-zhiyu-mobile-model.mjs`·`transcriptIntoDraft`（只进草稿、不自动发送）＋ `test-voice-capture-mobile.mjs`（10 例）＋ `test-voice-adapter-parity.mjs` | 转写只落草稿这一条**电路**对 | 真麦克风 + 真 ASR 的「字对不对」（见 §2，与 voice 6.1 同一条） |
| 5 | 打字发送与失败保留 | `scripts/test-zhiyu-mobile-model.mjs`·`applySendFailed`（失败把原文放回输入框） | 失败态的草稿不丢 | 真弱网/飞行模式下的手感 |
| 6 | 在场状态只读 | `scripts/test-zhiyu-mobile-model.mjs`·`presenceLine` ＋ 源码闸（移动端没有「拉人/改席位」实现） | 只读，且管理面在移动端**不存在** | — |
| 7 | 切后台 5 分钟回来 | `scripts/test-zhiyu-poll-ladder.mjs`（4.3 两条：后台五分钟回来**一次**补齐到 60 条且断言序列恰为 `1..60`（连续、无洞——单发一次增量就会在 25 附近留洞）、持久游标恢复不回放整间房） | 补读连续无洞无重 | 真 OS 生命周期（Android 可能被杀进程后冷启） |
| 8 | 断网 3 分钟再恢复 | `scripts/test-zhiyu-poll-ladder.mjs`（3.2 三分钟断流退避到 3s、恢复不丢不重；ladder 1s→3s 封顶且成功即复位） | 退避序列与恢复补齐 | 真射频/运营商切换 |
| 9 | 传输降级可读 | `scripts/test-zhiyu-mobile-model.mjs`·`syncFailures` / `holdFor` / `connectionNote`（降级前后 rows/cursor/draft 逐字段不变） | 提示出现且不破坏已有状态 | 提示文案在小屏上的换行（CSS 层） |
| 10 | 重交互交给 web | `scripts/test-mobile-handoff.mjs`（12 例：一次性 `zdl_` 链接、二次复用被拒、URL 不带凭据参数） | 权限模型只有一套 | 电脑浏览器里真正落到的面板 |
| 11 | 访客进房 | `scripts/test-zhiyu-guest-mobile.mjs`（4 例：访客读窗与房内逐条相等、可发言、私窗两条传输都不可见、房内管理端点 401） | 访客面是封闭清单 | — |

**防漂移**：App 档的 Maestro 流程本地跑不了（要模拟器），所以它的**契约**由
`scripts/test-zhiyu-device-lane-contract.mjs` 在每次 push 上钉住：种子行数必须
超过 App 的 `tailCount`（否则整间房一页到齐，「加载更早」根本不渲染，第 2/3 项会
在没被走到的情况下"过"）、流程断言的字符串必须等于种子/`tailCount`/`pageSize`
算出来的那两条、点到的每个 testid 与两个语种的 tab 标签必须存在、harness 必须挂
真内核且不许手写房间端点。该闸已用「把种子改成 20」证明能红（3 条失败）。

## 2. 还剩什么不能机检（按名字留着，不混进验收）

1. **真微信客户端**。CI 里没有微信：`miniprogram-ci` 能构建/上传，不能运行。
   产物闸能证明「两页发出去了、有人能导航到它们」，但「在微信的抽屉里点进去，
   标题是不是房间名」只有真微信能答。
2. **iOS 运行时**。`app-e2e.yml` 的 `ios-nightly` 是 macOS runner，10× 计费，
   与 2026-10 那次私仓额度事故同源，所以维持手动。要把它纳入验收＝一次明确的
   额度决策，不是顺手加一行。
3. **语音的听感与转写正确性**。机器能验「分片全成功、归并有序、音频零留存、
   文本只进草稿」；不能验「转出来的字对不对」。这一段没有独立参考稿，拿 ASR
   自己的输出当基准＝自己判自己的卷（同一模型的同一偏差会被判绿）。要做成机检
   只有一条路：人工校订一次存成 `expected.txt`，此后按编辑距离阈值比对——
   那是新任务（`add-voice-capture-lane` 6.1 仍为未完成，正因这一半）。

## 3. 复跑命令

```bash
# 三端共用的逻辑闸（含上面 1/2/3/4/5/6/7/8/9/10/11 的全部用例）
npm run test:unit                                  # = node --test scripts/test-*.mjs
node --test scripts/test-zhiyu-device-lane-contract.mjs   # 单跑设备档契约

# web 读路径（尾部起播 / 翻页 / 未读角标）
npm run web:build:e2e && npx playwright test --project=fast e2e/zhiyu-room-window.spec.js

# 小程序：页面是否真的发在产物里、是否有入口（~8s）
node scripts/verify-miniapp-zhiyu-pages.mjs

# Android 真模拟器：本机起 harness，再跑流程（真跑要模拟器 / adb）
PORT=9413 MOCK_DATA_DIR=$(mktemp -d) node e2e/zhiyu-gateway-mock.mjs   # 打印绑定码
(cd app && maestro test -e OUTPUT_INSTANCE=http://<host>:9413 -e PAIRING_CODE=<code> .maestro/zhiyu.yaml)

# CI 上：dispatch-only 的 android 档（apk → 模拟器，两档都手动）
gh workflow run app-e2e.yml
```

**App 档的首次绿色 dispatch 才是它的验收**：流程、harness、种子、断言都已就位并
在本地用真实 HTTP 逐窗口核对过（`tail=30` → seq 32..61；`before=32&limit=20` →
seq 12..31；`stream?after=61&wait=0` → 空增量、游标不动），但 Maestro 本身只在
模拟器上跑得起来，所以这一条在第一次 dispatch 绿之前，只能算「已接好、未跑过」
——不要写成「已通过」。
