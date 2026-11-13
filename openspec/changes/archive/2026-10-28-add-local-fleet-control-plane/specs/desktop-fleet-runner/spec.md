# desktop-fleet-runner Specification Delta

## ADDED Requirements

### Requirement: 本地 roster 源零配置默认

插件启用（`WANXING_PLUGIN_ENABLED=1`）且 settings 未配置
`AGENT_SERVING_REGISTRY_URL` 时，supervisor descriptor SHALL 把 runner 的
registry 指针注入为 cell 本机 feed 地址（`http://127.0.0.1:<cell port>`，
`local-agent-registry-feed` spec），并注入 first-run mint 的本机 Bearer 令牌。
stock 桌面「开插件即有编目」——不再出现 runner 健康而编目恒空的零目录席位。
外部 registry 配置存在时 SHALL 保持外部指针与本机 seat id 分片纪律，行为与
既有版本逐字节一致。机位身份（`机位身份独占`）与调度隐形
（`桌面机位对云端调度隐形`）要求不受影响。

#### Scenario: stock 桌面开插件即有本地编目

- **WHEN** 一台未配置外部 registry 的桌面首次启用插件并重启
- **THEN** runner 指向本机 feed、以本机令牌拉取编目，`/health` 健康且 agents 来自本机部署

#### Scenario: 外部 registry 配置仍胜出

- **WHEN** settings 已配置 `AGENT_SERVING_REGISTRY_URL`
- **THEN** descriptor 注入保持外部地址，本机 feed 令牌不参与 runner 环境

#### Scenario: 令牌缺失时 runner 如实降级

- **WHEN** 本机 feed 令牌因 settings 受损而不可用
- **THEN** runner 拉取收到 401、以既有「未配置/不可用」语义降级，不崩溃、不阻塞 server-js
