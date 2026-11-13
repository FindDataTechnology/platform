## 1. MCP Registry 投影器（代码，最高价值）

- [x] 1.0 **先导出可见性规则**：`facet/mcp-catalog.js` 里 `visibleTo` 目前是 `registerFacetMcpRoutes` 内部闭包、未导出（实测 :26 附近）。提为模块级 `export function visibleTo(entry, viewer)`，路由内部改引用它（行为零变化）。**禁止在投影器里重写该判断**（design C2）。
- [x] 1.1 新增 `facet/mcp-registry-json.js`：导出 `projectServerJson(entry)` / `projectAllServers({entriesFn})` / `registerMcpRegistryJson(app,{entriesFn})`；只投 `visibleTo(entry, null)===true`（即 `groups` 为空的公开 server）。签名与常量见 design C1。
- [x] 1.2 `server.json` 形状按 design C3 逐字段映射：`name`=`io.github.FindDataTechnology/<entry.name>`、`description`、`version`=**固定 `0.0.1` 占位**（server 条目无 version 字段，实测）、`remotes[{type:"streamable-http",url:entry.configTemplate.url}]`；`repository`/`websiteUrl` 省略（无来源）。
- [x] 1.3 缺 `description` 或 `configTemplate.url` 的单条 server：跳过并记原因，不毒化整批。
- [x] 1.4 凭据门：`remotes[].headers` **整块省略**（`configTemplate.headers` 里的 `Bearer <your_token>` 是占位符，也不写入）；另对序列化后的整份产出跑一次 `CREDENTIAL_RE`（从 `facet/marketplace-repo.js` 导入），命中即抛 `PROJECT_REJECTED`、整批不写（拒绝而非清洗）。
- [x] 1.5 在 `facet/index.js` 挂载：`GET /api/mcp-registry.json`（`{servers:[…]}`）+ `GET /api/mcp-registry/:name.json`（单条，404 沿用 `/api/mcp-catalog/:name` 的不给信息姿态）；`Cache-Control: public, max-age=3600`；挂载点在 `await initFacetMcpCatalog(...)` 之后、静态托管之前（design C5）。
- [x] 1.6 单元测试（design C6 四条）：公开 server 产出合法并过 schema 校验；group-gated 不出现；坏条目跳过其余照出；构造 `sk-` 形状串触发 `PROJECT_REJECTED` 且不写。→ `scripts/test-facet-mcp-registry-json.mjs`，7/7 通过。

## 2. CI 发布（免费上架）

- [x] 2.1 新增 `scripts/publish-mcp-registry.mjs`：取 `GET {facet-url}/api/mcp-registry.json`，逐 server 写 `<out>/<name>/server.json`；`--dry-run` 只写校验；`--publish` 调 `mcp-publisher publish`；last-good 契约照抄 `scripts/export-marketplace-repo.mjs`（design C7）。
- [x] 2.2 新增 GitHub Actions workflow：`permissions: id-token: write` → OIDC 登录 → `mcp-publisher publish`，仅 public 且 `groups=[]` 的 server。**OIDC 是发布到组织 namespace 的唯一免费正路**（交互式 `login github` 发不了组织名，见 design D4）。→ `.github/workflows/mcp-registry-publish.yml`（dry-run 每周一跑，publish 需 `confirm=publish` 手动 dispatch）。
- [x] 2.3 首次上架人工引导：确认执行者为 `FindDataTechnology` Owner（OIDC 通道亦按组织角色授权），并把「本地手工 `login github` 只能发个人名」写进指南，避免误用。→ workflow 头部注释 + `docs/ecosystem/mcp-registry-publishing.md` §5.1。
- [x] 2.4 发布前可见性核对门：确认发布源为 PUBLIC 仓、输出零凭据形状（dry-run 报告）。→ `docs/ecosystem/mcp-registry-publishing.md` §6 五门表；脚本 `validateDoc` 整批校验 + `CREDENTIAL_RE` 兜底。

## 3. 技能市场可索引化（运营/文档，近零代码）

- [x] 3.1 核验 `FindDataTechnology/facet-marketplace` 公开仓形状：`.codebuddy-plugin/marketplace.json` + `plugins/<id>/skills/<n>/SKILL.md` + agents 齐全、`SKILL.md` frontmatter（`name`/`description`）合规。→ 实测：`private:false`，根目录 `.codebuddy-plugin/` + `plugins/`（75 插件目录），SKILL.md 162 个、frontmatter 违规 0。
- [x] 3.2 核验 `fd-mcp-registry` / `fd-vertical-packs` 公开仓的 `.claude/skills/<n>/SKILL.md` 形状可被索引。→ 实测两仓 `private:false`；SKILL.md 分别 18 / 41 个，frontmatter 违规 0。
- [x] 3.3 登记市场地址：skills.sh（`npx skills add FindDataTechnology/facet-marketplace`）/ SkillHub 的可达性实证并记录（判定口径：`npx` 命令能解析到条目即达标，不锚定榜单出现）。→ 本机实测落盘 **152 个技能**，frontmatter 抽查合规；证据写入 `docs/ecosystem/skill-market-registration.md` §3「实证记录」。
- [x] 3.4 若公开仓 `SKILL.md` 有缺 `name`/`description` 的，补齐（这批是内容修整，不动结构）。→ 三仓全量审计 221 个 SKILL.md，**0 处缺失**，无需修整。

## 4. Claude 市场保真度核对（轻）

