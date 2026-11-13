## Context

- 词元分组拓扑（explore 取证）：能力按分组分家——组 3（openrouter，**专属**，
  `is_exclusive=t`，需 `user_allowed_groups` 授权）载全部 chat 计价与车道计价
  （rerank/搜索按次价）；组 9（image，公开组）载图像开关与 seedance 账号
  （账号 40 仅绑此组）；`/contents/generations/tasks` 与 `/images/*` 要求
  openai/composite 分组。登录支持密码直登（auth_identities email）与 OIDC。
- 管理面：`POST /api/v1/admin/users`（建号，含 balance/allowed_groups）、
  `POST /api/v1/admin/users/:id/balance`（balance 硬顶调整，set/add/subtract）；
  用户侧 `POST /api/v1/keys` 铸密钥（group_id 取自可用分组集）。
- 先例：vaas-trial@findmail.com（email 身份 + 密码 + $10 量级）。

## Goals / Non-Goals

**Goals**
- 一个账号、两把密钥覆盖全部四类能力；$10 预充；密码直登立即可用。
- 凭据交付面收敛到介绍文档一处；台账只记指纹。

**Non-Goals**
- 不做「单密钥通吃」（需新建合成分组复制价目/开关——配置面大，且与既有
  分组语义的运营习惯相悖；收益仅为少一把密钥）。
- 不一并为试用账号挂 Logto OIDC 身份（首登用邮箱密码；OIDC 绑定是运营可选
  锦上添花，伙伴若有寻数账号可另行按邮箱绑定，不影响交付）。
- 不改任何分组/价目/开关（组 3 的价目与组 9 的 seedance 账号保持现状）。

## Decisions

**D1：账号形态=独立邮件账号（`ciyuan-trial@findmail.com`），不走 OIDC-only。**
邮件+密码在词元侧自足（auth_identities email 行+Llogin 接口），伙伴不需要寻数
账号即可登录；与 vaas/wire 试用体系同形。备选用伙伴自有邮箱到货再建——但交付
时点不可控，先建标准账号，伙伴有寻数账号亦可后续绑定。

**D2：两把密钥而非单把。** 组 3 专属（需授权）、组 9 公开（直接可绑），两把
零配置即可全能力；密钥名 `trial-chat-lanes` / `trial-image-video` 自带用途标注。
备选单密钥=新建专用合成组并复制 chat 全部模型路由+图像开关+seedance 调度——
动生产分组面且长期维护成本高，不做。

**D3：$10 用 balance 建号自带。** `CreateUserRequest.balance` 一步到位（避免
建号后二次调整的审计噪音）；额度即财务硬顶，耗尽拒绝语义与既有用户一致。

**D4：验证用真调用。** chat 一回合（最小 prompt）+ rerank 一次 + 视频任务创建
与轮询（上游如返回排队/失败如实登记，不强求终态成功——接受的是「可达+计费
落账」而非「内容产出」）；图像调用一次（如上游对试用账号有门槛则如实登记）。

## Risks / Trade-offs

- [密钥泄露面] → 试用账号独立余额（$10 硬顶），最大损失有界；密钥可随时停用；
  文档写明一人一号勿转发。
- [视频调用耗时长] → 视频验证以「任务创建成功 + 轮询可达」为门，终态可等待
  或按上游如实登记；不在验收里空等。
- [并发会话] → 建号写的是生产库新行，不与任何在途滚产冲突；文档改动只
  `git add` 本 change 文件。

## Migration Plan

1. 管理 API 建号（$10、allowed_groups=[3]）→ 回读用户行核验。
2. 用该账号登录一次（密码直登）→ 铸两把密钥（组 3 / 组 9）。
3. 真调验证四类能力 → 记录状态码与扣费行。
4. 文档填表 + 台账指纹登记。
5. 回滚 = 停用密钥/删号（余额与数据留痕在库，可审计）。
