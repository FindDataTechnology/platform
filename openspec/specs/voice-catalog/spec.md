# voice-catalog Specification

## Purpose
音色目录是一份受控的、可覆盖的合成音色清单：它把「用哪个声音」从一个自由文本框变成一次有据可查的选择，好让填错的值当场被拒，而不是被上游静默换成默认音后仍报成功。

## Requirements

### Requirement: 音色目录是一份受控的成对清单

系统 SHALL 持有一份音色目录，条目以 `{protocol, model, voice}` 成对声明，`protocol` 取值封闭（`tencent` 的整数 VoiceType、`doubao` 的字符串音色，二者协议不同）。目录 SHALL 随产物发布，并 SHALL 允许部署以整目录挂载的方式覆盖，覆盖 SHALL 在下次读取时生效而不需要重新构建或重启。目录中 SHALL 允许未知条目被拒收而不是被静默忽略：形状不合法或 `protocol` 不在封闭集合内的条目 SHALL 使该目录读取失败，并以可读原因报告，MUST NOT 让一个坏条目把整份目录变成空。

#### Scenario: 成对条目按协议分组

- **WHEN** 读取一份含 tencent 与 doubao 两类条目的目录
- **THEN** 两类条目都可用，且每个条目同时携带 model 与 voice，二者不可单独取用

#### Scenario: 部署覆盖生效

- **WHEN** 部署在挂载点放入一份覆盖目录并随后发起合成
- **THEN** 新条目在下一次读取时即可被选中，无需重启进程

#### Scenario: 坏条目如实失败

- **WHEN** 目录中某条目缺少 voice，或 protocol 不在封闭集合内
- **THEN** 读取以可读原因失败并指出是哪一条，而不是静默丢弃该条后继续

### Requirement: 引用目录之外的音色一律拒绝

任何写入音色选择的面 SHALL 以目录准入：取值不是目录中某个条目的 `{model, voice}` 配对时 SHALL 被拒绝并给出可读原因，MUST NOT 转发给上游再由上游回落。拒绝 SHALL 发生在写入时，而不是首次使用时的合成失败。

#### Scenario: 目录内取值被接受

- **WHEN** 写入一条恰好等于某目录条目的 `{model, voice}` 配对
- **THEN** 该值被接受，读面原样返回该配对

#### Scenario: 目录外取值被拒

- **WHEN** 写入一个不在目录中的 voice（或 model 与 voice 不属于同一 protocol）
- **THEN** 写入被拒绝并说明可选范围，既有值保持不变

### Requirement: 每个条目可试听以证明其真实生效

系统 SHALL 允许对目录中任一条目发起一次试听：以固定样例文本、该条目的 model 与 voice 合成并返回音频。试听 SHALL 使用与正式合成相同的凭据与转发路径，使其能如实暴露「该音色在上游已不可用」这类失败。

#### Scenario: 试听返回音频

- **WHEN** 对一个目录条目发起试听
- **THEN** 返回该条目合成的音频，且请求携带该条目的 model 与 voice

#### Scenario: 上游拒绝时如实失败

- **WHEN** 试听的音色在上游不存在或已被下线
- **THEN** 试听返回结构化的失败，MUST NOT 返回一个成功响应却不作说明
