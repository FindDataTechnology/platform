# archive-sidecar Specification

## Purpose
把会话存档摄取通道装进客户自己的环境：席位客户买、私钥客户持、数据一条不出边界；用一份可校验的激活清单
和一条就绪自检，替代"实施靠口口相传"。

## Requirements

### Requirement: sidecar 在客户环境内自闭环

交付物 SHALL 在客户自己的环境内完成拉取、解密、归一化与查询，MUST NOT 要求数据离开客户边界，
MUST NOT 要求我方云端参与运行。运行期 MUST NOT 依赖公网回调地址。

#### Scenario: 断网环境下仍可查询已有数据

- **WHEN** 客户网络断开出网访问
- **THEN** 已入库数据的查询面 SHALL 正常工作，拉取器 SHALL 记录拉取失败并持续重试

#### Scenario: 我方云端不可用不影响拉取

- **WHEN** 我方任何服务的可用性下降
- **THEN** sidecar 的拉取与入库 MUST NOT 受影响

### Requirement: 激活清单逐项可校验，未齐不得静默运行

系统 SHALL 提供五项激活项并逐项校验：① 管理后台已开通会话内容存档；② 已上传 RSA 公钥且本地持有私钥；
③ 已生成会话存档专用 secret（与普通应用 secret 不同）；④ 已配置可信 IP 且与 sidecar 实际出口一致；
⑤ 已圈定生效席位范围。任一未满足时，通道 SHALL 报告"未就绪"并指缺哪一项，MUST NOT 以空结果冒充
"没有新消息"。

#### Scenario: 缺私钥时指名报错

- **WHEN** 本地未提供 RSA 私钥
- **THEN** 自检输出 SHALL 指向"缺私钥"这一项，而不是"拉取失败"或"无数据"

#### Scenario: secret 用错类型时能识别

- **WHEN** 配置的是普通应用 secret 而非会话存档 secret
- **THEN** 系统 SHALL 报"凭据类型不匹配"，并提示会话存档 secret 的获取位置

### Requirement: 就绪自检是一条命令，输出能判读的实数

系统 SHALL 提供 `archive doctor`：输出五项清单状态、当前出口 IP、席位生效数、上次成功拉取时间、
当前滞后小时数、以及"能否拉取"的单一结论。所有字段 SHALL 来自真实探测，MUST NOT 用配置值回填。

#### Scenario: 出口 IP 与实际不符时能被发现

- **WHEN** 配置声明的出口 IP 与探测到的实际出口不一致
- **THEN** 自检 SHALL 并列显示两者并标记不一致

#### Scenario: 滞后超阈值时结论为不可拉齐

- **WHEN** 当前滞后超过 5 天
- **THEN** 自检结论 SHALL 明确写"历史已不可补偿"，而不是"就绪"

### Requirement: 打包边界——SDK 与私钥不入产物

镜像/交付包 MUST NOT 包含 `libWeWorkFinanceSdk_C` 二进制，MUST NOT 包含任何私钥。
交付清单 SHALL 给出 SDK 的官方获取指引与校验值位，部署方自行下载放入指定挂载点。
任何把官方 SDK 打包进分发包的第三方封装 MUST NOT 作为依赖。

#### Scenario: 产物里搜不到 SDK

- **WHEN** 对交付镜像执行 `find / -name 'libWeWorkFinanceSdk*'`
- **THEN** 结果 SHALL 为空

#### Scenario: SDK 文件哈希不符即拒绝启动

- **WHEN** 部署方配置了期望的 SDK 文件哈希，而挂载进来的文件与之不符
- **THEN** 就绪判定 SHALL 以 `sdk_sha256_mismatch` 阻塞并拒绝启动拉取循环
- **AND** 报告 SHALL 同时给出期望值与实测值

#### Scenario: 未固定哈希可运行但必须自曝

- **WHEN** 未配置期望哈希
- **THEN** 通道 SHALL 允许运行，但就绪报告 SHALL 明确标记为「未固定」
- **AND** SHALL 给出实测哈希供部署方回填

#### Scenario: 文件缺失与读不了分开

- **WHEN** SDK 文件不存在
- **THEN** 判定为「未配置」，不当作故障
- **WHEN** 文件存在但无法读取
- **THEN** 判定为独立的「不可读」状态，并带出原始错误

