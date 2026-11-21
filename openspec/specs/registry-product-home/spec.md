# registry-product-home Specification

## Purpose
registry 的客户门面：匿名访客在产品域名根路径看到壹座·Packs 的产品介绍与三步使用指引（而非登录墙），并以只暴露公开可用条目的公开摘要端点呈现市场活数据；客户可达面统一壹座·Packs 品牌。

## Requirements

### Requirement: 客户可达面品牌为壹座·Packs

控制台客户可达面（登录页、壳、页头、标签页标题、页面描述）SHALL 以
「壹座·智能体素材广场」/ "Yizuo Agent Materials Plaza" 作为产品品牌串，与
`native-lexicon` v5 词表一致；语言探测与切换的既有行为不变（中文态显示中文串，
英文态显示对应译名）。管理面 SHALL 保持既有语言与品牌设计，不受本变更影响。

上游默认品牌串（含 `AI Gateway & Registry` 及其页面描述）SHALL NOT 出现在任何客户可达面上。

#### Scenario: 客户面标题统一

- **WHEN** 打开控制台任一客户可达面（含登录页）
- **THEN** 页头与标签页标题显示素材广场品牌串（与语言态一致）

#### Scenario: 上游默认串不再出现

- **WHEN** 抓取任一客户可达面的 HTML
- **THEN** 其标题与描述中不含 `AI Gateway & Registry`

#### Scenario: 语言切换行为不变

- **WHEN** 用户在客户可达面切换语言
- **THEN** 品牌串按语言态切换，其余翻译行为与既有 i18n 契约一致

#### Scenario: 管理面不受影响

- **WHEN** 管理员使用管理面功能
- **THEN** 管理面的语言与品牌呈现保持变更前的设计

### Requirement: 匿名根路径重定向到素材广场

对产品域名根路径 `/` 的 `GET`/`HEAD` 请求，registry SHALL 按**registry 会话**分流：
无有效 registry 会话的请求 SHALL 以 302 重定向到素材广场（代码物种预选），携带有效
registry 会话的请求 SHALL 保持既有控制台行为不变。

分流判据 SHALL 是 registry 自己的会话标识，MUST NOT 使用边缘 WAF 的会话 cookie——后者对
每个访客都发，用它判定会让登录用户也被重定向。

重定向 SHALL 只作用于根路径的读请求：MCP 协议端点（`/<server>/mcp`）、控制台深链、静态
资源、`/api/*` 的既有鉴权与转发行为 MUST NOT 改变。

#### Scenario: 匿名访客打开根路径

- **WHEN** 不带 registry 会话的客户端请求 `GET /`
- **THEN** 返回 302，`Location` 指向素材广场并预选代码物种

#### Scenario: 登录用户打开根路径

- **WHEN** 携带有效 registry 会话的客户端请求 `GET /`
- **THEN** 返回控制台单页应用，不重定向

#### Scenario: WAF cookie 不参与判定

- **WHEN** 请求携带边缘 WAF 的会话 cookie 但不含 registry 会话
- **THEN** 仍按匿名处理并被重定向

#### Scenario: 协议端点与 API 不受影响

- **WHEN** 客户端请求 `/<server>/mcp`、`/login` 或任一 `/api/*` 路径
- **THEN** 既有的鉴权、转发与重定向行为与重定向引入前一致
