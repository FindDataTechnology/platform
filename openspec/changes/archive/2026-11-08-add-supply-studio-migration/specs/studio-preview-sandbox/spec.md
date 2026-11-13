## Purpose

The ephemeral preview sandbox of the supply domain: a facet-side dry-run preview (static validation, manifest assembly, LLM drafting) that lets creators see the shape of their work before publishing without depending on 壹座, with hard server-side quotas, zero persistence, and honest degradation — never a free-compute channel.

## ADDED Requirements

### Requirement: 预览不落库且不依赖壹座

预览 SHALL 在谦面服务端 ephemeral 执行（静态校验+manifest 组装+LLM 起草干跑），产物随响应返回、不写入任何存储；预览路径 SHALL NOT 依赖壹座服务、cell 或舰队语境。

#### Scenario: 预览零残留

- **WHEN** 创作者对一份文档发起预览并得到结果
- **THEN** 预览中间产物与结果不落任何库，文档存储中除文档本身外无新增记录

### Requirement: 配额与限额服务端强制

预览 SHALL 受每身份每日配额与单次时长/token 帽约束，全部在服务端强制；超限 SHALL 返回显式语义码而非静默截断；匿名身份 SHALL NOT 获得预览。

#### Scenario: 超限显式拒绝

- **WHEN** 创作者当日配额耗尽后再次发起预览
- **THEN** 服务端返回配额超限语义码，界面如实呈现，MUST NOT 返回降质的伪预览

### Requirement: 诚实降级

预览通道不可用（模型上游失败、沙箱内部错误）SHALL 呈现显式失败态与可重试入口；上游错误 SHALL 如实包装，MUST NOT 以占位内容或空结果伪装成功。

#### Scenario: 上游失败如实呈现

- **WHEN** 起草模型上游对预览请求持续失败
- **THEN** 预览呈现显式失败与重试入口，不产出占位草稿
