# 永忆（YongYi）公网上线需求文档

> 交付对象：雷池（SafeLine）机器（公网 103.236.89.212）上的运维 AI。
> 状态：定稿（2026-10-27 属主拍板：双域分工照执行、暂不加 CDN）。执行侧如有疑问按本文档优先。
> 日期：2026-10-27。
> **真源迁移（2026-10-29）**：本文原存 fd-memory 公开仓 `docs/site-deploy-requirements.md`，因含内网拓扑
> （NodePort/tailnet/DNS 细节）已从公开仓与公开历史中摘除；本仓（私有）为唯一真源。
> 公开面换版请按文末「九、2026-10-29 脱敏换版补给单」执行。

## 一、目标与域名分工

| 域名 | 角色 | 上游 |
|---|---|---|
| `yongyi.finddatatech.cloud` | **项目官网（纯静态）**，无构建、无动态接口 | 雷池机器本地静态目录（Caddy `file_server`） |
| `memory.finddatatech.cloud` | **双面**：人类入口落地页（`/` 及一切非 API 路径，中英双语，含回官网按钮）+ **API 面**（`/healthz` `/digest` `/mcp` 反代） | 静态目录 + cheap k8s 集群 NodePort **31899**（fd-memory 服务，已在产） |

> 说明：这个域名会被海外客户直接打开。裸的 API 端点对人不友好，所以根路径必须给人看的落地面（讲清「本域是 API 端点」并一键回官网），API 路径才走反代。

双域分工经属主 2026-10-27 确认执行（memory 须有可跳官网的人类入口，面向海外客户）。

## 二、现有边界事实（沿用贵侧已验证的拓扑）

- 贵侧现网链路：公网 443（雷池 safeline-tengine）→ 本机 Caddy（:8080，每域一块）→ 各后端（tailnet 内网地址/端口）。`platform/mcp/wanxing/lex.finddatatech.cloud` 等均已按此模式在产。
- DNS：`finddatatech.cloud` 在 DNSPod 托管（NS=francis/zara.dnspod.net）。**新增两条 A 记录由属主在 DNSPod 完成**（不在本文档执行范围）：
  - `memory.finddatatech.cloud → 103.236.89.212`
  - `yongyi.finddatatech.cloud → 103.236.89.212`
  - 建议 TTL 先设 600s，稳定后可调回。
- 证书：两域名各自签发/沿用贵侧现 Let's Encrypt 流程（DNS 生效后申请）。证书按贵侧既有流程办理即可。

## 三、部署任务

### A. `yongyi.finddatatech.cloud` —— 官网静态站

**资产**：官网三个文件 + 落地页一个文件，全部无构建产物、无第三方图片。
- 官网：`site/index.html`、`site/style.css`、`site/script.js`
- 落地页：`site/memory-landing/index.html`（单文件自足，CSS 内联、不依赖外部字体请求，海外首屏快）
- 来源：git 仓 `github.com/FindDataTechnology/fd-memory`（master 分支）`site/`；
- 或直接用随本文档打包的 `yongyi-deploy.tar.gz`（解开得到 `yongyi/` 三文件 + `memory/` 一个文件）。

**要求**：
1. 部署到本地静态目录，如 `/srv/yongyi-site/`；
2. Caddy 新增站点块（示意）：

```
yongyi.finddatatech.cloud {
  root * /srv/yongyi-site
  encode gzip
  file_server
  header /index.html Cache-Control "no-cache"
  header /*.css Cache-Control "public, max-age=604800"
  header /*.js  Cache-Control "public, max-age=604800"
}
```

3. 雷池控制台为 `yongyi.finddatatech.cloud` 建站点（site），来源指本机 Caddy 对应块（与现有各域同模式）；
4. 页面外部依赖只有 Google Fonts（`fonts.googleapis.com`，Noto Serif SC + IBM Plex Mono），加载失败自动回落本机宋体/等宽，**无需任何代理或镜像处理**；
5. HTTP → HTTPS 301；404 回落 `index.html` 均可（单页站点，无路由）。

### B. `memory.finddatatech.cloud` —— 落地页 + API 反代（双面）

