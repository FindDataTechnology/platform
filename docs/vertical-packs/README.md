# registry-groups.json — 兜底映射（降级）

**状态（carry-registry-visibility-through-bridge，2026-11-05）**：本文件自 registry 列表
携带 `{visibility, allowed_groups}` 元数据起，**降级为兜底**——仅当某行不带元数据
（旧版 registry 兼容窗）时生效；带元数据的行以元数据为准，此处登记被忽略
（两者冲突以元数据为准，桥侧有单测钉死）。

**新组闸条目无需再登记本文件**：注册时写 `visibility=group-restricted` +
`allowed_groups` 即可（cell-manager / wire-api onboarding 两条路径已默认带）。
组闸缺组的条目由桥映射到不可满足 sentinel（`__restricted_ungrouped__`），
fail-closed 不可见并在桥日志点名——与台账「特殊条目缺归属组即缺陷」同轨。

**退役路径**：registry 全量携带元数据（现网镜像 ≥ 本次变更）后，逐条目删除此处
行；全部删净后本文件可整体移除（`loadGroups()` 对缺失文件安全）。

部署提醒：生产实载的是 `fd-infra-deploy/all-services/prod/platform.yaml` 的
`registry-groups-config` ConfigMap（**subPath 挂载，ConfigMap 更新必须
rollout restart**，见 MCP-REGISTRY.md §3.y）——本 bundled 文件仅是仓库内镜像。
