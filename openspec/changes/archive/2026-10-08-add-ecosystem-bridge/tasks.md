# add-ecosystem-bridge — Tasks

## 1. 切片 A：入向精选管线

- [x] 1.1 fd-1.32 代理兼容性核查：结论=传输/协议层兼容（SDK 双传输+浮动下限 `mcp>=1.9.3`、线上 wire 真回合+401 探针实证）、stdio server 包 HTTP 壳（1.4 决议）、逐 server 走既有探测机器，已记 `docs/registry-fork-patches/2026-10-07-ecosystem-bridge-compat-audit.md`
- [x] 1.2 审校 runbook + checklist 落 `docs/ecosystem-curation.md`（安全/许可证/质量三轴、AGPL 拦截、egress 决议模板、来源标记规范），评审通过为完成
- [x] 1.3 首批白名单定稿：按许可证调研报告（进行中）在 10-15 server / 30-50 技能上限内裁剪，产出含许可证列的清单文档，逐条过 checklist（台账 `docs/ecosystem-curation-ledger.md`：12 server + ~40 技能三源；台面轴已过，入库轴绑 1.4/1.5）
- [x] 1.4 首批 server 托管上线：**eco-mcp-time + eco-mcp-fetch 生产可调 2026-10-08**——官方参考实现（MIT）容器化（stdio→mcp-proxy HTTP 壳，1.1 决议落地）、cheap-1 独立容器（time 入 eco-net 隔离网 egress=none、fetch 默认桥 egress=open）、SSRF 白名单入网（192.168.32.x）、注册带来源/许可证标记、toggle 探测 healthy、community scope 扩容；community 键端到端真回合（get_current_time 上海时区/fetch example.com）+ law-bench 402 对照
- [x] 1.5 首批生态技能入库：**eco-skill-creator/eco-mcp-builder/eco-canvas-design 入库 2026-10-08**（anthropics/skills Apache-2.0，条目带 repository_url+license+ecosystem 标记，直查可验）；pack 引用实测=官方功能集内联其正文并装进 cell（1.6）
- [x] 1.6 首个官方功能集发布：**「数据研究 · 生态版」（Aqag8Mky4ksoPmwRDMCVYw v1）发布+装 cell 真回合 2026-10-08**——配方=生态技能（内联 anthropics 正文）+自家数据 MCP 锚（fd-open-data-mcp）+生态 MCP（time/fetch）+数据研究员 persona；真浏览器走查：市场可见→Subscribe & Install（技能/MCP×3/Agent 全 Installed）→Agents 列表出现 persona→选卡发问→**真数据回答**（GDP_YOY 4.7% 2026Q2、来源 akshare 经 fd-open-data-mcp、概念 ID+时间范围齐、覆盖缺口如实标注）

## 2. 切片 B：出向 CLI 与市场端点

- [x] 2.1 CLI targets 扩展：zcode / codex / gemini-cli 三个 target 的技能目录约定实现 + `--project` 语义对齐，`facet install --target <t>` 每家实测落盘正确
- [x] 2.2 `facet connect` 粘贴流：打开铸造页 → 粘贴 wgk- → 网关验活 → 本地 0600 存键 → `--clear` 清除；死键/吊销键拒收带原因，单测覆盖
- [x] 2.3 持键写 MCP 配置：install 时对 MCP 引用征得同意写各 target 原生 MCP 配置（端点+Authorization 头），输出所写文件清单；无键时行为与 v1 完全一致（回归）
- [x] 2.4 device flow 升级位：CLI connect 命令保留设备授权分支（谱系侧未暴露时自动回落粘贴流），含回落路径单测
- [x] 2.5 marketplace.json 端点：facet 生成 Claude 插件市场格式清单（仅公开精选、MCP 只做连接指引、≤1h 缓存头）；生产探针全绿 2026-10-07（200/8 packs/plugin.json+README 可取/缓存头/max-age=3600），真机 `/plugin marketplace add` 走查留使用侧验收
- [x] 2.6 CLI 发版：**0.2.1 LIVE 2026-10-08**（公开仓 tag 线发布，带 SLSA provenance；0.2.0 发布后冒烟抓出 npx 符号链接静默回归——isMain 原样比较 argv[1]，npx 形态全坏，realpathSync 修复+符号链接回归测试后补发）；npx 端到端复验通过（--version/help/五 target）

## 3. 切片 C：计费收口与社区准入