**上游**：k8s Service `fd-prod/fd-memory`，NodePort **31899**（已在产，federation 线此前走 tailnet 直投，现补公网入口）。按贵侧既有反代地址习惯选任一节点 tailnet IP:31899（如 `100.64.0.x:31899`）。容器绑定 `0.0.0.0:49375`，readiness/liveness 均探 `/healthz`。

**路由规则（先判 API 路径，其余全部落地面）**：

| 路径 | 行为 |
|---|---|
| `/healthz`（GET） | 反代 → 31899（服务公开只读探针） |
| `/digest`（GET） | 反代 → 31899（平台接缝读面，Bearer 鉴权） |
| `/mcp`（POST） | 反代 → 31899（MCP streamable-http 主面，Bearer 鉴权） |
| `/capture` | 边缘 404（本地节点联邦车道，公网不开） |
| `/admin/*`（mint/metrics/reindex/report） | 边缘 404（令牌铸造/运维面，仅留 tailnet；即使服务侧也有鉴权，边缘必须封） |
| 其它一切路径（含 `/`、`/robots.txt`、任意深链） | 落地面静态文件 `try_files {path} /index.html` |

Caddy 示意（`/mcp` 与 `/digest` 必须带流式参数，贵侧 site 31/21 的 custom_location 先例同源）：

```
memory.finddatatech.cloud {
  @blocked path /admin/* /capture
  respond @blocked 404
  @api path /healthz /digest /mcp
  handle @api {
    reverse_proxy 100.64.0.x:31899 {
      flush_interval -1   # 流式：MCP/SSE 帧不能被攒包
    }
  }
  handle {
    root * /srv/yongyi-memory-landing
    try_files {path} /index.html
    file_server
    header /index.html Cache-Control "no-cache"
  }
}
```

雷池 site 层面：若贵侧惯例是经 `PUT /api/open/site/{id}/nginx_config` 注入 `proxy_buffering off; proxy_request_buffering off; proxy_send_timeout 600s;`（site 31 先例），新站同样注入——**否则 streamable-http 的 JSON-RPC 流帧会复现 2026-10-21 的攒包事故**。

**其他**：
- 请求体上限建议 ≥ 8 MB（MCP 工具调用含长笔记正文）；
- 速率限制：`/digest`、`/mcp` 建议 per-IP 60 req/min 起步（观测后再调）；`/healthz` 与落地面不计；
- WAF 走默认强度即可；若出现 403 且服务侧日志未见请求，先查雷池内容规则（pack manifest 曾被 WAF 重置是已知先例，本服务 `/mcp` 大文本正文同理可能触发，必要时对该站放宽 body 规则并记录）。

### C. 海外客户访问（已拍板 2026-10-27：暂不加 CDN，直连现状）

属主决定先直连 `103.236.89.212` 观测。上线后用海外节点 curl 官网首页与 `/healthz` 各一次记录首字节延迟；若后续 >1.5s 再考虑挂腾讯 EdgeOne（`www.finddatatech.cloud` 已有现成先例，CNAME 接入即可，源站不变；届时 `memory` 域的 API 路径需确认 CDN 侧不启用压缩/缓冲）。

页面本身无境外专用依赖：落地页完全自足（不请求外部字体）；官网页仅引 Google Fonts（`fonts.googleapis.com`），失败自动回落系统宋体/等宽，无需处理。

## 四、上线前置条件（我方/属主侧）

1. **仓库可见性**：✅ 已解决（2026-10-27）——`github.com/FindDataTechnology/fd-memory` 已开为 **public**。开仓前完成：gitleaks 全历史扫描无泄漏 + eval 夹具去平台化清洗（371+ 处内部叙述通用化）+ `git filter-repo` 摘除夹具旧版全历史 + 强推重写。官网 4 处 GitHub 链接现均可达。
2. **npm 包**：✅ 已发布（2026-10-27）——**`@finddatatechnology/yongyi@0.2.0`**（发布组织跟属主 npm 账户 `finddatatechnology`，非 dsh 域的 `@deepseek-ai` 误植名；发包件 30 文件 78.6kB + bin shebang + repository/license 元数据；单测 74/74 绿）。`npm i @finddatatechnology/yongyi` 实测可装、`yongyi --help` 可跑。发布走 bypass-2FA GAT（属主 ego browser 会话现生成，7 天期仅授本 scope）；首次直发有 ~5 分钟 0.0.0-stage 处理窗（安全扫描）后转正。
3. 上线后按第五节逐项验证。

