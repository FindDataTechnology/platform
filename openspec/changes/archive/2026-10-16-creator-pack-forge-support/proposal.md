## Why

生态创作者要在壹座内自助构建功能集（「谦面工坊」creator pack，finddata 侧独立 change），
但对话式组装的闭环缺最后一块：manifest 目前只能在发布时（`POST /api/packs`）被校验，
创作助手无法在发布前预检——而版本不可变、每作者每小时限 10 次成功发布，"靠 400 报错迭代"
对生态创作者既贵又不体面。同时 platform 自带发现层被 `tool-discovery` spec 明令不挂
`airegistry-tools`，"显式装包引用它"这条工坊必经路径需要一个 spec 澄清，否则下一个读
spec 的人会把工坊判成违规。本 change 只铺 paas 侧这两块路。

## What Changes

- 新增 `POST /api/packs/validate` dry-run 路由（`gateway/packs.js`，紧邻发布路由）：
  - **鉴权**：任何登录用户可调（不要求 creators 组——让没办创作者身份的人也能先自查）。
  - **校验范围**：模拟全部发布门——`validatePackManifest` 结构限额 + 工具声明门
    （`lib/publish-tool-gate.js`，allowTools 对拍 registry 快照）+ files 门（PACK_FILES_ENABLED）；
    创作者组门以 finding 形式报告（"当前身份不可发布"），不做鉴权拒绝。
  - **响应**：`{ valid, errors[] }`，errors 措辞与 `POST /api/packs` 的 400 **逐字一致**
    （`lib/publish-tool-gate.js:49` 注释已确认两门 errors 形状刻意统一，dry-run 直接复用，
    转述零翻译）。
  - **副作用**：不落库、不铸版本号、不计入每作者发布限流。
- `pack-marketplace` spec 新增 Requirement「Manifests can be validated without publishing」。
- `tool-discovery` spec 在既有 Requirement「Discovery is limited to already-effective tools」
  下补澄清 Scenario：用户显式安装的 pack 引用 `airegistry-tools` → 该用户经正常装包获得
  其工具；发现层本身仍不自动挂载、不引发市场发现流。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pack-marketplace`: 新增「不发布即可校验」Requirement——validate dry-run 的鉴权、
  门模拟范围、响应契约、零副作用。
- `tool-discovery`: 既有 Requirement 补澄清 Scenario——显式装包引用 airegistry-tools
  与发现层自身不挂载的边界。

## Impact

- **代码**：`gateway/packs.js`（新路由）、复用 `pack-store.js:158` /
  `lib/publish-tool-gate.js` 既有校验链；限流器排除 validate 路径；配套单测
  （含"errors 逐字一致"对拍用例）。
- **前端**：零改动——壹座对 `/api/packs` 全前缀代理到 facet，新路由自动可达。
- **范围外但成对**：finddata 侧 `facet-market-mcp` 加 `market_pack_validate` 工具
  （`market_pack_publish` 内部同校验链，天然工具层强制）与「谦面工坊」pack 内容
  （`docs/facet-forge/`，含 `facet-forge-assembly/-adaptation/-acceptance` 三技能 +
  双 MCP + 铸造师 persona），属独立 change。

## 边界（Non-goals）

- 草稿保存工具（cell 本地写「我的创作」草稿）——后续 change。
- 树技能进 registry、跨包技能按引用复用、manifest license 字段——候选后续
  （license 字段与改编政策勾连最紧，先排队）。
- 技能 files 带脚本、visibility/curation 下放创作者——不做。

## 前置（infra 侧，范围外，阻塞工坊发布而非阻塞本 change）

1. `airegistry-tools` 路由修复：GitOps 补 Service（`mcp-registry` ns 现无任何 Service），
   `proxy_pass_url` 由无 DNS 的 `http://mcpgw-server:8003/` 改指
   `http://mcpgw.mcp-registry.svc.cluster.local:8003/`（pod 本身健康，`MCP-REGISTRY.md` §3 挂账）。
2. 快照回填：网关 rescan 或 PATCH 回填 `tool_list`（7 工具）——工坊 manifest 用
   `allowTools` 收窄（留 5 剔 2：`intelligent_tool_finder` 已废弃、`healthcheck` 运维噪音），
   没有快照过不了发布门（谦面市场助手首发被拦同款）。
3. 凭据姿态：核 cheap-1 `extra_env/mcpgw.env`；若为静态 `REGISTRY_API_TOKEN`（=管理员视图
   全透出）则摘除，转调用者 bearer 转发——registry 侧按用户过滤（tool_filter、搜索裁剪、
   技能 visibility）现成且完整，静态令牌会整体绕过。
4. 雷：安全扫描曾判 `search_registry` high=1（自动下线风险）；动条目前确认
   `SECURITY_ALLOW_UNSAFE_SERVERS`，事后清 `security-pending` 标。
5. 回归：姿态 3 下确认内部消费方（靠它浏览 tools/skills 的角色）不受损。
