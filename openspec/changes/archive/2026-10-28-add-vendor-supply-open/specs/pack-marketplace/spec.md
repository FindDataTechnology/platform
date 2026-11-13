## MODIFIED Requirements

### Requirement: Publishing is identity-gated

Publishing SHALL be allowed for authenticated users who satisfy at least one of: platform groups include the configured creator group (default `creators`); the deployment's access mode is `open`; or the user is bound to a registered vendor whose profile mandatory fields are complete (openspec: vendor-identity). The access mode SHALL be read from `PACK_ACCESS_MODE` with `closed` as the default; in `open` mode any authenticated user MAY publish, in `closed` mode admission is the creator group OR a registered vendor binding. Every other user SHALL receive a rejection. The gateway SHALL stamp the publishing user's identity and the publish time onto the stored version; the manifest itself SHALL NOT carry author-controlled identity claims (vendor attribution rides the stamped identity, not the manifest text — see the vendor-attribution requirement in this capability). Both arrival surfaces — the cell-assembled flow on 壹座 and the publish-from-manifest flow on the facet surface — SHALL pass through the same gate and the same manifest validation, and every publish-side rule (rate limiter, manifest validation, tool-surface closure gate) SHALL apply to vendor publishers identically: no lane is relaxed for vendors.

#### Scenario: Creator publishes

- **WHEN** a user whose groups include `creators` submits a valid pack manifest to the publish endpoint
- **THEN** the pack is stored and the response returns its identifier and version

#### Scenario: Non-creator is rejected

- **WHEN** a user with neither the creator group nor a registered vendor binding submits a manifest to the publish endpoint in `closed` mode
- **THEN** the gateway rejects the request with an authorization error and stores nothing

#### Scenario: Bound vendor publishes

- **WHEN** a user bound to a registered vendor with a complete profile submits a valid pack manifest in `closed` mode
- **THEN** the pack is stored and the stamped identity records the vendor attribution input for the attribution requirement to resolve

#### Scenario: Vendor with incomplete profile is rejected at the gate

- **WHEN** a vendor-bound user whose profile mandatory fields are incomplete submits a manifest
- **THEN** the gateway rejects with the eligibility classification naming the missing profile fields and stores nothing

#### Scenario: Manifest publish and cell-assembled publish share the gate

- **WHEN** the same publisher (creator or bound vendor) publishes the same manifest shape via the facet console and via the 壹座 cell-assembled flow
- **THEN** both pass the identical identity gate and manifest validation, and both store versions stamped with the same author identity

#### Scenario: Open access mode admits any authenticated user

- **WHEN** `PACK_ACCESS_MODE=open` and a user with neither creator group nor vendor binding submits a valid manifest
- **THEN** the pack is stored under that user's identity — the same rate limiter, manifest validation, and tool gate apply unchanged

#### Scenario: Closed remains the default

- **WHEN** `PACK_ACCESS_MODE` is unset (or any value other than `open`) and a non-creator without a vendor binding publishes
- **THEN** the refusal is byte-identical to the pre-change contract

#### Scenario: Publish-side rules hold identically for vendors

- **WHEN** a bound vendor's pack declares a tool surface that fails the closure gate or exceeds rate limits
- **THEN** the refusal classification and shape are identical to those a creator would receive

## ADDED Requirements

### Requirement: 市场条目承载供应商署名

发布者 SHALL 可在发布时声明包归属于其绑定的某个供应商主体；网关 SHALL 校验该绑定真实存在后，把供应商主体署名（公开署名字段）投影进市场条目与详情视图——署名来自服务端档案，manifest 文本与包内容 SHALL NOT 承载可自行编写的署名声明。未声明归属的条目不署供应商名（仅作者身份呈现），未绑定主体的发布者提供归属声明 SHALL 以资格分类如实拒绝。供应商主体的公开署名变更 SHALL 使条目呈现随之更新（呈现时取当前档案值），已发布版本的历史归档不变更。

#### Scenario: 归属声明进条目

- **WHEN** 绑定供应商甲的发布者发布 pack 并声明归属甲
- **THEN** 市场列表与详情视图对该条目呈现甲的公开署名，署名值取自供应商档案而非 manifest

#### Scenario: 无权署名如实拒

- **WHEN** 发布者声明的供应商主体并非其绑定主体
- **THEN** 发布以资格分类拒绝并说明绑定关系不成立，不产生条目

#### Scenario: 无归属声明不署名

- **WHEN** 未声明归属的发布（内部作者或不带归属的 vendor 发布）上架
- **THEN** 条目仅呈现既有作者身份，不虚构供应商署名
