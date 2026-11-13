# Design: fix-skill-content-propagation

## Context

断链现状（证据来自 2026-10-12 finddata 交接文档 + 代码核对）：

- 部署侧 `lib/agent-serving.js` `deployToRegistry`（:526-527）每技能 upsert PUT
  `skill_md_url`（当前版本化 URL）+ `skill_md_content`（正文）。
- registry `SkillRegistrationRequest`（`registry/schemas/skill_models.py:426`）无
  `skill_md_content`——pydantic 默认忽略未知字段，PUT 载荷里的正文被静默丢弃；
  也无 `skill_md_raw_url`。
- PUT 路由（`registry/api/skill_routes.py:1238`）`model_dump(exclude_unset=True)` →
  `skill_service.update_skill`（`registry/services/skill_service.py:1613`）原样
  `repo.update($set)`。`skill_md_url` 在 schema 里所以能更新（线上元数据确实显示新版本），
  但 raw_url 只在 create 路径翻译（:1364），update 从不刷新。
- 内容端点（`skill_routes.py:642-649`）：`skill_md_content` 空 → 回退
  `skill_md_raw_url or skill_md_url` 拉取 → 冻在 v1 的 raw_url。
- finddata 侧已直接写库热修（正文 + raw_url 指到 v10），本 change 不迁移数据、不动热修结果。

## Goals / Non-Goals

Goals:
- 部署侧现有 PUT（不发新版 paas）即让正文随版本传播。
- raw_url 成为服务端派生不变量，杜绝展示/取值错位。
- 不带正文的常规编辑（registry UI）零行为变化。

Non-Goals:
- 不改内容端点取值顺序（content 优先 → raw_url 回退），不改子机拉取逻辑。
- 不做正文的版本历史/diff（条目仍是单快照，pack 版本历史在 facet 侧已有）。
- 不给 `skill_md_raw_url` 开放请求字段（见决策 D2）。
- 不处理 pack 侧四技能之外的存量数据回填（热修已覆盖 spider-heal；其他走
  正常升级路径的 pack 在修复后自然对齐）。

## Decisions

### D1 · schema 增 `skill_md_content: str | None`（方案 A）

交接文档给了两条路：A=schema 增字段让部署侧现有 PUT 生效；B=部署侧改 PUT raw_url。
选 A：paas 侧零改动、零发版，且与 `SkillCard` 已有同名字段对齐（federated skills 的
先例语义：DB 存正文而非拉 URL）。字段无 max_length——与 `SkillCard.skill_md_content`
一致，pack 技能正文为 KB 级，Mongo 文档无压力。

实施期补记（apply 阶段发现）：部署侧 upsert 对**新技能走 POST**（按名查不到时回退
`/api/skills` create），载荷同样带正文——故 `_build_skill_card` 一并从 request 透传
`skill_md_content`，首版正文即入库；属同一传播语义的 create 侧补全，非新范围。

### D2 · raw_url 刷新放服务端派生，而非 schema 开放字段

不让请求模型接受 `skill_md_raw_url`（那是交接文档方案 2 的变体）：raw_url 的语义是
「skill_md_url 的翻译派生值」，开放为请求字段会引入客户端供给不一致的可能。改为
`update_skill` 内部派生：updates 含 `skill_md_url` 且与现值不同时，重跑
`translate_skill_url`（与 create 路径同一函数，非 GitHub URL 恒等返回，语义安全）
写入 `skill_md_raw_url`。加「与现值不同」守卫：URL 未变的更新不碰 raw_url，
经库外手段人工设定的取值 URL 在 URL 不变期间得以保留。

### D3 · 空串归一 + `content_updated_at` 刷新

- 校验器把空串 `skill_md_content` 归一为 None（→ `exclude_unset` 语义下等同未设），
  防调用方误传空串清空正文。
- `repo.update` 是通用 `$set`，没有内容钩子；在 service 层 update 路径里，当
  `skill_md_content` 在 updates 且与库中现值不同时，顺带 `$set content_updated_at`。
  `content_version`（内容哈希）不在本 change 重算——它的消费方（健康检查缓存）
  以时间戳为主，哈希留待健康检查自然重算，避免在 service 里引入第二份哈希口径。

### D4 · 发布载体（待拍板项，不阻塞实现）

registry 本地 HEAD 领先生产 fd-1.1.1 三笔（virtual-router scope 修复 / fastembed
瘦身 / card examples 进行中分支）。两条路：
- **cherry-pick 切 fd-1.1.2 先行**（本 change 从 c4b09948 切分支）——最快止血，
  下次 spider-heal 升级前正文传播就位；
- **等 card examples 收尾一起发下个 minor**——少一次发版，但传播修复被绑架在
  未收尾特性后面。

推荐前者。实现落位时从 fd-1.1.1 提交点切 `fix-skill-content-propagation` 分支，
修复合入 main 谱系后随常规节奏并入。

## Risks / Trade-offs

- **正文大小**：无上限字段意味着超大正文可入 Mongo。现状 `SkillCard` 同样无上限、
  pack 技能均为 KB 级；接受，不为此加限制（加了反而可能误伤长技能）。
- **UI 回显**：registry UI 编辑表单若以「全字段回传」方式 PUT，正文字段会在每次
  UI 保存时原样写回——幂等无害；若不回传，unset 保留——两种都安全。
- **审计面**：`check_registration_gate` 收到的 payload 从此含正文字段，体积增大；
  现有门控按字段名单/规则处理，不解析全文，无新增失败模式。

## Migration Plan

无 schema 迁移（Mongo 无固定 schema）。存量条目不动：`skill_md_content` 为空的
条目维持 URL 拉取语义；需要正文的部署方下次升级自动带上。热修过的 spider-heal
四条目与本修复兼容（字段同名同义）。
