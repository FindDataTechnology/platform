## Purpose

被烘入的插件 bundle 能往运行时贡献什么，必须由平台判定而不是由 bundle 自述：路由只能有一个写方、工具面只能被裁窄、平台凭据不可达。越界即拒绝启动，且拒绝必须具名可归因。

## ADDED Requirements

### Requirement: 模型路由只能由平台写入

合成后的 profile SHALL 只包含平台自身写入的模型路由声明。合成结果中 SHALL NOT 出现任何非平台来源的、会注册模型提供方或路由的插件行；命中时系统 SHALL 拒绝启动并给出具名错误（指出该行的 id 与来源 bundle），SHALL NOT 以"部分可用"或"忽略该行"的方式继续。

该断言 SHALL 在写盘前与启动前各执行一次，两次判定 SHALL 使用同一实现。断言 SHALL 覆盖两种来源：profile 补丁层（`cordis.patch.yml` 及同类文件）与 bundle 层贡献的条目。

#### Scenario: 第三方模型路由被拒启动

- **WHEN** 一个被烘入的 bundle 贡献一行 `{ id: "vendor-llm", name: "@acme/dsh-llm-router" }`
- **THEN** 系统拒绝启动，错误指名该行 id 与来源 bundle，且不进入任何回合

#### Scenario: 平台自己的路由不受影响

- **WHEN** 合成树只含平台写入的 `llm-pi-ai` 与 `spill-policy` 两行
- **THEN** 断言通过，启动照常，行内容与本次变更前逐字节一致

#### Scenario: 删掉该行也不能绕过

- **WHEN** 有人从补丁层删掉平台自己的 llm 行，只留下第三方路由行
- **THEN** 断言仍然失败（不是"没有冲突所以通过"）

### Requirement: 插件工具受同一工具面封顶

插件贡献的每个工具 SHALL 与既有 MCP 工具同处一次工具面裁剪：先由席位声明（`agents[].resources.mcpTools`）决定可见集合，再由运营者侧工具面上限求交。未在席位声明中出现的插件工具 SHALL 不可调用，调用 SHALL 返回拒绝，并 SHALL 记一条台账记录（席位、工具名、原因）。插件工具 SHALL NOT 因为"由插件提供"而默认获得全开面。

#### Scenario: 未声明的插件工具被拒

- **WHEN** 某席位未在工具面声明里列出插件提供的 `vendor.search`，agent 调用该工具
- **THEN** 调用被拒，返回明确原因，台账出现一行记录

#### Scenario: 已声明但仍受运营者上限约束

- **WHEN** 席位声明了 `vendor.search`，但运营者对同一服务名声明了更窄的工具面
- **THEN** 生效集合为两者的交集；交集为空时该工具不可见（不是回落为全开）

### Requirement: 平台凭据在出片期被机器拦截

出片（镜像构建与桌面 predist）SHALL 扫描 profile 补丁层与每个白名单 bundle 的声明，命中平台凭据键名（中继令牌、注册表管理令牌、供应商网关密钥）即 SHALL 以非零退出码拒绝出片，并指出命中位置。该检查 SHALL 在产物生成前执行，SHALL NOT 依赖人工审校记录。

#### Scenario: 凭据键命中拒绝出片

- **WHEN** 某 bundle 声明里出现平台中继令牌的环境键名
- **THEN** 出片失败，退出码非零，输出指名该 bundle 与该键

#### Scenario: 干净声明照常出片

- **WHEN** 白名单内所有 bundle 声明与补丁层均不含平台凭据键名
- **THEN** 出片照常进行，产物与未接入该检查时一致

### Requirement: 贡献类别必须声明且越界即拒

每个被烘入的 bundle SHALL 在供给白名单中声明其可能贡献的类别（工具 / 技能 / 界面 / 服务），未声明类别的 bundle SHALL NOT 被烘入。合成期贡献出声明类别之外的内容（注册模型路由、建立凭据通道、自起外部渠道进程）SHALL 被拒绝，并指名 bundle 与越界类别。

#### Scenario: 未声明类别的 bundle 不被烘入

- **WHEN** 白名单某条目缺少贡献类别声明
- **THEN** 出片前置校验失败并指名该条目

#### Scenario: 越界贡献在合成期被拒

- **WHEN** 一个只声明了 `tool` 的 bundle 在运行时试图建立凭据通道
- **THEN** 该贡献被拒，记录指名 bundle 与 `credential` 类别