## 五、验证清单（上线后逐项过）

```bash
# 1. 官网
curl -sI https://yongyi.finddatatech.cloud/ | head -1          # 期望 200
curl -s https://yongyi.finddatatech.cloud/ | grep -c "永忆"     # 期望 >0
# 2. memory 人类入口（根路径必须是落地页，不是 401）
curl -s https://memory.finddatatech.cloud/ | grep -c "yongyi.finddatatech.cloud"  # 期望 >0（回官网链接在）
curl -s -o /dev/null -w '%{http_code}' https://memory.finddatatech.cloud/         # 期望 200
curl -s -o /dev/null -w '%{http_code}' https://memory.finddatatech.cloud/whatever  # 期望 200（落入落地页）
# 3. 服务健康
curl -s https://memory.finddatatech.cloud/healthz               # 期望 200 JSON
# 4. 鉴权面结构正确
curl -s -o /dev/null -w '%{http_code}' https://memory.finddatatech.cloud/digest  # 期望 401
# 5. 管理/联邦面边缘封禁
curl -s -o /dev/null -w '%{http_code}' https://memory.finddatatech.cloud/admin/mint   # 期望 404
curl -s -o /dev/null -w '%{http_code}' -X POST https://memory.finddatatech.cloud/capture  # 期望 404
# 6. 流式不攒包（持一个有效 person/platform 令牌时）
curl -sN -X POST https://memory.finddatatech.cloud/mcp -H 'Authorization: Bearer <tok>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
# 期望：秒级返回 initialize 结果（首帧延迟 <2s 即合格）
```

## 六、回滚

- DNS：删除两条 A 记录即全断（TTL 600s 内收敛）；
- 雷池/Caddy：移除两个站点条目，不影响既有各域；
- 服务侧：无需任何动作（NodePort 31899 早已在产，公网入口撤除即回到 tailnet-only 现状）。

## 七、我方可继续的后续项（不属于本文档执行范围）

1. 官网「5 分钟起跑」段落现写本地 bootstrap；公网面验证通过后可改为演示 `https://memory.finddatatech.cloud` 的 curl 链；
2. README 补 `memory.finddatatech.cloud` 作为 hosted endpoint（等公网面稳定后再写）；
3. PORTS.md 台账 31899 行已补录（2026-10-27，本项已闭环）。

## 八、补给单：用真站替换占位页（2026-10-28 追加）

**现状核对（属主已实测，贵的部分你已做对，保持不动）**：两域 DNS/TLS 正常；`memory` 域路径门全部正确——`/healthz` 200、`/admin/mint` 404、`/capture` 404、`/digest` 无凭据 401。**只需替换静态文件**：`yongyi` 域现为占位页，`memory` 域根路径现为你自写的页面（紫色 accent，非官方设计语言）。之前拿不到文件是因为资产包在属主本机且仓库当时私有；**仓库现已公开，直接从 raw 拉取即可**。

### 替换 `yongyi.finddatatech.cloud`（官网，三文件同目录）

```
https://raw.githubusercontent.com/FindDataTechnology/fd-memory/master/site/index.html   # sha256 前16: bf0596e9b58030e3
https://raw.githubusercontent.com/FindDataTechnology/fd-memory/master/site/style.css    # sha256 前16: 6ea63c59c5f36400
https://raw.githubusercontent.com/FindDataTechnology/fd-memory/master/site/script.js    # sha256 前16: 3af351dd84e40621
```

- 三文件放同一站点根目录（`index.html` 以相对路径引 `./style.css` `./script.js`，勿改动目录关系）；
- 无构建、无外部图片；`index.html` 引 Google Fonts，失败自动回落本机字体，不需处理；
- `Cache-Control`：`index.html` no-cache，css/js 可 7 天。

### 替换 `memory.finddatatech.cloud` 根路径落地页（单文件）

```
https://raw.githubusercontent.com/FindDataTechnology/fd-memory/master/site/memory-landing/index.html   # sha256 前16: 79e399d6ab893a28
```

- **API 反代与路径门规则全部保持现状不动**，只换静态面：非 API 路径 `try_files {path} /index.html` 落到此文件；
- 该页链接指向 `https://yongyi.finddatatech.cloud/` 与 `#start`，换完与官网同世代表里一致。

