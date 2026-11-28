## Purpose

壹座内直达客服台：商家/员工在应用中心点击客服台入口，经 Platform API SSO 免密打开 Chatwoot 界面——零密码输入，直达自己租户；未开通者得到如实提示。

## Requirements

### Requirement: 壹座内免密直达客服台（Platform API SSO）

平台 SHALL 提供客服台入口（应用中心卡片 → `/external/crm-desk/sso`）：已连接 chatwoot 凭据的用户点击后，平台以该用户 token 懒映射其 Chatwoot user id（profile 发现+行缓存），再以部署级 Platform App 令牌（带外环境变量，MUST NOT 进日志/响应体/仓库）经 Chatwoot Platform API 换取一次性登录 URL 并 302 直达——用户全程 MUST NOT 被要求输入任何 Chatwoot 凭据，且到达的即其自己的租户界面。未连接凭据的用户 SHALL 得到「尚未开通客服台」页并指向连接面板（MUST NOT 打开半可用嵌入）。Platform App 的 permissibles 名单控制 SSO 准入：名单外用户 SHALL 得到如实的未开通提示。交付记录：此 SSO 路径为主路径（paas-embed-desk-requirements 更新口径）；子域反代+会话注入为实现并保留的可选「视觉嵌入」升级路径（下一条要求的越权防护对它同样适用）。

#### Scenario: 已连接用户一键直达自家租户

- **WHEN** 已连接 chatwoot 凭据的商家点击应用中心客服台入口
- **THEN** 经一次性登录 URL 免密落地其 Chatwoot 租户界面（生产实证：A 租户凭据落 accounts/1、商家凭据落 accounts/7，身份随凭据切换，全程零输入）

#### Scenario: 未连接用户被指引而非报错

- **WHEN** 未连接凭据的用户点击入口
- **THEN** 得到「尚未开通客服台」页并指向连接面板（chatwoot 面板），不打开半可用嵌入

#### Scenario: token-only 用户完整可用

- **WHEN** 用户仅粘贴了 API token（未提供登录邮箱/密码）后点击入口
- **THEN** SSO 直达照常工作（token 即唯一凭据）；连接面板中的登录对字段仅服务可选的反代升级路径，缺失不阻塞 SSO

### Requirement: 嵌入/直达链路的租户越权防护

客服台直达链路 SHALL 仅以该用户自己的凭据与身份工作：SSO 交换 MUST 使用该用户 token 映射的 user id（MUST NOT 复用或缓存跨用户身份）；上游故障 SHALL 如实呈现（未开通/凭据无效/上游不可达均给可读原因），MUST NOT 以他人会话或缓存页冒充；入口 MUST NOT 向未认证调用者暴露。可选的子域反代升级路径（实现保留）SHALL 同样满足：每用户一份上游会话（进程内、不落盘）、互不可见、认证门后。

#### Scenario: 会话按用户隔离

- **WHEN** 两个商家各自点击入口
- **THEN** 各自直达自己租户的界面与会话，无跨用户串话（单测：他人无凭据 401 且零他人会话材料）

#### Scenario: 上游故障如实呈现

- **WHEN** Chatwoot 不可达、permissibles 缺失或凭据无效时用户点击入口
- **THEN** 得到带原因的错误页（上游不可达/尚未开通 SSO/凭据无效），不出现空白页或他人会话

#### Scenario: 入口不暴露给未认证调用者

- **WHEN** 未登录调用者直接访问入口路由
- **THEN** 被平台认证门拦截（401），不出现任何 Chatwoot 内容
