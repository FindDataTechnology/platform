# Tasks: fix-skill-content-propagation

实施仓：`~/code/mcp-gateway-registry`（fd fork）。分支策略见 design D4——从
fd-1.1.1 对应提交（c4b09948）切 `fix-skill-content-propagation` 分支。

## 1. schema 增字段（方案 A）

- [x] 1.1 `registry/schemas/skill_models.py`：`SkillRegistrationRequest` 增加
  `skill_md_content: str | None = Field(None, ...)`（描述对齐 SkillCard 同名字段：
  inline SKILL.md content, stored instead of URL fetch），并加 field_validator
  把空串归一为 None（design D3）
- [x] 1.2 单测（`tests/unit/test_skill_models.py`）：字段可解析、空串归一 None、
  不带字段的载荷不产生该键（exclude_unset 语义）

## 2. update 路径派生刷新（方案 B）

- [x] 2.1 `registry/services/skill_service.py` `update_skill`：updates 含
  `skill_md_url` 且与现值不同 → `translate_skill_url` 重派生 `skill_md_raw_url`
  写入 updates（design D2，注意需先取 existing——现函数只在 proxy 字段被碰时才读
  库，需扩为 skill_md_url 在 updates 时也读）
- [x] 2.2 `update_skill`：`skill_md_content` 在 updates 且与现值不同 → 刷新
  `content_updated_at`（design D3）
- [x] 2.3 单测（skill service update 路径）：URL 变→raw_url 跟随；URL 不变→
  raw_url 不动；正文变化→content_updated_at 刷新；正文未设→存量保留

## 3. 路由层验证

- [x] 3.1 PUT `/api/skills/{path}` 集成测试（现有 update 路由测试就近扩展）：
  载荷带 `skill_md_content` → 落库可见（GET 卡片返回新正文）；不带 → 不清空；
  载荷带新版本化 `skill_md_url` → `skill_md_raw_url` 同步新版本
- [x] 3.2 内容端点回归：`skill_md_content` 非空时优先返回库内正文（现有行为，
  加一条防回归断言即可）

## 4. 验证与收口

- [x] 4.1 全量单测：skill 面 431 绿；全量 7577 绿 + 1 失败=security_scanner_ssrf 缺 yara 模块（venv 存量环境问题，与本改动无关，该测试以子进程跑第三方扫描器）
- [x] 4.2 本地进程内冒烟（真路由+真服务+假持久层，/tmp/skill_propagation_smoke.py）：模拟部署侧 PUT（带正文+版本化 URL 的
  两连击 v1→v2），断言 `/api/skills/{name}/content` 两轮都返回对应版本正文
- [x] 4.3 发布完成（2026-10-12）：D4 前提过时——生产实际已是 fd-1.2.1、origin/main 已含全部在途提交，直接 rebase 上 origin/main（ad118d4a）发 **fd-1.2.2**；org Actions 账单阻断 → scs001 临时线构建（sha-ad118d4，双 job 绿含预算门）→ relay 回灌 → cheap-1 滚 registry；生产复验=启动/健康/公网 + **真 HTTP 端到端探针全绿**（facade pod 内部署同款鉴权：注册→PUT 正文→content 端点 inline 直取→删除）
- [x] 台账 docs/registry-maintenance.md §1 换行 + §9.3 发布记录
- [x] 4.4 openspec archive（validate --specs 通过后归档，sync `skill-content-propagation`
  新 capability 入主 specs）
