## ADDED Requirements

### Requirement: 谦面提供团队控制台分享页

谦面 SHALL 提供团队控制台分享页 `/t/:slug`，按 slug 解析到一支已公开该控制台的团队，并 SHALL 经平台的单一公开读数端点（`surface=share`）取数。谦面 SHALL NOT 复制团队数据、SHALL NOT 直连团队的库、SHALL NOT 对该页提供任何写路径（启动/暂停/派发/拍板应答一律不在分享面出现）。

团队控制台 SHALL 是**可选面**：平台的读数端点不可达时，该页 SHALL 呈现"控制台暂不可用"的诚实降级，并 SHALL NOT 影响谦面的市场面——包浏览、详情、技能下载与直接 OIDC 登录在千座全停时 SHALL 仍按 `facet-platform` 既有独立性要求工作。

slug 未公开、团队不存在或团队已归档时，该页 SHALL 返回 404 语义的"未公开"页面，且 SHALL NOT 泄露团队存在性以外的任何信息。

#### Scenario: 分享页只读

- **WHEN** 访客打开 `/t/<slug>` 并完成取数
- **THEN** 页面呈现 `surface=share` 的块，且页面内不存在任何启动、暂停、派发或拍板应答的入口与请求

#### Scenario: 千座停机时市场面不受影响

- **WHEN** 千座全部进程停止，访客先打开 `/t/<slug>` 再打开市场页
- **THEN** 分享页呈现"控制台暂不可用"，市场页的浏览、详情与技能下载照常工作

#### Scenario: 未公开的团队不泄露

- **WHEN** 访客请求一个未公开控制台或已归档团队的 slug
- **THEN** 返回"未公开"页面，响应内不含团队名、成员或任何块数据
