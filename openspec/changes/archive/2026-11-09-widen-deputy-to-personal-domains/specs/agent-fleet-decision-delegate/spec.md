## MODIFIED Requirements

### Requirement: 裁决携带身份与依据

每条裁决（owner 或 deputy）SHALL 记录裁决者身份（owner / deputy）、deputy 裁决时所用模型、裁决依据文本及其引用的判例（过往拍板项 id 或记忆条目引用）。主人过往裁决 SHALL 可被 deputy 作为判例读取。拍板队列与管理面 SHALL 展示裁决者身份与依据；deputy 裁决的条目 SHALL 与 owner 裁决在视觉上可区分。

判例 SHALL 携带来源等级：`owner-authored`（主人亲手书写，含在邮件/IM 中亲自答复）、`owner-approved`（主人原样发出了代理的草稿）、`deputy-ruled`（代理自行裁决）。仅前两级 SHALL 可被引用为判例；`deputy-ruled` SHALL NOT 进入判例集，只用于行为一致性统计。等级 SHALL 由服务端按记录的产生路径判定，MUST NOT 采信代理自报——代理起草的稿被主人原样发出后字面上就是主人的口径，不加分级回喂会形成自我强化。

当该裁决经由审计官时，条目 SHALL 附带审计官结论（`同意` / `有异议但放行` / `阻断并上报`）与理由文本。「阻断并上报」SHALL 由服务端强制生效：条目不进入执行路径、转路由主人并保持 open。审计官结论与异议文本 SHALL 在其后所有读面（队列、名册、报数）中可见。

#### Scenario: deputy 裁决可审计

- **WHEN** 常务岗批准一条例行运营项
- **THEN** 条目记录 resolved_by=deputy、所用模型、依据文本与引用的判例，队列中可见

#### Scenario: 判例来自主人历史

- **WHEN** 常务岗面对与主人过往裁决同类的问题
- **THEN** 其裁决依据 SHALL 能引用该过往拍板项（主人当时的选择与理由）

#### Scenario: 代理自裁不入判例

- **WHEN** 检索判例集以支持一次新判断
- **THEN** 仅返回来源等级为 `owner-authored` 或 `owner-approved` 的记录，`deputy-ruled` 不在其中；若裁决引用了第三级，该裁决被拒绝并说明等级不足

#### Scenario: 审计官阻断改变终局

- **WHEN** 一条已由常务岗批准的条目被审计官标为「阻断并上报」
- **THEN** 该条目转路由主人并保持 open，不进入执行，理由与代理原判断一并可见

#### Scenario: 异议放行仍留痕

- **WHEN** 审计官给出「有异议但放行」
- **THEN** 动作按原模式执行，异议文本随条目保存并可在后续读面检索