- [x] 4.1 核验 `.claude-plugin/marketplace.json` 端点：条目含语义化版本、稳定 URL、可被 `/plugin marketplace add <git-url>` 解析。→ `facet/marketplace-json.js:59-70`：条目带 `version: String(p.version)`（pack 真实版本）+ 相对稳定 `source: ./packs/<id>/v<version>`（相对 manifest 目录解析），结构合规。
- [x] 4.2 若版本字段缺失或 URL 不稳，补齐后回归一次端点输出。→ 版本与 URL 均已有来源且稳定，**无需改动**（不改比乱改诚实）。

## 5. 漏斗钩子与文档

- [x] 5.1 registry 条目 `description` 尾部 / 市场 README 引导段加「想 7×24 常驻 → 萬星」文案（不改 manifest 结构字段，见 design D6）。→ 投影器 `FUNNEL_COPY` 拼在 description 尾部（单测断言）；`facet/marketplace-repo.js` `renderReadme` 追加引导段（散文段，manifest 结构零改）。
- [x] 5.2 `docs/ecosystem/` 新增两篇：MCP Registry 上架指南（含 namespace 认领、`mcp-publisher` 用法、schema 版本管理）、技能市场登记指南（skills.sh / SkillHub 形状与边界）。→ `mcp-registry-publishing.md`（9 节）、`skill-market-registration.md`（6 节）。
- [x] 5.3 更新 `docs/ecosystem/client-matrix.md` 与 `docs/facet-market-roadmap.md` 的 F2/F4 口径：新增「MCP Registry 公开发现」「技能市场可索引」两行状态。→ client-matrix 新增「公开发现面（不分客户端）」表两行；roadmap F2 新增切片 F2.4（MCP Registry）/ F2.5（技能市场）。
- [x] 5.4 记录域名验证命名 `cloud.finddatatech/*` 作为后续品牌升级路径（design D4）。→ `mcp-registry-publishing.md` §7（含 apex TXT / OpenSSL 3 / ECDSA P-384 三个实操坑）；`marketplace-landscape.md` §3.4 同步。
- [x] 5.5 明写三条诚实边界：官方 Registry 冻结期 schema 可能变、公开即不可撤回、技能市场收录时间不可控。→ 两篇文档各自的「诚实边界」节（publishing §8 三条；registration §5 三条）。

## 6. 验收

- [x] 6.1 `openspec validate add-marketplace-projection-fanout --strict` 通过。→ 通过（过程中揪出并修掉一处真缺陷：MODIFIED 的 OAuth 需求块漏了两个既有场景，archive 会拒收）。
- [x] 6.2 `openspec validate --specs` 全绿（归档前）。→ **219 passed, 0 failed**。
- [x] 6.3 端到端：至少一条公开 MCP server 成功出现在 MCP Registry（`mcp-publisher publish` 返回成功 + registry API 可查）。→ **达成：registry 收录 14/14，与投影逐条一致（2026-10-31）**。
  - **发布通道**：新建 `FindDataTechnology/mcp-registry-publish`（公开、只放管道）。原因：`workflow_dispatch` 要求 workflow 在默认分支，而主仓 `fd-craw-private` 是 PRIVATE 且该账号私有额度已耗尽（2011/2000，5 秒即红）；公开仓标准 runner 免费无限，OIDC 又按**仓库所属组织**授权命名空间。`scs001` 是 FDT org admin（已核），故可认领 `io.github.FindDataTechnology/*`。
  - **首发 run 41142472745**：OIDC 打通（`✓ Successfully published` × 6），但 8 条被 registry 以 **422 `expected length <= 100`（`body.description`）** 拒收 —— 官方 schema 对 description 有 100 字符上限，design/spec 均漏记，我们的描述原长 92–230 字符 + 漏斗尾缀必然超。
  - **修复（v3 sha-08f4835 / digest f3db9969）**：整条描述共享 100 字符预算——先预留漏斗尾缀，基础描述按**码点**截断（不劈代理对）加省略号。生产 14 条实测全部 ≤100（211→100、230→100、166→100）；单测 9/9（新增超长/恰好边界/0–200 全档/emoji 代理对）。
  - **复跑 run 41143983762**：**8/14 新发布成功**，另 6 条 `duplicate version already exists`（首发已上架，属重复提交非缺陷）。累计 **registry 收录 14/14**。该 run 报 failure 是脚本缺陷=重复版本被误计为失败——已修（`already exists|duplicate version` → 已在名录幂等跳过，paas `e1703363`/roll/publish 仓 `ee971ce` 三处同步），验证 run **41145036723 绿**（`✓ 发布完成：新发 0、已在名录 14（共 14）`，registry 状态不变）。
  - **registry 侧取证**：`curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.FindDataTechnology&limit=50"` → 14 条；逐条核对 **description 超 100 字符 = 0**、`version=0.0.1`、`remotes[0].url` 全为 `https://mcp.finddatatech.cloud/<server>/mcp`。
  - **遗留（运营判断，非代码缺口）**：`fd-wire-cell-drillcust001/pgauto001/wiretester2` 三条测试 cell 已在公共目录中（描述 "managed by cell-manager"）；若不该公开需在 registry 侧停用。另 7 条内网 server 已在投影层被丢弃，若希望它们也被发现，需在 registry 源侧把注册地址改成公网网关。
- [x] 6.4 端到端：`npx skills add FindDataTechnology/facet-marketplace`（或等价）能解析到至少一个技能的实证记录。→ 实测落盘 **152 个技能**，抽查 frontmatter 完整；记录见 `docs/ecosystem/skill-market-registration.md` §3。
