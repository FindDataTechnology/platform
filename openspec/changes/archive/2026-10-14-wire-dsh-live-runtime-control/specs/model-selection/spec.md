# model-selection — Delta

## MODIFIED Requirements

### Requirement: User can switch the active model at runtime

The server SHALL accept a `set_model` WebSocket message OR a `/model <id>` chat command and switch the runtime's active model, validating that the requested model is available and has configured auth. 当桥声明 `model/set` 能力时，切换 SHALL 经该 RPC 免重启完成（dsh 原生 step 边界语义保证流中安全）；未声明时 SHALL 保留既有 restart 路径。A `/model` command with no argument SHALL report the currently active model AND list all available selectable models. The switched model SHALL apply to the next agent turn (idle) or the next step (mid-run, 由 dsh 快照语义保证当前请求不撕裂). Saving a personal model binding is a separate authenticated REST operation and SHALL NOT be implied by an explicit `set_model` or `/model` command. 切换 SHALL NOT 再产生 pendingConfig 禁发窗口（免重启路径下发送保持可用）。

#### Scenario: user selects a valid model via the selector
- **WHEN** a client sends `{ "type": "set_model", "id": "deepseek-v4-flash" }` for a model in the available list
- **THEN** the server SHALL switch the active model without a runtime restart (when the bridge declares `model/set`)
- **AND** SHALL broadcast `model_changed` with the new id

#### Scenario: user switches model via the /model command
- **WHEN** a client sends `{ "type": "prompt", "text": "/model deepseek-v4-pro" }` for a model in the available list
- **THEN** the server SHALL switch the runtime's active model and broadcast `model_changed` with the new id
- **AND** SHALL broadcast a `command_use` event for the `model` command

#### Scenario: /model with no argument reports current model and lists available models
- **WHEN** a client sends `{ "type": "prompt", "text": "/model" }`
- **THEN** the server SHALL broadcast a `command_use` event reporting the currently active model
- **AND** SHALL include a list of all available selectable models in the message
- **AND** SHALL NOT switch the model

#### Scenario: user selects an unknown model
- **WHEN** a client sends `set_model` or `/model nonexistent` for a model not in the available list
- **THEN** the server SHALL send an `error` message and the active model SHALL remain unchanged

#### Scenario: personal model save is separate from model selection
- **WHEN** an authenticated user sends `set_model` without calling the personal binding endpoint
- **THEN** the runtime model changes as an explicit global selection
- **AND** no personal model binding is created or updated

#### Scenario: switch mid-run takes effect at the next step
- **WHEN** a client sends `set_model` while the target session's turn is streaming, and the bridge declares `model/set`
- **THEN** the server SHALL accept the switch without rejecting it
- **AND** the in-flight model request SHALL complete on the old model
- **AND** subsequent steps of the same turn SHALL use the new model

### Requirement: Model selector is enabled as soon as models are known

The chat UI SHALL enable the model selector as soon as the available models are received, not only after the first agent turn completes. 桥声明 `model/set` 能力时，选择器 SHALL 在流中保持可用（切换经 RPC 免重启生效）；未声明时 SHALL 保留既有「流中禁用」行为。The selector SHALL reflect the currently active model. The UI SHALL provide a command list popup showing available models as clickable items that trigger model selection. The click handler SHALL safely check for null DOM references before accessing properties.

#### Scenario: selector enabled on connect
- **WHEN** the page loads and the server sends the model list
- **THEN** the model selector SHALL be enabled
- **AND** SHALL reflect the currently active model

#### Scenario: selector re-enabled after a failed turn
- **WHEN** an agent turn ends with an error
- **THEN** the model selector SHALL be re-enabled

#### Scenario: model selection from command list
- **WHEN** the user opens the command list and clicks on a model name
- **THEN** the UI SHALL send a `set_model` message with the clicked model id
- **AND** SHALL reflect the new active model in the selector

#### Scenario: selector stays usable while streaming (live capability)
- **WHEN** the bridge declares `model/set` and the agent is streaming
- **THEN** the model selector SHALL remain enabled
- **AND** a selection SHALL take effect without a runtime restart

## REMOVED Requirements

### Requirement: Model switching is disabled while the agent is streaming

**Reason**: 活切经 dsh 原生 step 快照语义安全；流中禁切的用户困境（截图实证）随免重启切换消失。降级路径（桥未声明能力）下由「Model selector is enabled as soon as models are known」中的既有行为条款承载。

## ADDED Requirements

### Requirement: Model switching degrades safely without live capability

桥未声明 `model/set` 能力时，服务端 SHALL 保留既有行为：流中 `set_model` 被拒绝并回错误、空闲切换经 restart 完成。降级 SHALL 对客户端透明（无未处理错误），且能力声明变化（子进程升级滚动）后 SHALL 自动切换到活切路径。

#### Scenario: 降级下的流中切换被拒

- **WHEN** 桥能力声明不含 `model/set` 且流中收到 `set_model`
- **THEN** 服务端 SHALL 回错误且模型不变（既有行为）

#### Scenario: 能力上线后自动走活切

- **WHEN** 子进程滚动升级后能力声明包含 `model/set`
- **THEN** 后续 `set_model` SHALL 走免重启路径