### 替换后验证

```bash
curl -s https://yongyi.finddatatech.cloud/ | grep -c "会话会结束"        # 期望 >0（真站标题）
curl -s https://yongyi.finddatatech.cloud/style.css | grep -c "070c17"   # 期望 >0（世界 token）
curl -s https://memory.finddatatech.cloud/ | grep -c "ENDPOINTS"          # 期望 >0（官方落地页面板）
curl -s https://memory.finddatatech.cloud/healthz                          # 仍须 200
curl -s -o /dev/null -w '%{http_code}' https://memory.finddatatech.cloud/admin/mint   # 仍须 404
```
### D. digest 预算分表（add-unified-memory-and-outputs v1 默认值）

统一读缝后 prompt 预算按来源切分（`FD_MEMORY_DIGEST_*` 可调；默认见下）：

| 来源 | 上限 | 说明 |
|---|---|---|
| 待认领交接 | 3 条 × 100 字 gist | 最先花预算（可执行优先） |
| 名份引用（reference） | ≤3 条 × 120 字 | canonical → stable →（仅 query 命中的）draft |
| L2 事实/经验 | k≤8 条 × 150 字 | 向量+关键词混合车道 |
| L1 笔记 | ≤5 条（匹配 3 + 近端补） | 每条 ≤100 字 |
| 总预算 | 1500 tokens（硬顶） | 手替：`budget` 参数 ≤2000 |

## 九、2026-10-29 脱敏换版补给单（替换现网旧版官网文件）

**背景**：2026-10-29 公开面脱敏——官网「接替演示」原引用了内部节点名与部署变更史（属违规内容），
公开仓与 GitHub 历史均已清洗。现网 `yongyi` 域静态目录里还是**清洗前旧版**，需按下表换两件。

**只换两件**（`style.css`、`memory-landing/index.html` 内容未变，不必动）：

```
https://raw.githubusercontent.com/FindDataTechnology/fd-memory/master/site/index.html   # sha256 前16: fff0dfb53400ef29
https://raw.githubusercontent.com/FindDataTechnology/fd-memory/master/site/script.js    # sha256 前16: c23f06542e79c787
```

（未动的两件现值备查：style.css `6ea63c59c5f36400`，landing `79e399d6ab893a28`。）

换完验证（旧版残留判据 + 新版在位判据）：

```bash
curl -s https://yongyi.finddatatech.cloud/ | grep -c "cheap"          # 期望 0（旧演示已无）
curl -s https://yongyi.finddatatech.cloud/ | grep -c "示例 evidence"   # 期望 >0（新演示在位）
curl -s https://yongyi.finddatatech.cloud/ | grep -c "DEPLOYMENT.md"  # 期望 >0（页脚部署教程链接）
curl -s https://yongyi.finddatatech.cloud/script.js | grep -c "node-b" # 期望 >0
curl -s https://memory.finddatatech.cloud/healthz                       # 仍须 200
```

其余一切（路径门、反代、缓存策略）保持 §八 原样。

### 执行记录（2026-10-29，雷池侧完成）

- **换版完成，公网验证全绿**：`/` 含 cheap=0、示例 evidence/部署教程/node-b/会话会结束 全部在位；
  healthz 200、digest 401、admin/mint 404、capture 404 无回归；公网响应体 sha256 与工单逐位一致
  （index `fff0dfb53400ef29` / script `c23f06542e79c787`；style `6ea63c59c5f36400`、landing `79e399d6ab893a28` 未动），
  边缘无旧缓存残留。旧版留档 `index.html.bak-precompliance-20261029` / `script.js.bak-precompliance-20261029`。
- **拉取通道教训**：`raw.githubusercontent.com` 在雷池机与 cheap1 均不通（SSL 连接被重置）。
  等价路径= `codeload.github.com/FindDataTechnology/fd-memory/tar.gz/refs/heads/master` 拉整仓取 `site/` 下同名文件，
  内容同世代、sha256 逐位核对一致。**后续本域补给单一律以 codeload 整包为默认通道**，raw 列为备用。
- diff 为纯文案级（index 7/249 行、script 2/205 行），外部资源引用仅多出工单预期的 DEPLOYMENT.md 一条，
  无结构性差异——工单第四/五节的核对纪律有效，照此执行。
