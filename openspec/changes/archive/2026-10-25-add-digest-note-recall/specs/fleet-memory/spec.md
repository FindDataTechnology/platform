# fleet-memory Specification Delta

## MODIFIED Requirements

### Requirement: 平台缝 digest 读面——服务端单源渲染

fd-memory SHALL 在平台缝暴露 digest 读面 `GET /digest?project=<name>&k=&budget=`：以请求令牌自身 root 内该 project 为范围，经与蒸馏候选检索同一条代码路径（向量优先、关键词兜底）按 query 文本（请求参数 `q`）召回 top-k 条 L2 页，并追加该 project 的近期 note 页为 L1 条目（按更新时间新近排序、至多 3 条），交 digest 渲染器（预算硬顶、每条 layer/confidence/日期标注、open handoffs 通知段、forget 与 expired 条目排除）产出注入块，返回 `{digest: string, items: number, notes: number, truncated: boolean, model_note?: string}`。渲染优先级 SHALL 为：open handoffs 通知段最先保留，其后 L2 条目（召回秩），最后 L1 近期 notes——预算不足时按此逆序截断。

鉴权与寻址 SHALL 与 `/pages` 面同纪律：person 令牌读自己 root 下 project；platform / runner 族令牌 MUST 以显式 `rootKey` 参数指定目标 root（不带 rootKey 的非 person 调用结构化拒绝）；线协议 MUST NOT 出现 namespace/root 名于 person 路径（project 在请求者自身 root 内解析）；agent 族令牌（deployment / pod）MUST 结构化拒绝。embed 车道不可用或超时 SHALL 降级为关键词召回并在响应 `model_note` 注明，MUST NOT 失败整个请求。k 与 budget 参数 SHALL 有服务端上限（k ≤ 8、budget ≤ 2000），越界取上限。

#### Scenario: person 令牌取自家集群 digest

- **WHEN** cell 以 owner 的 person 令牌调 `/digest?project=<clusterId>&q=<回合任务文本>` 且该 project 有 L2 页与 open 交接
- **THEN** 返回渲染块含相关 L2 条目（带标注）与待认领交接段，items/notes/truncated 如实

#### Scenario: agent 令牌被拒

- **WHEN** 一枚 deployment 令牌调用 /digest（带或不带 rootKey）
- **THEN** 结构化拒绝，无内容返回

#### Scenario: embed 降级不失败

- **WHEN** sidecar embed 查询超时或失败时 person 令牌调用 /digest
- **THEN** 请求成功，返回关键词召回渲染的块，model_note 注明向量缺席

#### Scenario: 参数上限钳制

- **WHEN** 调用方传 k=50 与 budget=99999
- **THEN** 服务按 k=8、budget=2000 渲染，不报错

#### Scenario: 近期 note 进块且带 L1 标注

- **WHEN** 该 project 无 L2 页但存在近期 note（如集群回合写回的 digest 页）时调用 /digest
- **THEN** 渲染块的相关记忆段含这些 note 条目，每条标注 L1 层（〔L1·note〕）与日期，notes 计数如实

#### Scenario: 预算挤迫先截 notes

- **WHEN** L2 条目与 notes 总量超出预算
- **THEN** 截断顺序为 notes 先于 L2 条目、L2 先于 handoffs 通知段，truncated 如实为 true

#### Scenario: 被忘 note 不进块

- **WHEN** 一枚已被 forget 的 note 页存在于该 project
- **THEN** 该页不出现在渲染块中（忘页已在派生索引剔除，组装侧不复活）
