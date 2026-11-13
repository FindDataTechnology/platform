## Why

桌面应用内更新的发布链（release.yml → hkccr OCI 中继 → cheap3 同步 → RustFS lane）自 2026-11-02 演练后从未在生产真正走通：v1.3.27、v1.3.28 两次出片 lane 均未更新（冻结在 1.3.19），客户端恒「已是最新」，升级路断裂。2026-11-07 排障定位出三处静默缺陷——凭据名漂移（release.yml 读 `TCR_USER/TCR_PASS`，池上实配的是仓内正统的 `TCR_USERNAME/TCR_PASSWORD`）、`.dockerignore` 剔除 `dist` 致 lane OCI build 必炸、以及整条链 fail-open（缺凭据 exit 0 假绿、同步 worker 连续 SKIP 无人知晓）。v1.3.28 已于 11-07 手工旁路补上 lane（sha512 全程校验），但 CI 路本身仍未被证明，同样的静默断裂会在下次换池/出片时复发。

## What Changes

- release.yml lane push 步骤改读仓内正统凭据名 `TCR_USERNAME/TCR_PASSWORD`（与 image.yml / image-publish.yml 对齐，池上已有、推送权已在产真证）。
- lane OCI build 改用隔离临时 context（仅 dist + Dockerfile），不再受仓根 `.dockerignore`（剔除 `dist`）影响。
- **fail-loud**：tag 发布时 TCR 凭据缺失/推送失败 = publish job 硬失败（spec 契约要求 CI 发布元数据到发布道，现 fail-open 实为违约）；push 后加 manifest 复验。
- cheap3 同步面加对账探针：lane `latest.yml` 版本 vs hkccr `:current` 内 yml 版本定期核对，漂移/连续拉取失败以显式 `LANE-STALE` 标记大声失败（exit 1），不再静默 SKIP。
- RELEASE_CHECKLIST 增补池迁移段：换池必配 `TCR_USERNAME/TCR_PASSWORD`、workflow 面四件对齐；记录「GH release 资产名（点分隔）≠ yml 内文件名（electron-builder 原名，可含空格）」的落盘契约——任何从 release 资产同步 lane 的旁路必须按 yml 名落盘。
- 收尾：验证 CI 路一次真通（test-tag 演练或下次 release）后，移除 11-07 临时补在 testaction001 的 `TCR_USER/TCR_PASS` 别名 secrets 与 hkccr `:push-probe` 探针 tag。

## Capabilities

### New Capabilities

（无——全部是对既有 desktop-app-update 行为的收紧与运维面补强，不引入新能力。）

### Modified Capabilities

- `desktop-app-update`: 发布道发布契约增补两条场景——凭据缺失/推送失败时发布班必须硬失败（不留假绿）；lane 与中继源需可对账（新鲜度漂移必须显式暴露，不得静默降级吞掉断链）。

## Impact

- `.github/workflows/release.yml`（lane push 步骤：凭据名、context 隔离、fail-loud、manifest 复验）。
- cheap3 `/etc/desktop-lane`（同步 worker 对账探针；`desktop-lane-sync.sh` 的 SKIP 语义改为可升级失败）。
- `RELEASE_CHECKLIST.md`（池迁移 checklist + 资产名契约注记）。
- 池仓（testaction001/005）workflow 面随下次出片手工补齐时同步本修复；临时别名 secrets 与 push-probe tag 的清理挂尾。
- 客户端无任何改动；lane 元数据契约（latest*.yml 形态、追加语义、sha512 校验）不变。
