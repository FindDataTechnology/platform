# dsh-contracts Delta: extend-dsh-contracts-020-capabilities

## ADDED Requirements

### Requirement: 0.2.0 多 agent 能力面合同族（⑩-⑭）

套件 SHALL 新增五条合同（⑩-⑭），钉住平台在 dsh 0.2.0 多 agent 能力面上的行为依赖（萬星多 harness 运行层的地基，见 docs/wanxing-multi-harness-runtime-explore.md），与既有合同同流程：候选模式、独立执行、独立报告、任一 fail 退出码非零。⑩⑪⑫经**进程内探针插件**断言（test-only patch 行注入候选安装的临时 profile，装载机制与 platform-sdk-server 同型——合同⑤已钉住的 disable+insert 语义；探针的 `@deepseek-ai/*` 直引仅限适配层名单内文件）。五条合同：

10. **preset 会话级选择与组合隔离**：profile 声明 ≥2 个 preset 时，两个会话可各选不同 preset 且各自组合生效（系统提示词/工具面按所选 preset 分层，互不渗透）；选择未知 preset 的会话创建在发布前失败并回滚（不留半组合 agent）；
11. **per-agent 工具裁剪作用域**：对某 agent 施加工具裁剪（restrict deny 名单）后，该 agent 的工具面收窄而同进程其他 agent 不受影响；裁剪可重复施加直到钉住（时序容忍）；
12. **subagent one-shot 派发与槽位准入**：one-shot 子代理经委派跑完即收（结果+停止原因+可选结构化输出）；per-child agentOptions 覆写（provider/model）生效；continuable 槽位池超限时新派发以 `ACTIVATION_LIMIT_REACHED` 拒绝（不排队、不静默）；
13. **ACP 会话面**：候选安装以 ACP profile 服务时，会话 create/resume/list/close、模型与 reasoning effort 选择、submit/cancel 可用且跨进程重启后 list/resume 持久化成立；计量面形状（usage/token 事件在 ACP 面的可得性）SHALL 如实记录于合同报告附录——可得性与否均为有效结论，不因缺失而 fail（本条合同只 fail 于会话面行为破坏）；
14. **MCP sidecar 进程级共享**：同一进程内 N（≥2）个 agent 消费同名 MCP server 时，该 server 的 sidecar 子进程数恒为 1（不随 agent 数增长）；sidecar 生命周期随进程（进程退出无孤儿）。

#### Scenario: 合同⑩捕获 preset 组合串扰

- **WHEN** 候选版本使两会话的 preset 组合互相渗透（如 B 会话可见 A 会话所选 preset 的系统提示词段落或工具）
- **THEN** 合同⑩ fail 并指名渗透方向，报告携带两会话的组合事实

#### Scenario: 合同⑩捕获未知 preset 晚失败

- **WHEN** 候选版本使未知 preset 的会话创建在首回合或首落盘才失败（而非发布前回滚）
- **THEN** 合同⑩ fail 并携带晚期失败现场

#### Scenario: 合同⑪捕获裁剪越界

- **WHEN** 候选版本使对 agent A 的工具裁剪作用于同进程的 agent B
- **THEN** 合同⑪ fail 并指名越界方向

#### Scenario: 合同⑫捕获槽位池静默失效

- **WHEN** 候选版本使超限派发排队等待或静默丢弃而非 `ACTIVATION_LIMIT_REACHED` 拒绝
- **THEN** 合同⑫ fail 并指名槽位准入语义

#### Scenario: 合同⑬捕获取消不收敛（ACP 面）

- **WHEN** 候选版本使 ACP 的 cancel 提交后会话不回到可接受新 submit 的状态
- **THEN** 合同⑬ fail 并指名 ACP cancel

#### Scenario: 合同⑬的计量面记录

- **WHEN** 合同⑬执行完毕
- **THEN** 报告附录记录 ACP 面上 usage/token 信息的可得形状（可得/不可得+字段形状），无论哪种都构成合同的通过态输出

#### Scenario: 合同⑭捕获 sidecar 复制

- **WHEN** 候选版本使每个 agent 为同名 MCP server 各起一个 sidecar
- **THEN** 合同⑭ fail 并携带 sidecar 进程清单

#### Scenario: 探针插件不进生产组合

- **WHEN** 检视生产 profile 的物化路径
- **THEN** 探针插件仅存在于合同 runner 物化的临时 profile（用后清理），生产镜像与部署 profile 不含探针行