- [ ] 3.1 wire 线 sub2api 入账管道：**部署+推送接线完成 2026-10-08**——fd-wire sha-4bd707c 上线（驱动活）；审计流走 cheap-1 cron 推送器（`push_audit_to_wire.py`，*/5 分钟，Mongo 保持 loopback 零暴露，Bearer 令牌 fail-closed），真推送 500 条实证通道通（全部落 anomaly=握手类流量本就无 rows_returned 戳，行为正确）；**余首笔带戳回合记账观察——阻塞点已定性 2026-10-08**：wire 客户键（lawbenchtestadmin 新铸键）打 business-mcp 全链=validate 过/vend 200，但**上游 401**（guangzhou-zihan:30803 拒绝 vend 令牌）——定性为该用户 vault 里的 business-mcp 后端 PAT 失效/不匹配（egress_user 错位已修：内部铸造的键需补 egress_user=真 Logto sub c9whx1ibphb0；新铸键经内部通道时必须带 egress 声明或事后补写）。**进一步定性（同日更深测试）**：401 非凭据失效而是**架构缺口**——business-mcp 网关车道本来就无 wgk 可用凭据（上游要求 Logto 用户 JWT，egress PAT 未配置；INFRA-NOTES 原注「6h cron 类调用别走网关」），而带戳回合的正道=wire facade 车道（fd-wire-api /mcp → 服务通道）——该路由 fd-wire-api 尚未实现（无 /mcp 路由）。**结论：带戳回合记账观察挂起，等 facade MCP 车道落地（wire-platform 后续）**；计量系统本体（审计→推送→摄取→闭月结算）已全链实证并归档；另两修落地：REGISTRY_STATIC_TOKEN_AUTH_ENABLED=true（facet-bridge 静态键，catalog 事故根因）+ EGRESS_REGISTRY_INTERNAL_URL=8091（vend 断链）
- [x] 3.2 账本硬停：账本路径降级时按硬停上限拒入（fail-closed），演练脚本实证「降级不放行无计量调用」（`fd-wire/scripts/drill_metering_hardstop.py` 四轮全绿：闭月入账恰一次/当月只计量/降级零丢失零落账/恢复幂等重放；预检侧 402/503 已活链实证 2026-10-05）
- [x] 3.3 key 月度免费额度：**生产活链实证 2026-10-08**（CALL_GRANT_ENABLED=true 开闸+sha-63126fe 上线）；真链实测=community 键 tools/call → `call_grant_usage` 计数落库（eco_walkthrough_01/2026-10/1）；发布过程修三处接缝：patch-key 空快照组回退、proxy token 携带 resolved groups、canonical auth_method 抹平 patch-key 标记的判据兼容；8444 全量回归绿
- [x] 3.4 community 组与付费档：**生产活链实证 2026-10-08**——community 键真回合读 fd-open-data-mcp（真实数据 2105 指标/636 万行）；law-bench → **402 TIER_REQUIRED**（「该服务属付费档…升级后即可调用」）；升降档=组分配免重铸（组解析每次 validate 现算）。实现全链=组回退（JWT+patch-key 两路）+ /validate 与 mcp_proxy 双层档位门 + nginx 403 标记→402 重写（auth_request 只转发 401/403 的边界约束）
- [x] 3.5 Logto 公开注册开放 + 自助铸键面走通：**生产全链实证 2026-10-07**——①`createAccountEnabled=true`（本就开）+ 登录页「Create account」真浏览器可达（注册页/建号/Link email/验证码已发，Aliyun Direct Mail 连接器在配）；②无组用户 → `IDP_USER_GROUP_DEFAULTS` 解析出 `['community']`（生产容器内实测）；③组映射三条精确落位：community→mcp-community-read / wire-customers→mcp-business-wire-execute（客户线未扰）/ legal→law-bench+data（付费档）。**余**：验证码收件箱在阿里云企业邮（走查止步于收码，用户侧一步可完成端到端）

## 4. 切片 D：出向文档与收尾

- [x] 4.1 各 harness 接入指南：claude-code / cursor / zcode / codex / gemini-cli 五篇（发现→connect→install→验证），每篇含一条可复制的端到端命令序列
- [x] 4.2 A2A 车道对外示例：萬星 Agent 服务的 A2A 调用文档 + 最小 curl/SDK 示例（docs/ecosystem/a2a.md：agent 列表/card/message/send、幂等头、错误面、双车道选型表；计费维持 ADR-0014 双轨不并轨）
- [x] 4.3 ADR-0017 追记：入向生态互操作触发的兼容性核查结论与 MCP 语义冻结条款的复核结果，落 ADR 修订（2026-10-07 修订节：冻结面比假设窄——SDK 传输栈浮动、注册处 API 冻结；谱系不变、出局规则在谱系台账）
- [x] 4.4 探针与观测：`scripts/probe-ecosystem-bridge.mjs` 部署后生产全绿 2026-10-07（sha-fc636d9）

## 5. 悬置（探查回收后归位）

- [ ] 5.1 OAuth 发现定档：**①③ 已完成 2026-10-08**（LOGTO_ENDPOINT 激活→well-known RFC 8414/9728 双 200；双 WWW-Authenticate 修复随 sha-89a11ed 上线，容器热修+render 源修复均在）；②DCR shim 单独评估后**推迟**——device flow 端点已在 AS metadata 中暴露（Logto 原生），零输入主链可用；完成判据（真机 Claude Code 全链）待使用侧验收