#### Scenario: 私钥只以挂载方式提供

- **WHEN** 容器启动且未挂载私钥
- **THEN** 通道 SHALL 以"未配置"退出拉取循环并持续报告，MUST NOT 以内置密钥兜底

#### Scenario: 源仓库审计必须能变红

- **WHEN** 仓库内出现以 `libWeWorkFinanceSdk` 命名的动态库，或含 `PRIVATE KEY` 的密钥文件
- **THEN** 审计 SHALL 报告违规并以非 0 退出
- **AND** 移除该文件后 SHALL 恢复通过（证明判定读到了真实内容，而不是恒真）

#### Scenario: 依赖树不得引入打包型封装

- **WHEN** 依赖清单中出现把官方 SDK 打进包内的封装
- **THEN** 审计 SHALL 报告 `bundled-sdk-dependency` 违规

#### Scenario: 非交付目录不参与源审计

- **WHEN** 审计扫描源仓库
- **THEN** `node_modules`、`data`、`build`、`dist` 等目录 SHALL 被跳过
- **AND** 该跳过行为 SHALL 由断言固定，避免把运行时挂载点误判成违规

### Requirement: 交付验收以客户真实数据为准

验收 SHALL 以客户环境内实际拉取到的数据产出四项实数：生效席位数、有消息会话数、同意会话占比、
滞后曲线。接口连通性或 200 响应 MUST NOT 作为验收通过的依据；空库与全零 SHALL 判为未通过。

#### Scenario: 接口通但零数据不算通过

- **WHEN** 拉取接口返回成功但 24 小时内入库为零条
- **THEN** 验收 SHALL 判为未通过，并要求在自检面定位是"无新消息"还是"未就绪"

#### Scenario: 验收报告可复现

- **WHEN** 对同一份数据、同一检查时刻生成两次验收报告
- **THEN** 两次结果 SHALL 完全一致（除生成时间戳外的全部字段）
- **AND** 报告 SHALL 携带数据覆盖口径说明，MUST NOT 让阅读者以为已拿到全量

#### Scenario: 分母为零时不伪装成零

- **WHEN** 库中尚无任何会话
- **THEN** 同意占比 SHALL 返回空值并显式说明「无会话」
- **AND** MUST NOT 返回 0%（会被读成"没人同意"）

#### Scenario: 未提供席位实数即判未通过

- **WHEN** 报告未获得购买/生效席位数
- **THEN** SHALL 判为未通过并指出无法核对覆盖率

#### Scenario: 滞后曲线按日分桶

- **WHEN** 报告给出滞后的历史视图
- **THEN** SHALL 以每日入库条数呈现
- **AND** MUST NOT 仅给平均值（完整断流会被摊薄成温和数字）

#### Scenario: 同意占比过低时如实呈现

- **WHEN** 外部客户同意率低于预期
- **THEN** 验收报告 SHALL 给出同意占比与拒绝会话数，MUST NOT 用总消息数掩盖

### Requirement: 数据是客户资产，停用后可带走

归一化库 SHALL 属于客户资产：提供导出与迁移路径，停用 sidecar 后库留存可用，
MUST NOT 采用只有我方工具能读的私有格式作为唯一格式。

#### Scenario: 停用后仍能取走数据

- **WHEN** 客户停止使用 sidecar
- **THEN** 库文件 SHALL 可被标准 SQLite 客户端直接读取，或经一条命令导出为开放格式

#### Scenario: 导出可导回且条数一致

- **WHEN** 把导出的目录导入一个空库
- **THEN** 会话、消息、参与者、附件、丢失区间的条数 SHALL 与原库一致
- **AND** 附件的重取凭据（`sdkFileId`）SHALL 一并保留，不得留下悬空引用

#### Scenario: 导出可幂等

- **WHEN** 对同一份数据连续导出两次
- **THEN** 除清单中的导出时间外，各文件内容 SHALL 逐字节一致
- **AND** 清单中的计数与文件摘要 SHALL 一致

#### Scenario: 完整性以数据库自检为判据

- **WHEN** 导出或巡检询问数据是否完整
- **THEN** SHALL 使用 SQLite 自身的完整性检查结果
- **AND** 清单 SHALL 随数据一并携带覆盖口径说明，MUST NOT 让接收方误以为拿到了全量
