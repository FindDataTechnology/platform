# add-ciyuan-trial-account — 任务清单

> 目标：一个账号（$10 硬顶）+ 两把密钥（组 3 chat/车道、组 9 图像/视频）覆盖全能力；
> 凭据填入介绍文档表格；台账只记指纹。

## 1. 建账号

- [x] 1.1 管理 API `POST /api/v1/admin/users`：`ciyuan-trial@findmail.com`、
      随机密码、`balance=10`、`allowed_groups=[3]`、role=user
- [x] 1.2 回读用户行核验（balance=10、allowed 含 3、status active）
- [x] 1.3 密码直登冒烟（`POST /api/v1/auth/login`）——确认伙伴可登录控制台

## 2. 铸密钥

- [x] 2.1 该账号铸 `trial-chat-lanes`（group_id=3）
- [x] 2.2 则 `trial-image-video`（group_id=9；公开组直接可绑）
- [x] 2.3 回读两 key 行核验（user_id、group_id、active）

## 3. 实调验证（全能力）

- [x] 3.1 chat：组 3 key 调一次 chat completions（最小 prompt）→ 200 + 扣费行
- [x] 3.2 车道：组 3 key 调一次 rerank 或 search → 200 + 扣费行
- [x] 3.3 视频：组 9 key 创建 Seedance 任务（`POST /v1/contents/generations/tasks`）
      → 任务 ID 返回；轮询一次可达；如终态失败如实登记
- [x] 3.4 图像：组 9 key 调一次图像生成（如上游有门槛则登记事实）
- [x] 3.5 余额核验：四笔扣费后余额回读（<10，方向正确）

## 4. 文档与台账

- [x] 4.1 `finddata/docs/ciyuan-intro.md` 测试账号表填齐（账号/密码/预充/$10/
      两把密钥及用途）；正文补「两把密钥=全能力」说明
- [x] 4.2 口径检查：无内部信息泄露（无分组 id、无上游名、无价目数字）
- [x] 4.3 `docs/registry-maintenance.md` 词元段登记指纹（邮箱/用途/额度；
      不回写密码密钥明文）

## 5. 收口

- [x] 5.1 change 归档（openspec archive）
