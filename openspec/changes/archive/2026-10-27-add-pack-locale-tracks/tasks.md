# Tasks: add-pack-locale-tracks

> 对应 spec:pack-locale-tracks(新)/ pack-marketplace / agent-fleet-templates(delta)。
> 设计依据:design.md D1–D6。需求书:docs/pack-i18n-requirements.md。

## 1. 形状与校验器(A/D · lib 层)

- [x] 1.1 `lib/pack-manifest.js` 增 `i18n` overlay 校验段:locale 键形(`/^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/` 且 ≠zh)、白名单键、数组索引越界与未声明命名实体拒绝、逐 locale 长度帽(复用 PACK_LIMITS 同常数)、guide.steps 整组一致性;报错沿 `fail(errors, msg, entry)` 逐字段点名(`i18n.en.guide.steps[1].title` 形制)。验证:新增单测逐条覆盖 spec pack-locale-tracks R1 各 scenario + pack-marketplace R1 各 scenario,全绿且既有单测零改动
- [x] 1.2 长文比率门(description、guide.steps[].body,双向 ≤3:1,短字段豁免)。验证:spec pack-marketplace R2「长度比率越界被拒/短字段豁免」scenario 测试通过
- [x] 1.3 en 副轨禁辞扫描:从 finddata `docs/marketing/audit.py:131` 移植 ABSOLUTE_CLAIM_RE(注释互链两仓路径),对 `i18n` 块全部英文字符串施扫,zh 基字段不扫。验证:spec pack-marketplace R2「en 绝对化表述被拦」scenario 测试通过;zh 同文案不误报
- [x] 1.4 既有纯字符串 manifest 回归:含 bots/serving/cluster/facade 的现存 fixtures 不加 `i18n` 全量复跑。验证:pack-manifest 既有测试套件逐字节等结论(零新增错误)

## 2. 解析模块与读面投影(B · gateway/cell)

- [x] 2.1 新增 `lib/pack-locale.js` 零依赖 leaf:`resolveLocale`(`?locale=` > `Accept-Language` 首项 > zh,`zh*` 归一)、`pickLocalized`、`projectManifestForLocale`(基字段被覆盖、`i18n` 原块随行透传)。验证:模块单测覆盖 spec pack-locale-tracks R2 各 scenario(命中/未覆盖回落/无参等价/逐键回落)
- [x] 2.2 `gateway/packs.js`:`summaryOf()` 与详情投影接 locale 解析(冗余列继续写 zh,读时覆盖);列表/详情端点接受 `locale` 查询参数 + Accept-Language。验证:gateway 邻域测试——双语条目列表行按 locale 呈现、无 locale 响应字节等价(spec pack-marketplace R3)
- [x] 2.3 cell 读面 `server/routes/packs.js` mypacks 安装包列表同接 `projectManifestForLocale`。验证:cell 侧测试——壹座「设置→能力包」数据源按 locale 呈现且缺省回落 zh
- [x] 2.4 搜索面确认:`search`/`tag` 参数仍在 zh 冗余列,带 locale 不扩检索域。验证:带 `locale=en&search=<英文>` 的集成测试断言检索行为与无参一致

## 3. fleet 模板显示字段(C)

- [x] 3.1 `server/fleet-template.js`:`fleet.i18n` 形状门(ref/槽位 key 必须存在、值非空、长度帽),`nameKey/titleKey/labelKey` 机制不动;`exportFleetToTemplate` 行为确认(导出即 zh 基字段、无 overlay)。验证:spec agent-fleet-templates R1 各 scenario 测试通过(含 promptTemplate 注入被拒、旧模板零改动)
- [x] 3.2 模板展示投影接入:安装对话框/模板详情数据源经 `projectManifestForLocale` 解析 fleet.i18n(成员级逐项回落)。验证:双语模板以 locale=en 展示,覆盖项英文、未覆盖项 zh

## 4. 客户端类型与呈现(B · web/谦面界面)

- [x] 4.1 `web/src/lib/packs-api.ts` 类型面加 `i18n` 可选块;市场卡片/详情改传 `locale=<当前 UI locale>`(自行回落逻辑一行不写)。验证:typecheck 绿;zh-CN 与 en 界面下市场页与详情弹窗显示对应语言,ja(未覆盖)回落中文
- [x] 4.2 PackDetailDialog 既有「pack 内容为 zh」注释更新为新口径。验证:代码走查注释与行为一致
- [x] 4.3 谦面市场页:确认服务端默认 zh 对谦面现请求透明(零改动),并在谦面侧留 `?locale=` 接法注记。验证:谦面市场页现状回归(无需出片)

## 5. 铸造工具链与跨仓工件(D/E)

- [x] 5.1 facet-pack-builder `validate_manifest.py` mirror 段镜像新规则(lockstep 注释纪律;真校验器经 shell 自动获得)。验证:`--mirror` 与真校验器对同批合法/非法 overlay manifest 结论逐条一致
- [x] 5.2 `publish_pack.py` 透传确认(预期零改动)+ README/skill 文档补 overlay 写法样例。验证:一份双语 manifest 经 publish_pack.py dry-run 通过
- [x] 5.3 fleet-packs 仓 `blueprints/schema.md` 扩 `vertical.name/tagline`、`boards[].title`、`fleet.i18n` 同构约定段。验证:文档合入且与 D5 形状逐字段对表
> 5.4 挂账说明（用户 2026-10-27 裁决）：改名内容批**已由另一个 proposal 承担**（finddata 侧
> 改名线），本变更交付**形状与闸门**即算完成。该改名批**未带 en 副轨**——en 副轨内容作者编辑
> 由用户后续**另开新需求**处理，不并入本变更。故 5.4 保持未勾并随本变更归档为交接记录。

- [ ] 5.4 存量改名录入(E):八舰集群模板 + 六共用包新显示名按本形状录入(zh 主轨先行,en 副轨随作者批),与 `cluster-vocabulary-and-pack-taxonomy` 同一编辑批不造两轮。验证:每个包 validate 全绿;市场端 zh 显示名更新、无 locale 客户端显示新名

## 6. 收尾与验收

- [x] 6.1 验收四口径对表:兼容性(旧客户端逐字节等价)、渲染正确性(zh/en/ja 三 locale)、发布门三类报错(缺结构/比率/禁辞各一可读报错)、禁辞同扫(en 命中被拦)——逐一以真机或集成测试留证
- [x] 6.2 台账 docs/registry-maintenance.md 发布记录更新;姊妹单(vendor-supply-open 等)对表注记:供给开放批次的 manifest 可直接按本形状录入。验证:台账条目落 §15 最新节
> 6.3 注记：`validate --strict` 绿、三个规格 sync 入主 spec 并各自 `--type spec --strict` 绿，
> 2026-10-27 用户点名归档（5.4 已改判交他单/后续新需求，见上）。

- [x] 6.3 `openspec validate add-pack-locale-tracks --strict` 绿后归档。验证:validate --strict 与 archive 干跑零报错
