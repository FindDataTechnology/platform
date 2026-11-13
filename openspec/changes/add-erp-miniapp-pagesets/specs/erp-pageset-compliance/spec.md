# erp-pageset-compliance Spec

## Purpose

ERP 页面集上线的合规契约：提审材料（类目、隐私声明、演示/审核路径）随页面集新增采集项同步更新并过审后再上对应能力；移动端凭证纪律——端上只持会话 PAT，外部系统凭证零落库零日志零出网（三面验收）；演示沙箱沿 `mp-demo-mode` 同构另立，不把生产 ERP 数据暴露给审核路径。现状依据：`paas/docs/compliance-opening-assessment.md`（MP 侧历轮提审有隐私声明；openid/unionid 数据纪律）、`openspec/specs/mp-demo-sandbox`。

## ADDED Requirements

### Requirement: 提审材料随页面集同步更新

四套页面集提交微信审核前，提审材料 SHALL 完成更新：类目按各端业务形态核对；隐私声明 SHALL 列明页面集新增采集项（定位/影像等 CP/SE 端可选采集）；采集能力 SHALL 在隐私声明过审后方可在端上启用；演示/审核路径 SHALL 沿底座提审经验（`mp-demo-sandbox`/`mp-demo-mode`）同构另立，生产 ERP 数据 MUST NOT 暴露给审核路径。挂账项（订阅消息模板、ICP 定性等）MUST NOT 伪装已通。

#### Scenario: 采集项先过审后启用

- **WHEN** 某页面集页面需要定位/影像采集（如 CP 端提货打卡、回单影像）
- **THEN** 隐私声明已列明该采集项且对应权限声明过审后，端上才启用采集能力；未过审时该能力入口不可用且如实标注

#### Scenario: 审核路径隔离生产数据

- **WHEN** 审核员以演示/沙箱路径体验含 ERP 页面集的小程序
- **THEN** 其所见为独立演示实例数据，与任何生产租户数据隔离（沿 `mp-demo-sandbox` 一次性实例语义）

### Requirement: 移动端 BYOK 凭证零落库

移动端 SHALL 只持会话 PAT（底座既有登录态），MUST NOT 持有任何外部系统凭证；外部系统授权（如金蝶第三方应用授权） SHALL 只进连接器凭证面（萬星 custom_credential），经「端→壹座后端→连接器」token 链调用。验收 SHALL 以三面核证为准：页面网络抓包、端上本地存储、日志审计（连接器+壹座后端）均无外部系统凭证字段出现（redact 纪律对齐连接器 secret redact）。

#### Scenario: 三面核证零凭证

- **WHEN** 对四套页面集任一页面做抓包、本地存储与日志审计三面检查
- **THEN** 三面均不出现外部系统凭证字段；端上唯一凭证为会话 PAT

#### Scenario: 授权动作凭证直达连接器面

- **WHEN** 商家在移动端完成外部系统授权
- **THEN** 凭证只进入连接器凭证面存储，不经过小程序 storage、日志、报表或截屏面
