## Why

F2.3（`docs/facet-market-roadmap.md`）：装好的功能集需要一条诚实的更新路径——快照模型下
「更新」= 重取最新版快照，无订阅副作用。今天没有 update 命令，用户只能重跑 install
且不知道版本前后。

## What Changes

- **安装记录**：install 落一笔本地记录 `~/.facet/installed.json`
  （`[{packId, name, target, scope, project, version, installedAt}]`，FACET_HOME 随动）。
- **`facet update [packRef] [--target X]`**：
  - 无参=更新全部记录；带 packRef=更新该包（--target 收窄）。
  - 每笔：取最新版本详情 → 已最新打 `✓ 已最新 vN`；否则重写技能（同 install 写路径）
    并更新记录，打印 `v旧 → v新`。
  - 包已 404/私有：诚实报错继续其余；**零订阅副作用**（纯快照重取）。
- CLI 版本 0.2.1 → 0.2.2；help 文案补 update。
- 测试：记录写入/合并（同包多 target）、update 全量/单包/已最新/404 路径（stub 面）。
- npm 发布：版本 bump 后走 facet-cli-publish 工作流（若 org 账单阻断则如实挂起，
  staged publish 网页批准为备选——需用户一次密钥触控）。

## Impact

- facet/cli/facet.js（+记录、+update 子命令）、package.json 版本；零服务端改动。
- specs：facet-platform 增补 CLI 更新路径需求。
