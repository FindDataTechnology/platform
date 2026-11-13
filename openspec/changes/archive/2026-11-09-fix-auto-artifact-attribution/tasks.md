# Tasks — fix-auto-artifact-attribution

## 1. 判据先钉住（复现 CI 的那条红）

- [x] 1.1 确认 CI 失败只发生在 Linux：macOS 连跑 3 次 `test-browser-lane-service.mjs` 全绿（11/11），
      ubuntu runner 稳定红 `1.5 + 4.2 screenshots land in the calling cell's workspace`
- [x] 1.2 用 `utimesSync` 把产物 mtime 压到 `sinceMs` 之前，确定性复现「不认领、留在共享根」
  - 实证：`without a snapshot the clock still decides — the CI failure reproduced` 通过
    （该用例断言 cell 目录为空、共享根仍有 `auto-2.png`）

## 2. 实现

- [x] 2.1 `lib/browser-lane-artifacts.js` 新增 `listArtifactNames(root)`（名字集合，误差为 null 时空集）
- [x] 2.2 `newFilesSince({ root, sinceMs, skip, before })`：有 `before` 时按名字差分，缺失时退回 mtime
- [x] 2.3 `adoptNewFiles({ root, into, sinceMs, before })` 透传快照
- [x] 2.4 `server/browser-lane-service.js::forwardCall` 在调用上游前取快照并传入

## 3. 测试

- [x] 3.1 新增 `scripts/test-browser-lane-artifacts.mjs` 5 例：粗粒度 mtime + 快照 → 认领；
      粗粒度 mtime + 无快照 → 复现失败；调用前已存在的文件不认领；同名冲突加后缀不覆盖；目录不认领
  - 实证：`node --test scripts/test-browser-lane-artifacts.mjs` → **5 tests / 5 pass / 0 fail**
- [x] 3.2 既有服务套件仍绿
  - 实证：`node --test scripts/test-browser-lane-service.mjs` → **11 tests / 11 pass / 0 fail**

## 4. 收口

- [x] 4.1 `openspec validate fix-auto-artifact-attribution --strict` 绿
- [x] 4.2 lint（Biome）0 error
- [x] 4.3 归档（代码已落主线；spec 描述代码契约，出片节奏属发布线）
  - 实证：archive `~ 1 modified` → 归档为 `2026-11-09-fix-auto-artifact-attribution`；
    spec 现明写"按调用前的名字快照判定、不得依据文件时间戳 tick"
  - **未勾原因**：等本 change 随 paas 出片后再 `openspec archive`。
- [x] 4.4 复验 `1.5 + 4.2`（当初发现它的那条用例）
  - 实证：**真实依赖**跑 `scripts/test-browser-lane-service.mjs`（该文件用 mkdtemp 自建目录、
    不碰共享 sqlite，故借依赖安全）→ `✔ 1.5 + 4.2 screenshots land in the calling cell's
    workspace and not the other's (33ms)`，11/11 绿、耗时 4s；连跑三次均 11/0。
    配套确定性用例 `test-browser-lane-artifacts` 5/5（用 utimesSync 把 mtime 压到 sinceMs
    之前，正是当初 only-on-Linux 的边界）。
  - 注：原挂账写法是"回 ubuntu runner 复验"。改为本地真实依赖复现，因为镜像仓 CI 的
    unit 步骤本身已跑到 60+ 分钟（见下条观察），跑不到这条用例就有结果；
    而该用例的失败模式（mtime tick 取整）已被确定性用例覆盖，不再依赖平台。
