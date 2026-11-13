## MODIFIED Requirements

### Requirement: starter 序列有定义且不强制顺序

平台 SHALL 定义官方 starter 团队序列（首选=客服班组——最小满编三岗、节奏直观、凭据缺位如实降级；
次选=AI 公司/内容流水线——全景与编排示范；领域进阶=投研晨会/晨报情报站），并 SHALL 呈现在
first-run 引导、帮助中心开始路径与市场官方集合面（消费官方判定）。注记：`docs/fleet-templates/`
中另有 `product-intro-fleet.seed.json` 第六支种子——它属官方模板资产（产品介绍演示用途），
不入选本展现序列（展现序列钉五支）；其存在 SHALL NOT 改变序列定义、呈现面或安装语义。
序列 SHALL NOT 强制安装顺序、
SHALL NOT 改变 pack 安装与团队实化的既有语义、SHALL NOT 产生自动安装。

#### Scenario: 新用户看到序列而非清单

- **WHEN** 新用户首次打开引导的开始路径或官方集合面
- **THEN** 呈现带推荐次序的 starter 序列（每支一句话定位），可跳过任意一支，无任何自动安装发生

#### Scenario: 序列是呈现层的

- **WHEN** 用户不按序列安装（或只装一支）
- **THEN** 安装、实化、驾驶舱全部照既有语义工作，序列的存在对其零影响

#### Scenario: 第六支官方模板种子不入序列

- **WHEN** 检视 `docs/fleet-templates/` 的种子清单（六份 seed）
- **THEN** 展现序列仍只含五支（客服班组/AI 公司/内容流水线/投研晨会/晨报情报站）
- **AND** `product-intro-fleet.seed.json` 作为官方模板资产保留在模板目录，不出现在 starter 序列的任何呈现面
