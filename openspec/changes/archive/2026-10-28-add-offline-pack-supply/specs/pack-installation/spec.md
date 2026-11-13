# pack-installation Specification Delta

## MODIFIED Requirements

### Requirement: Manifest retrieval is server-side

Installing a pack SHALL NOT require the client to transmit the pack manifest.
The install endpoint SHALL accept `{packId, version}` and retrieve that
version's manifest from the marketplace server-side before running the existing
validation and materialization pipeline. A request that still carries a
manifest body SHALL continue to be accepted and SHALL be validated by the same
rules (rolling compatibility). **A third shape SHALL be accepted: a locally
supplied offline bundle, whose manifest snapshot and resource files enter the
identical pipeline through `POST /api/mypacks/import-bundle` (`offline-pack-supply`
capability) — no separate validation chain, identical rules.** Retrieval SHALL
be performed under the calling user's identity so that private-pack visibility
semantics are unchanged. If the manifest cannot be retrieved, the install SHALL
fail with a clear error and materialize nothing.

#### Scenario: Client sends only packId and version

- **WHEN** the UI posts `{packId, version}` for a pack whose manifest contains code snippets
- **THEN** the server fetches the manifest from the marketplace, validates it, and materializes the pack exactly as before

#### Scenario: Private pack visibility follows the caller

- **WHEN** a user installs a private pack they are allowed to see
- **THEN** the server-side retrieval is evaluated under that user's identity and succeeds; a user without access gets the same not-found behavior as the market listing

#### Scenario: Retrieval failure installs nothing

- **WHEN** the marketplace is unreachable or the version does not exist
- **THEN** the response reports the failure and no skill, MCP reference, or agent is written

#### Scenario: Body manifest still accepted

- **WHEN** a request includes a manifest body during the compatibility window
- **THEN** it is processed through the identical validation pipeline as a server-retrieved manifest

#### Scenario: Offline bundle enters the same pipeline

- **WHEN** a valid `.yizpack` is imported on a machine with the marketplace unreachable
- **THEN** the pack installs through the identical validation and materialization pipeline, and the install record and report mark the source as `bundle`

## ADDED Requirements

### Requirement: 安装来源可区分

安装记录与安装报告 SHALL 记录来源字段（`market` | `bundle`；历史行缺省视为
`market`）。SHALL 保持向后兼容：既有读面与客户端不识别该字段时行为不变，
不因来源字段产生新的安装门。

#### Scenario: 老读面不受影响

- **WHEN** 一个只认识既有字段的读面列举已安装 pack
- **THEN** 输出与引入来源字段前等价，仅多出可忽略字段
