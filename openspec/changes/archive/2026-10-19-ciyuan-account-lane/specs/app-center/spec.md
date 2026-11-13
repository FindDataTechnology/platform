# app-center Delta

## MODIFIED Requirements

### Requirement: 连接徽章与去连接

每张卡 SHALL 声明零个或多个「所需连接」id，映射单源维护，且每个 id MUST 是 `GET /api/connections` 已知的连接 id。映射为：壹座·Packs（`yizuo-packs`）→ `registry`；谦面（`facet`）→ `facet-market`；萬星·词元（`wanxing-token`）→ `ciyuan-account`（词元账号，取代已退役的 `line-wanxing-caller`）；萬星·连接器（`wanxing-connector`）→ `connector`；识律（`lex`）→ `line-lex`；柏讯（`wire`）→ `line-wire-customer`、`paper-trading`；壹座（`yizuo`）与萬星（`wanxing`）无所需连接。

页面加载时 SHALL 读取一次 `GET /api/connections`，为每张有所需连接的卡渲染连接徽章（testid `app-card-{id}-connection-badge`，`data-state` 为聚合态），聚合规则：所需连接全部 `connected` → `connected`（已连接）；任一 `stale` → `stale`（需重连）；部分 `connected` 且无 `stale` → `partial`（部分连接）；其余 → `disconnected`（未连接）。无所需连接的卡 SHALL 不渲染连接徽章。

聚合态非 `connected` 时，卡片 SHALL 提供「去连接」动作（testid `app-card-{id}-connect`），导航至 `/settings/connections?panel=<首个非 connected 的所需连接 id>`；聚合态为 `connected` 时不渲染该动作。

`GET /api/connections` 失败（非 2xx、401、网络错误）时，SHALL 不渲染任何连接徽章与「去连接」，其余卡面与动作照常。徽章与动作 SHALL 不显示任何凭据材料（端点本身即只读状态投影）。

#### Scenario: 全部未连接

- **WHEN** 用户在无任何连接的全新环境打开 `/apps`
- **THEN** `yizuo-packs`、`facet`、`wanxing-token`、`wanxing-connector`、`lex`、`wire` 六张卡渲染 `data-state="disconnected"` 的连接徽章与「去连接」；`yizuo`、`wanxing` 两张卡不渲染连接徽章也不渲染「去连接」

#### Scenario: 去连接直达对应连接卡

- **WHEN** 用户点击 `wanxing-token` 卡的「去连接」
- **THEN** 路由到 `/settings/connections?panel=ciyuan-account`，连接分节中萬星·词元（词元账号）卡处于高亮

#### Scenario: 词元账号绑定后卡片翻绿

- **WHEN** `/api/connections` 报告 `ciyuan-account` 为 `connected`
- **THEN** `wanxing-token` 卡连接徽章为 `data-state="connected"`，不渲染 `app-card-wanxing-token-connect`

#### Scenario: 部分连接

- **WHEN** `/api/connections` 报告 `line-wire-customer` 为 `connected`、`paper-trading` 为 `disconnected`
- **THEN** `wire` 卡连接徽章为 `data-state="partial"`，「去连接」指向 `/settings/connections?panel=paper-trading`

#### Scenario: 需重连

- **WHEN** `/api/connections` 报告 `connector` 为 `stale`
- **THEN** `wanxing-connector` 卡连接徽章为 `data-state="stale"`，「去连接」指向 `/settings/connections?panel=connector`

#### Scenario: 已连接不出去连接

- **WHEN** `/api/connections` 报告 `facet-market` 为 `connected`
- **THEN** `facet` 卡连接徽章为 `data-state="connected"`，不渲染 `app-card-facet-connect`

#### Scenario: 状态端点失败时徽章整体缺席

- **WHEN** `GET /api/connections` 返回 500 或 401
- **THEN** 页面不渲染任何 `app-card-*-connection-badge` 与 `app-card-*-connect`，8 张卡的名称、职责、「打开」照常可用
