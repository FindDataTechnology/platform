# fix-digest-adaptive-embed-deadline

## Why

digest 的向量档位用**固定 8000ms 死线**赌每一次 embed，而生产实测 embed 延迟在 5.5–13s 之间抖动（2026-10-29 量得直打网关同样 1.6–10.8s，属上游 Nebius 自身排队，渠道已锁定不可换）。固定死线没有记忆：慢过一次之后下一次仍从头赌 8 秒，而同一批查询一旦算完缓存命中只需 7–92ms。结果是可复现的单点浪费——6 次连发实测 `8063, 7, 7, 77, 9, 92` 毫秒，其中 1 次白白烧掉 8 秒后降级。

更糟的是这个死线与调用方契约冲突：`memory-federation` spec 明文规定「paas 侧超时上限 5s」，而 fd-memory 在等 8s。embed 慢时 digest 永远拿不到结果，还多占 3 秒连接。今天这条被误认为「车道故障」，实际是两边预算没协商。

## What Changes

- **死线按近期延迟自适应**：用已有 embed 采样算 p90，把单次预算 clamp 在 `[3s, 15s]`；快的时候立刻返回，慢的时候不浪费固定 8 秒。保留 `FD_MEMORY_DIGEST_EMBED_DEADLINE_MS` 作为上限覆盖（现网配置继续生效，语义从「固定值」改为「上限」）。
- **修采样盲区**：现有 `embedSamples` 只记录**成功**样本耗时；撞死线的请求把耗时记成死线值而非真实值，导致自适应拿不到「真实有多慢」。改为失败样本也记录实际等待时长与是否超时。
- **协商调用方预算**：把 paas 侧 `server/cluster-memory.js` 的硬编码 5s 改为可配（`CELL_MEMORY_DIGEST_TIMEOUT_MS`，默认提到 9s），使「调用方预算 > fd-memory 死线上限」这条不变量成立。
- **契约对齐**：`memory-federation` spec 的「paas 侧超时上限 5s」改为可配且必须大于 fd-memory 死线；`chat-memory` 同款表述同步。

## Capabilities

### New Capabilities

- `memory-digest-embed-lane`: digest 向量档位的预算与降级纪律——自适应死线、采样口径、与调用方超时的不变量、降级可观测性。

### Modified Capabilities

- `memory-federation`: 「paas 侧超时上限 5s」这条写死的预算改为可配，并新增「调用方超时必须大于 fd-memory embed 死线上限」的不变量。
- `chat-memory`: 同款 5 秒超时表述同步为可配 + 同一不变量（chat 面与集群面共用一套预算纪律）。

## Impact

- **fd-memory**：`src/http.ts`（死线计算、embed 包装）、`src/metrics.ts`（失败样本口径）、`src/embed-gate.ts`（若需暴露近期 p90）。
- **paas**：`server/cluster-memory.js`（超时可配）、`server/cluster-memory.js` 的 chat 面同源阶梯（同一 `digestLadder`）。
- **配置**：新增 `CELL_MEMORY_DIGEST_TIMEOUT_MS`；`FD_MEMORY_DIGEST_EMBED_DEADLINE_MS` 语义由「固定值」改为「上限」（现网值 8000 继续有效，行为不变）。
- **发布**：fd-memory 需出片（`yizuo/fd-memory`，GitOps `all-services/prod/fd-memory.yaml` 主容器 + initContainer 两处）；paas 需出片。
- **不受影响**：协议形状、存储 schema、向量空间、`/digest` 请求/响应字段均不变。
