# 嵌入活体探测（task 1.1 · 2026-10-22）

- 环境：desk.finddatatech.cloud（Chatwoot v4.19.0），crm-admin 真实浏览器登录（ZCode 内嵌浏览器）。
- 登录路径：`/app/login`（`/u/login` 是 404）；表单邮箱+密码 → `POST /auth/sign_in`（devise token auth）。

## 会话存储形态（登录后实测）

| 存储 | 键 | 内容 |
| --- | --- | --- |
| cookie（JS 可读） | `cw_d_session_info` | URL 编码的 JSON——devise 响应头全集（`access-token`/`client`/`uid`/`expiry`/`token-type: Bearer` 等），SPA 登录后由前端写入（AuthHelper.createAuthCookie） |
| cookie（JS 可读） | `user.id` / `user.expires_at` | Rails session（base64 signed 值），sign_in 时上游 Set-Cookie |
| localStorage | `chatwoot_available_agents_<widget_token>` 等 | 仅挂件缓存，与鉴权无关 |
| sessionStorage | 空 | — |

- SPA 启动时读 `cw_d_session_info` 恢复会话；API 调用从该会话取 devise 头。
- 上游响应头含 `x-frame-options: SAMEORIGIN` → **同源 iframe（反代同域）天然合规**。
- devise 令牌有 `expiry`（实测 ~14 天），过期后 SPA 401。

## 注入法定案（design D6③ 首选）

反代实现：
1. 服务端以用户连接面凭据 `POST {CHATWOOT_BASE_URL}/auth/sign_in` → 取响应头四件套（curl 实测 200：Access-Token/Client/Expiry/Uid）。
2. 构造 `cw_d_session_info` cookie（与 AuthHelper 同形：encodeURIComponent(头 JSON)）+ 透传上游 `user.id`/`user.expires_at` Set-Cookie，域=反代自身。
3. 后续 `/api/v1|/auth|/profile` 请求按用户会话映射注入 `access-token/client/uid/expiry/token-type: Bearer` 头；页面与静态资源直通。
4. 会话过期/401 → 有密码凭据者透明重登，否则可读错误页。
5. 每用户一份上游会话（进程内 map，email 键），不落盘、不跨用户。
