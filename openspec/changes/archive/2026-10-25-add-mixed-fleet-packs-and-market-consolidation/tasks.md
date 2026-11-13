## 1. 校验器单源与模板编导（A）

- [x] 1.1 钉 `server/fleet-orchestration.js` 校验器纯度：静态检查其 import 面无任务引擎/副作用依赖，加「gateway 可 import」守卫测试；若不纯则抽出纯校验文件（活舰队写面 re-export 保持 API 不变），单测全绿
- [x] 1.2 `server/fleet-template.js` parseFleetTemplate 解析 `orchestration` 段（成员集域校验；未知边类型/引用成员集外岗位/禁键结构化拒绝；缺段短路路径不变），单测覆盖：合法编导过、引用外岗拒、无段逐字节等价
- [x] 1.3 发布预校验两侧（gateway 面与 cell 面）对带 fleet.orchestration 的 manifest 调同源校验器，测试：预校验拒绝非法编导、放行合法编导
- [x] 1.4 `server/fleet-provisioner.js` 实例化落地编导：走既有舰队写面 orchestration 写路径；目标缺位岗位边照落；重复实例化幂等不重写编导；单测三场景
- [x] 1.5 `exportFleetToTemplate` 往返带编导：导出含现役编导段、预校验通过、重装后边一致，round-trip 测试钉住
- [x] 1.6 官方种子升级+守恒测试扩展：内容工厂（trigger+流水线 handoff/dispatch 链）、客服护航（channel bot event 边唤醒客服岗）等六份种子补编导，守恒测试遍历覆盖 orchestration 段，全库过预校验
- [x] 1.7 模板 `tool` target kind：parseFleetTemplate 解析 + provisioner 经 resolveTarget tool 分支解析 + 缺位待补降级，单测三场景（解析成功/缺位/非法目标）

## 2. bot 第三原语（A）

- [x] 2.1 `lib/pack-manifest.js` bots 段校验：形状（id/name/generic/description/skill?）、禁键（凭据/端点族）、skill 挂载须引用本 pack 技能、上限 `PACK_MAX_BOTS`（默认 3，env 可调、读时生效），单测覆盖 spec 三场景
- [x] 2.2 通用 bot 类型面：类型注册表（v1=channel）+ 只读清单端点（发布预校验/安装面/目录面同源），未知 generic 类型在预校验拒绝，单测
- [x] 2.3 `pack-store.js` bots 安装物化：botOwner 冲突策略（外来占用 skip 带原因/自有升级替换）、待连接+禁用出生态进安装报告、uninstallPreview/uninstallPack 删除边界（通道凭据与平台配置保留），单测镜像 skills/agents 既有形状
- [x] 2.4 channel 类型实现：物化实例挂技能后入站消息经技能会话作答、出站投递复用既有四通道适配器；e2e 走 webhook 守卫（路径 secret/尺寸/频次）验证零扩权
- [x] 2.5 舰队衔接：fleets-db/resolveTarget 的 bot 分支（pack bot 与既有 bot 无差别）、fleet-template TEMPLATE_TARGET_KINDS 增 bot、event 边 `bot:<packBotId>` 唤醒链路，单测+e2e（客服护航种子全链：装包→实例化→bot 入站→客服岗 manual 回合）
- [x] 2.6 安装面呈现：安装报告/详情/卸载预览的 bot 项与待连接提示（web 面最小改动），fast e2e 过

## 3. 发布闸与市场治理（B）

- [x] 3.1 facet 发布闸同名防呆：同 authorEmail+同名（listed 或 unlisted）发布→结构化拒绝且回报既有 packId 与升版指引；跨作者同名放行；单测三场景（同作者同名拒/跨作者放行/被拒零落库）
- [x] 3.2 清理同名建重 3 对：柏讯·预期差/政策传导/信息冲击 v1（10-23）unlist，v2 为准；管理 API 操作+操作前后目录快照留档
- [x] 3.3 数据域收编（design D6 映射表）：柏讯四套件先做差异技能并版升版，后 unlist 六个数据包（两老样例+四个 10-24 包）；每包下架前导出版本与订阅数快照；柏讯套件新版抽验可装
- [x] 3.4 CRM 合一：unlist「CRM 客服接待套件」，保留「CRM 客服套件」；仓内 `packs/crm-desk-suite` 与市场包内容对齐一次（市场为分发更新通道）
- [x] 3.5 目录基线清账：向导验收·双子/一键流验收/部署演示·FingPt 分析师 unlist；存量公开包 category 补齐（fleet/daas/legal/crm/facet/docs）；核验：公开列表无演示包、category 非空（脚本对拍 `/api/packs`）
- [x] 3.6 `docs/vertical-packs.md` 更新：样例面剩法律两包，数据域退役指针指向柏讯套件；demo playbook 两包口径

## 4. 收口与交付

- [x] 4.1 全量测试绿（单测+fast e2e），`openspec validate add-mixed-fleet-packs-and-market-consolidation --strict` 通过（单测 2007/2017+fast e2e 536/546：余 10 失败经干净 HEAD worktree 对拍+单跑复验全数=并行线既有或序间抖动，本 change 零新增；顺手修 HEAD 既有 bot-webhooks 夹具 4/4 与 wire-tool-risk 快照 6/6）
- [x] 4.2 出片与灰度：facet 先上同名闸（堵新增建重），paas 出片后生产探针——带编导种子 v2 铸造上架、装包→实例化→编导生效→channel bot 入站唤醒全链验证；回滚路径按 design Migration 演练口径留档。生产实证四件：同名闸真车 409（错误体含 existingPackId+升版指引）；市场清理后公开目录 56 包且 category 零空缺；五官方种子 v2 上架（fleet.orchestration 过新发布闸）；platform-demo 活链=装包 200→from-template 201 出生全队暂停→编导 6 边落舰（refs 改写为岗位 id、缺位引用岗诚实 vacant）→generic-types 200→解散/卸载 200（removedBots/botsCredentialsKept 形状在档）。channel bot 入站唤醒以 hermetic 测试为证（demo cell 无真通道凭据），真通道验证留观察项
