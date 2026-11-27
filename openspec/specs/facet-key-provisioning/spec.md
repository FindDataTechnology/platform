# facet-key-provisioning Specification

## Purpose
谦面客户凭据的自动检测与预备：装完技能之后，检测本地缺哪把键、用设备授权一步铸一把属于客户
自己的萬星词元 `sk-` 键（计入他自己的余额），写进对应 harness 的 LLM 配置；并把「`wgk-` 工具面
授权键」与「`sk-` 模型调用付费键」两个不同域如实分开呈现，不混为一谈。

## Requirements

### Requirement: install 完成时自检凭据并显式指引缺口

`facet install` SHALL 在技能落盘之后检查本地是否已有可用凭据，并按缺口给出**显式**提示：缺哪把键、
用它做什么、跑哪个子命令补齐。它 MUST NOT 在缺键时静默结束而不提示，也 MUST NOT 让客户误以为
「装完即可用」。

#### Scenario: 缺模型键时显式提示

- **WHEN** 客户 `facet install` 装完一个功能集，且本地没有任何 `sk-` 萬星词元键
- **THEN** 安装结束前打印「缺模型调用键 `sk-`（用于跑 agent），执行 `facet key --provision` 一步获取」，
  并在输出里指明它付的是客户自己的词元余额

#### Scenario: 两把键分开说

- **WHEN** 安装结束时同时缺 `wgk-`（工具面）与 `sk-`（模型）两把键
- **THEN** 输出分别说明两者的用途与获取命令，MUST NOT 用一句「凭证缺失」合并二者

#### Scenario: 已有键则不再打扰

- **WHEN** 本地已有可用的 `sk-` 键
- **THEN** 不自检失败、不打印获取指引，安装照常完成

### Requirement: 一键铸一把客户自己的萬星词元键

`facet key --provision`（名字可调）SHALL 通过设备授权/登录流铸一把 `sk-` 键并保存到本地（权限 0600），
该键 MUST 计入**客户本人**的萬星词元余额与用量面板，MUST NOT 复用平台管理员身份替客户扣费。
铸键动作 MUST 留审计记录（谁、何时、归属哪个 group/账号）。

#### Scenario: 客户铸到自己的键

- **WHEN** 客户用其萬星词元账号完成一次授权
- **THEN** CLI 得到一把 `sk-` 键、存本地 0600、打印其归属账号与用途，且该键在客户自己的用量面板可见

#### Scenario: 不以平台身份代扣

- **WHEN** 铸键请求抵达服务端
- **THEN** 归属主体是授权登录的客户账号，MUST NOT 落到平台服务账号名下

#### Scenario: 铸键留审计

- **WHEN** 铸出任何一把键
- **THEN** 服务端记录一条审计（主体、时间、group），可被事后追查

### Requirement: 写入 harness 的 LLM 配置使 agent 真能跑

`facet key --provision` 成功后 SHALL 把键与网关基址写进所选 harness 的 LLM 配置（如 `ANTHROPIC_BASE_URL`/
`OPENAI_BASE_URL` + key，或对应编辑器的原生位置），使已安装的 agent 能真发起一个模型回合。
完成判据 MUST 是「agent 真回了一个回合」，MUST NOT 以「配置文件写对了」为成立。

#### Scenario: 配置后真跑通一个回合

- **WHEN** 铸键并写入后，客户触发一次 agent 回合
- **THEN** 模型返回内容（回合成立），证明键与基址真实可用

#### Scenario: 键有效但写错位置即判未完成

- **WHEN** 键有效，但被写进了 harness 不读的位置
- **THEN** 该步 MUST 判未完成并报「写入位置不被该 harness 读取」，而不是绿灯

### Requirement: 两域凭据互不冒充

`wgk-` 调用键（工具面授权）与 `sk-` 词元键（模型调用付费）SHALL 在存储、传递、呈现上保持分离：
以 `sk-` 去充当工具面授权 SHALL 被拒绝并说明应改用 `wgk-`，反之亦然。

#### Scenario: 用错域被拒且指路

- **WHEN** 客户把 `sk-` 键当作工具面授权键提交
- **THEN** CLI 拒绝并提示「`sk-` 属模型调用域，工具面请用 `facet connect` 铸 `wgk-`」
