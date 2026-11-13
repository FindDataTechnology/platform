# add-caller-preferences — Design

## Context

门面现状：`a2a.js` 的 `contextIdFor` 派生 `wx:<hash|rand>` 外部 context（调用者自带 id 原样过）；`core.js` 的 `idempotentSend` 是被叫回合的完成点（settle 同点）；`store.js` 已有调用者维度的表（allowlist/caller_state）。runner 现状：`reapExternalContexts` 扫 homeRoot 的 `srv-wx-*` 会话目录、全局 `externalContextTtlSecs` TTL、mtime 判空闲。CLI 现状：facet.js 自足单文件、子命令式。约束：门面不通 runner（既有拓扑不变）；ADR-0014 计费语义不动。

## Goals / Non-Goals

**Goals:**
- 调用键认证的偏好读写（CLI + 门面 API 同一实现）
- 回调签名送达（HMAC 全体、指数退避、有界窗、trace_id 幂等锚）
- 收割窗传导零新通道（编码进派生 context 标识，runner 侧解析）

**Non-Goals:**
- Web 调用者门户（CLI 先行，门户后置）
- 回调的 exactly-once / 死信队列（事件量级不支撑；尽力语义+幂等锚）
- 模型车道/呈现偏好（探索定案不做）

## Decisions

**D1 — 偏好表与门。** `wanxing_caller_prefs`（user_id, agent_slug, callback_url, callback_secret, reap_minutes, updated_at；PK=（user_id, agent_slug)）。读写走门面既有 `sub2api.probeKeyLiveness` 认证（与 A2A 同门）→ 解析 userId → 受理。密钥入库明文（平台侧存储，外发永不出现——与 deployment_keys 同纪律）。

**D2 — 回调派发挂在 settle 同点。** `core.js` 回合完成（settle 成功或失败）后 fire-and-forget 派发：`POST callback_url`，体 `{agent, caller_id(masked), trace_id, outcome, started_at, ended_at, minutes_billed}`，头 `X-Facet-Signature: t=<unix>,v1=<hmac-sha256(t.body, secret)>`（时间戳防重放）。退避序列（1m/4m/10m 内三次重试，总窗 ≤15m），窗尽记录一条 `callback_failed` 行（jsonl，含 url 脱敏与原因，无密钥）。派发器独立于请求路径——回调慢/挂不影响回合响应。

**D3 — 收割窗编码。** `contextIdFor` 升级：设了收割窗偏好的（调用者,agent）派生 id 编为 `wx:<minutes>x-<hash|rand>`（`x` 后缀把窗段与十六进制哈希首段彻底区分——哈希字符集不含 `x`）；**未设偏好不编码**（保持既有 `wx:<hash>` 形态，runner 天然回落平台默认——门面因此无需知晓平台默认值，默认仍归 runner 的 env）。共享解析：`parseReapWindow(contextIdOrSessionName)` 返回分钟数或 null（`\d{1,6}x` 前段才作数，其余一律 null）；门面 `a2a.js` 导出，runner 最小拷贝锁步（slugFor 纪律）。**编码只用于门面派生的 id**；调用者自带 context_id 原样过（默认 TTL）。向后兼容：旧 `wx:` 无窗段 → 默认。

**D4 — CLI 形状。** `facet prefs <agent-slug> [--key sk-…] [--set-callback URL SECRET | --set-reap MINUTES | --clear callback|reap | --show]`；`--key` 缺省读 `FACET_KEY` 环境变量。命令直连门面 `PUT /api/wanxing/v1/prefs/<slug>`（调用键 Bearer）。子命令实现入 facet.js 既有结构（USAGE 同步）；npm 发布走既有 facet-cli-publish 流。

**D5 — runner 侧最小面。** reap 扫描改用解析函数取每会话 TTL（其余逻辑原样）；解析函数带 runner 单测（合法/非法/旧格式回落）。**runner 不感知偏好存储**——编码即接口。

## Risks / Trade-offs

- [context_id 命名变化影响现有工具] → 编码段仅门面新派生 id 才有；旧 id（无窗段）显式回落默认；runner 侧兼容解析先行上线（先 runner 后门面，部署序锁死）。
- [回调重试占用门面进程] → 派发器 fire-and-forget + unref 定时器（scheduleDeployReassurance 纪律）；窗 15m、次数 3，无并发派发器池。
- [密钥明文入库] → 与 deployment_keys 同级存储面；不进日志/回调/错误路径；泄漏面=门面数据根（与 sub2api 账户映射同级）。
- [（调用者,agent）粒度组合爆炸] → 表有行即有偏好；无行=全默认，读路径零成本。

## Migration Plan

部署序：①runner（解析函数，向后兼容先行）→ ②门面（prefs 端点 + 派生编码 + 回调派发）→ ③CLI（npm 发版）。回滚各层独立；门面回滚后旧派生 id 停止产生，runner 对存量编码 id 继续按其 TTL 收割（无孤儿）。

## Open Questions

（无——探索阶段 11 问已全部定案，本设计无需要用户再拍板的开放点。）
