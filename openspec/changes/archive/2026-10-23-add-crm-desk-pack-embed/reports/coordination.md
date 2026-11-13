# finddata 侧协调记录（task 1.2 · 2026-10-22）

1. **演示账号密码 401 事实（已解）**：`crm-admin@findmail.com` 的 devise 登录报 Invalid login credentials 而 API token 有效——判定为密码与 docs/TEST-ACCOUNTS.md §七 文档值漂移（疑 finddata 侧轮换未回写）。处置：经 cheap-6 kubectl `rails runner` 把密码**重置回 §七 文档值**（User id=1，PASSWORD_RESET_OK），`POST /auth/sign_in` 复验 200（devise 四头齐）。属修复文档漂移，非新轮换。
2. **试点商家 Account 建号配方（确认现成）**：`cw-seed-a-tenant.rb`（幂等 rails runner，User 无 role 属性→AccountUser 建法已在案）或 SuperAdmin `/super_admin` 面板人工建号（crm-board-adoption B6.4 即定为人工试点）。商家 token=该 Account 下用户的 api_access_token，发放给商家粘贴进壹座连接面。无 paas 侧代码需求。

3. **6.3 边缘协调项（边缘子域反代，用户已拍板）**：需要 finddata 侧①DNS 加 `desk-embed.finddatatech.cloud`（指向壹座同一入口/SafeLine 站点）②cheap-1 Caddy/SafeLine 路由该 Host → 壹座网关（gateway 已支持 `DESK_EMBED_HOST` env 识别该 Host 并以签名令牌分流到用户 cell；cell 侧 `/external/desk/*` 反代已实现）。paas 部署 env 两个：`DESK_EMBED_HOST`（如 desk-embed.finddatatech.cloud）与 `DESK_EMBED_URL`（https:// 同值）——未配时入口如实显示「嵌入入口未就绪」，其余功能不受影响。WS（/cable）一期不代理：仪表盘可用、实时更新需刷新（路由注释与 spec 场景已如实注明）。

4. **（更新 2026-10-23）6.3 已由 Platform API SSO 路径交付**（见 acceptance-b.md §6.3）——desk-embed 子域反代**不再是上线阻塞**，保留为「壹座内 iframe 视觉嵌入」的可选升级（需要时再走 DNS/Caddy 协调）。DESK_EMBED_HOST/DESK_EMBED_URL env 同样可选（未配时 go 路由如实显示「嵌入入口未就绪」，SSO 卡片路由不受影响）。
