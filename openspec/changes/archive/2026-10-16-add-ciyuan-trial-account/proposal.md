## Why

伙伴介绍文档（`finddata/docs/ciyuan-intro.md`）的测试账号表是**空占位**——上轮
（add-ciyuan-partner-intro）定性为「伙伴名单未定，待开通后填入」。用户现确认需要：
一个**可用全部模型的测试账号 + 10 美金测试额度**，供发合作伙伴直接试用。

拓扑约束（explore 取证）：词元能力按分组分家——chat 与三车道的计价/密钥在
「openrouter」分组（id 3，专属分组），图像 + 视频只在「image」分组（id 9，
公开分组；其内 seedance 账号仅绑此组，且 `/contents/generations/tasks` 要求
openai/composite 分组）。**一把密钥只能绑一个分组**，因此「一把密钥通吃」做不到
零配置；两把密钥（组 3 + 组 9）零配置即达全能力覆盖。现有试用体系先例
（vaas-trial/wire-tester）均为「独立邮件账号 + 密码 + $10 量级预充」。

## What Changes

- **建账号**：`ciyuan-trial@findmail.com`（管理员 API 建号：role=user、
  密码随机生成、balance 建号即 $10）；`allowed_groups=[3]`（专属组需授权；
  组 9 为公开组无需授权）。
- **铸密钥**：用户侧铸两把——`trial-chat-lanes`（分组 3：全部 chat 模型 + 三车道）
  与 `trial-image-video`（分组 9：图像 + Seedance 视频）；密钥名带用途，便于伙伴自识。
- **实调验证**：两把密钥各真调一次（chat 一回合 + 车道一次 + 视频任务创建/轮询一次），
  确认可达与计费落账；视频轮询至终态或按上游返回如实登记。
- **文档填表**：`finddata/docs/ciyuan-intro.md` 测试账号表填齐（账号/密码/$10/两把
  密钥及其用途说明），并把「密钥两把」的口径写进文档正文。
- **台账**：`docs/registry-maintenance.md` 词元段登记账号指纹（邮箱与用途；密码
  只入文档与交付物，不回写台账明文）。

## Capabilities

### New Capabilities

- `ciyuan-trial-account`: 词元的伙伴试用账号供给——独立账号、预充额度过硬顶、
  全能力可覆盖（chat/三车道/图像/视频）、凭据可交付给伙伴。

### Modified Capabilities

（无）

## Impact

- 生产数据：词元库新增 1 个用户 + 2 把密钥 + $10 余额（可逆：删号/停密钥即回收）。
- 文档：`finddata/docs/ciyuan-intro.md`（测试账号表）。
- 无代码、无出片、无镜像滚动。
