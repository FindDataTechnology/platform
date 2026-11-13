# web-search — Delta

## REMOVED Requirements

### Requirement: Search ships enabled in every deployment form with zero customer configuration

**Reason**: 用户决策（2026-10-13）——联网搜索默认关、每会话可开。常开默认被 reshape 为下方新需求；「无需客户侧凭证」的既有一半由 relay 架构继续承载（保留在 scoped-relay-credentials 相关需求中），此处只移除「默认开启」语义。

## ADDED Requirements

### Requirement: Search is off by default and enabled per session

websearch 工具 SHALL 默认不进入会话的有效工具面（部署可经 `PACK_BASELINE_MCP` 显式回到常开，但平台默认配置为关）。用户 SHALL 能经对话输入框的会话级联网开关（见 chat-composer-controls）为当前会话开启/关闭，开启 SHALL 经 `tools/set` 会话级工具闸免重启生效，SHALL 只影响该会话。运营商经扩展面整体停用 websearch 服务器的既有能力不变。

#### Scenario: 新会话默认无搜索工具

- **WHEN** 用户开启新会话且未翻转联网开关
- **THEN** 该会话的有效工具面 SHALL 不含 websearch 工具

#### Scenario: 会话内翻开开关后可搜索

- **WHEN** 用户翻开联网开关并发起会触发搜索的提问
- **THEN** 该会话 SHALL 可调用 websearch 工具
- **AND** 其他未开启会话 SHALL 不受影响

#### Scenario: 运营商整体停用仍优先

- **WHEN** 管理员经扩展面停用 websearch 服务器
- **THEN** 会话级开关 SHALL 不恢复其工具（会话闸只做收紧-放开，不越权启停服务器）
