## MODIFIED Requirements

### Requirement: widget 公共资源与动态 CSP

平台 SHALL 于 gateway 层提供：加载器脚本 `GET /zhiyu/widget.js`（头等幂、可缓存）与 iframe 页 `GET /zhiyu/embed/:token`。iframe 页响应 SHALL 带 `Content-Security-Policy: frame-ancestors <白名单>`（按令牌所属房间更新）；白名单外域上做嵌套的用户代理 SHALL 被浏览器策略拒绝渲染。加载器与 iframe 之间 SHALL 只经 origin 校验过的 `postMessage` 通信。

`frame-ancestors` 的源 SHALL 仅由 **https** 构成：白名单普通条目产出 `https://<host>`，通配条目产出 `https://*.<host>` 与 `https://<host>`；SHALL NOT 为任何白名单条目附发明文 `http://` 源。嵌入壳是访客入口，其父页 SHALL 以 https 加载为前提——http 站点的嵌入 SHALL 被浏览器策略拒绝渲染（与白名单外同待遇）。

#### Scenario: 白名单内嵌入成功加载

- **WHEN** 一名站点访客从白名单 host 打开含 snippet 的页面
- **THEN** 加载器注入 iframe，iframe 以 200 加载房间精简壳

#### Scenario: 白名单外同代码无法装框

- **WHEN** 同一 snippet 出现在白名单外的域上
- **THEN** iframe 响应的 frame-ancestors 不含该域，浏览器侧拒绝渲染（且 API 侧同令牌方可拒绝）

#### Scenario: 白名单内不再附发明文源

- **WHEN** 检查任一 embed 壳响应的 `Content-Security-Policy` 头
- **THEN** `frame-ancestors` 中只有 `'self'` 与 `https://` 形态的源，不含任何 `http://host` 明文源

#### Scenario: http 站点嵌入被拒渲染

- **WHEN** 一名站点访客从 `http://`（非 https）页面打开含 snippet 的页面
- **THEN** 浏览器按 frame-ancestors 策略拒绝渲染该 iframe
