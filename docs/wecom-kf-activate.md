# 微信客服（kf）sidecar · 部署与激活

面向：客户企业的管理后台管理员 + 一台服务器（**出口 IP 可控**）。
目标：在客户自己的环境里，把「微信里用户来咨询」的会话完整落到本地，数据不出客户边界。

本文只写客户需要做的事。软件内部怎么判、怎么重试，见
`openspec/changes/add-wecom-kf-ingest/`。

---

## 0. 先确认一件事：这条通道是不是你要的

微信客服（官方名：**微信客服**，接口前缀 `cgi-bin/kf`）的能力与代价：

| | 事实 |
|---|---|
| 拿得到 | 客户在**微信里**给客服账号发来的全部消息（文本/图片/语音/视频/文件/菜单），以及进入会话、会话结束、撤回、接待人员变更等系统事件 |
| 拿不到 | 员工之间的聊天（那是另一条通道） |
| 保留 | 腾讯只保留 **3 天**。拉取器停 3 天以上，那段就是**永久丢失**，不可补 |
| 回复窗口 | 只能回复**客户最后一条消息之后 48 小时内**的会话；超时只能等客户再来 |
| 费用 | 不按席位收费（与会话存档不同），但**企业未认证时累计仅可接待 100 位客户** |
| 前提 | 自建应用必须被加进「微信客服 → 可调用接口的应用」；**接待人员必须在该应用可见范围内** |
| 出口 IP | **必须有固定出口 IP，并加入「企业可信 IP」**。见 §1.3，这是最容易踩的一条 |
| 数据归属 | 数据落在客户自己的机器上，我方不承接数据处理者身份 |

如果上面有任一条不符合你的预期，**先别部署**——尤其「保留 3 天」和「必须有可信 IP」，
它们是这个产品形态的硬约束，不是配置项。

---

## 1. 后台三件配置（都在企业微信管理后台）

### 1.1 把自建应用选为「可调用接口的应用」

「应用管理 → 微信客服 → 可调用接口的应用」里加上你的自建应用。
**没加会返回 `errcode=48002`（api forbidden），表现为「secret 明明是对的却调不通」。**

注意：在这个页面上勾选后，弹「设置成功」的 toast **不等于真的保存成功**。
判据是重新打开页面，客服账号那一行显示「正通过自建应用管理此账号」。以页面状态为准，不以提示为准。

### 1.2 拿到真正的 `open_kfid`

**后台页面上的那串数字不是 `open_kfid`。** 把后台显示的「客服账号 ID」
（形如 `25620181794725350`）传给接口会直接返回 `errcode=95000 invalid open_kfid`。

真值必须从接口取：

```bash
# 用你的 corpid/secret 换 token 后
curl -s "https://qyapi.weixin.qq.com/cgi-bin/kf/account/list?access_token=$TOKEN" \
  -H 'content-type: application/json' -d '{"offset":0,"limit":100}'
```

返回的 `account_list[].open_kfid`（形如 `wkqmGucgAAlOx0IPWASY_zpufMyzYDyg`）才是。
只有一个客服账号时也可以不配，软件会自动采用；多个账号时必须显式指定。

### 1.3 企业可信 IP（必做）

「应用管理 → 你的自建应用 → 企业可信 IP」里加入**这台服务器的出口 IP**。

三个必须知道的事实：

1. `gettoken` **不受** IP 限制，所以「能取到 access_token」不代表「能调业务接口」。
2. 业务接口从非白名单 IP 调用会返回 `errcode=60020 not allow to access from your ip`，
   errmsg 里带着实际出口 IP，拿去加白名单即可。
3. 部署机换机房/换 NAT 就会失效。**这条决定了这条通道能部署在哪台机器上**，
   部署前先用下面的命令确认出口 IP 与后台白名单一致：

```bash
curl -s https://ifconfig.me/ip     # 与后台「企业可信 IP」逐字比对
```

---

## 2. 环境变量一览

| 变量 | 必填 | 说明 |
|---|---|---|
| `KF_SYNC_ENABLED` | 自动拉取时必填 | 只认字面 `1`。不填则通道静默不启动（不报错、不建库） |
| `KF_CORPID` | 是 | 企业 ID |
| `KF_SECRET` | 是 | 自建应用的 Secret（**不是**通讯录 Secret）。只从环境注入，不要写进命令行或提交 |
| `KF_OPEN_KFID` | 建议填 | 客服账号 `open_kfid`，取自 §1.2。留空则自动解析（多账号会明确报错） |
| `KF_DB` | 否 | 库文件路径，默认 `data/kf.db` |
| `KF_MEDIA_DIR` | 否 | 附件目录。填了才会下载附件；不填只记录 `media_id` |
| `KF_CORP_VERIFIED` | 否 | 企业已认证时填 `1`，诊断里的容量上限随之变成 2000/5000 |
| `KF_BASE_URL` | 否 | 仅调试用，默认官方地址 |

不要做的事：把 `KF_SECRET` 写进 `docker-compose.yml`、systemd unit、或提交进仓库。
用环境变量文件并限制权限（`chmod 600`），或走你现有的密钥管理。

### 2.1 独立 sidecar（推荐形态）

不需要装整套平台。一个容器、一个库：

```bash
# 1) 依赖只有 Node 标准库，把这几样拷到目标机
#    paths.js  server/archive/window.js  server/archive/consent.js  server/archive/kf/

# 2) 配置单独放一个文件，只给 root 读
install -m 600 /dev/null /opt/kf-sidecar/env
cat > /opt/kf-sidecar/env <<'ENV'
KF_SYNC_ENABLED=1
KF_CORPID=ww...
KF_SECRET=...
KF_OPEN_KFID=wkqm...
KF_DB=/data/kf.db
KF_MEDIA_DIR=/data/media
ENV

# 3) 起容器。**必须 --network host**：出口 IP 就是这台机的 IP，
#    换成 bridge 会变成 NAT 后的另一个地址，白名单立刻失效。
docker run -d --name kf-sidecar --restart unless-stopped \
  --network host \
  --env-file /opt/kf-sidecar/env \
  -v /opt/kf-sidecar/app:/app -v /opt/kf-sidecar/data:/data -w /app \
  node:24-alpine node server/archive/kf/sidecar.mjs
```

自查两件事：

```bash
docker exec kf-sidecar node -e 'const r=await fetch("https://ifconfig.me/ip");console.log((await r.text()).trim())'
# 这个 IP 必须等于后台「企业可信 IP」
docker logs --tail 20 kf-sidecar
# 应看到 [kf-sync] pulled=... errors=0；启动 20s 后跑第一轮
```

sidecar 与平台的关系：读接口面（`/api/archive/kf/*`）只在平台里提供；纯 sidecar 形态下
用 CLI 命令查（`convs` / `inbox` / `search`），或者只落库、把库当唯一产出。

---

## 3. 首次启动与验收

```bash
# 1) 诊断：五态之一，退出码非 0 就不要启动拉取
node server/archive/kf/cli.mjs doctor

# 2) 拉一轮（不启动常驻，先确认能落库）
node server/archive/kf/cli.mjs sync

# 3) 看会话 / 待回复 / 检索
node server/archive/kf/cli.mjs convs
node server/archive/kf/cli.mjs inbox
node server/archive/kf/cli.mjs search 报价

# 4) 附件补取（配了 KF_MEDIA_DIR 才需要单独跑）
node server/archive/kf/cli.mjs media
```

`doctor` 的判定口径：

| verdict | 含义 | 你要做的 |
|---|---|---|
| `ready` | 接口通且有数据 | 可以常驻 |
| `ready_empty` | 接口通但 3 天窗口内没有消息 | 正常。这是「就绪」不是故障——从微信侧给客服号发一条即可 |
| `unconfigured` | 缺 `corpid`/`secret` | 填环境变量 |
| `api_unavailable` | 取票或接口调用失败 | 看 `blockers`：凭据配对 / 可调用接口的应用 / 出口 IP / 客服账号 id，四类分别点名 |

**验收的最小闭环**：用个人微信给客服账号发一条文字 + 一张图，重跑 `sync`，
然后确认三件事：

1. 客户那条消息 `origin=peer`，系统事件是 `origin=system`，本方回复是 `origin=self`；
2. 图片在 `KF_MEDIA_DIR` 下真的落成文件（不是零字节或几百字节的假图片）；
3. `inbox` 里这条会话进入「待回复」，且显示的截止时间是「客户最后一条消息 + 48 小时」。

---

## 4. 日常运维

- **拉取间隔**默认 5 分钟。因为官方只保留 3 天，别把间隔调到小时级——一次长时间停机
  就可能吞掉一段不可补的数据。
- **巡检看三个数**：`data/kf.db` 的游标是否在推进、`lastCheckedAt` 是否在 1 小时内、
  `inbox` 里有没有已错过的会话。读接口面：`GET /api/archive/kf/sync-status`、
  `/coverage`、`/inbox`（全部只读，没有写入入口）。
- **滞后判定**：超过 2 天告警，超过 3 天即「永久缺口」，只能从当下重新开始。

---

## 4.1 给客户发文件（Excel / PDF 等）

同一条 48 小时窗口，同一套「默认演练、`--confirm` 才真发」。

```bash
# 演练：只打印目标、文件名、字节数与窗口状态 —— 不上传、不发送
node server/archive/kf/cli.mjs reply uXXXX --file ./报价单.xlsx

# 真发（上传 + 发送两步，内部自动完成）
node server/archive/kf/cli.mjs reply uXXXX --file ./报价单.xlsx --confirm
```

**需要什么**

- 与发文本同一套凭据（`KF_CORPID` / `KF_SECRET`），出口 IP 仍须在「企业可信IP」内；
  上传走通用 `/cgi-bin/media/upload`，`send_msg` 用返回的 `media_id`。
- 文件必须在允许目录内（默认 `KF_MEDIA_DIR`，可用 `--root` 指定）。

**上限与时效**（官方口径；实现里写在 `server/archive/kf/api.js` 的常量注释，含文档出处）

| 项 | 值 |
|---|---|
| 普通文件大小 | ≤ 20MB，且必须 > 5 字节 |
| `media_id` 有效期 | 3 天 |
| 同一客户 48 小时内可发条数 | 5 条（文本与文件合计） |
| 允许的扩展名 | xlsx/xls/csv/pdf/docx/doc/pptx/txt/zip |

**失败怎么读**（返回里的 `stage` 就是答案）

| `stage` | 含义 | 该怎么办 |
|---|---|---|
| `guard` | 本地闸门拒了（路径/体积/类型） | 看 `reason`；**没有任何请求发出去** |
| `window` | 客户最后一条消息超过 48 小时 | 窗口不可延长，只能等客户再说一句 |
| `upload` | 上传失败 | 直接重试（会重传） |
| `send` | 上传成功、发送失败 | 直接重试——`uploaded: true` 表示**只重发、不重传** |

复用的 `media_id` 过期时，系统会自动重传再发，并把 `reuploaded: true` 写进结果；
所以不要因为"刚才发成功过"就跳过失败处理。

> 官方原页还有一句必须记住：**「接口返回成功不代表消息最终发送成功」**。
> 真要确认客户收到了，看后续的发送失败事件，而不是只看返回的 `msgid`。

---

## 4.2 客户发来的附件怎么读

客户在微信里发的报价单、营业执照、清单，正文全在附件里。**附件下载成功 ≠ 内容可读**：
官方只给 `media_id`、不给文件名，落盘时是 `.bin`。所以系统在落盘后按**内容**判类型并抽成纯文本。

**不用你做任何配置**：配了 `KF_MEDIA_DIR`（附件下载）就会自动抽。升级前已经在盘上的存量附件，
跑一次回填即可（不重新下载）：

```bash
node server/archive/kf/cli.mjs extract          # 回填存量附件（幂等，可重复跑）
node server/archive/kf/cli.mjs show <消息id>     # 看某条消息的附件正文
```

**能读的类型**（靠内容判定，与文件后缀无关）

| 类型 | 判定依据 | 解析器 |
|---|---|---|
| xlsx / docx / pptx | ZIP 容器里的主条目名 | officeparser |
| xls / doc | OLE 复合文档里的流名 | officeparser |
| pdf | `%PDF` 魔数 | pdf-parse |
| txt / csv | 前 8KB 无二进制字节 | 无（直接解码） |
| 图片 / 语音 / 视频 / 其他 zip | — | 不抽（`unknown_kind`） |

**上限**（都不可由调用方绕过）

| 项 | 值 |
|---|---|
| 单个附件抽取输入 | ≤ 20MB |
| 落库正文 | 20000 字符（超出标 `truncated`，`chars` 仍是原文真实长度） |
| 单次抽取墙钟 | 15 秒（超时记 `timeout`，不拖住拉取） |
| 单条附件进 agent 的正文 | 4000 字符（超出标 `truncated`） |

**读法**

- 检索：`cli.mjs search 含税单价` 会命中附件正文，结果标 `matchedIn: "attachment"`；
- 单条：`cli.mjs show <消息id>`；
- HTTP：`GET /api/archive/kf/attachment?messageId=<id>`（纯查库，不下载、不解析文件）；
- agent 输入：`kfAgentInput` 给带附件的消息挂 `attachment{status,kind,chars,truncated,text}`。

**抽取状态怎么读**（`kf_media.extract_state`；它与下载状态 `state` 是两列，互不影响）

| 值 | 含义 | 该怎么办 |
|---|---|---|
| `done` | 已抽出正文 | 正常 |
| `unknown_kind` | 判不出类型（图片/音视频/无主条目的 zip） | 正常，不是故障 |
| `empty` | 解析成功但没有文字（扫描件、空表） | 需要 OCR 才能读，本版本不做 |
| `no_extractor` | 运行环境没有解析器 | 见下面的 sidecar 说明 |
| `timeout` / `error` | 超时 / 解析失败 | 已留 `extract_error`，可手工清 `extract_state` 后重跑 `extract` |

> **纯 sidecar 形态**（只拷 Node 标准库文件、不装 npm 包）没有办公文档解析器：附件照常下载、
> 消息照常入库，抽取状态是 `no_extractor`，txt/csv 仍可读。要读 Excel/PDF 请用平台形态。

---

## 4.3 挂上 MCP，让 agent 自己读

CLI 是给人用的；要让 agent 按需取用（而不是把整库灌进上下文），把它挂成 MCP 工具：

```json
"kf": {
  "command": "node",
  "args": ["server/archive/kf/mcp.js"],
  "envRefs": ["KF_DB"]
}
```

四个工具，**全部只读**：

| 工具 | 干什么 |
|---|---|
| `kf_conversations` | 会话列表，带客户最后发言时间与 48h 窗口剩余 |
| `kf_messages` | 取某会话的消息；**默认只给客户发言**，`includeSelf=true` 才带本方回复（系统事件始终不返回） |
| `kf_search` | 检索，**同时命中附件正文**；命中附件时该条带 `matchedIn: "attachment"` |
| `kf_attachment` | 取某条消息的附件全文（`kf_messages` 每条只带 4000 字符，长表格用这个） |

三点必须知道：

1. **没有发送工具**。给客户发消息仍然只有 CLI 的 `reply --confirm`——MCP 面故意不给这个口子。
2. **默认只给客户发言**。本方回复会让 agent 对着自己昨天说的话再答一遍；系统事件会让它对着
   「客户已进入会话」写一段回答。要本方发言显式传 `includeSelf=true`。
3. **附件读不到时说原因**。未抽取/无解析器/超时都会带 `state` + `reason`，不给空串——
   空串会让 agent 以为客户什么都没发。

```bash
# 自检：起进程、发 initialize + tools/list，确认 stdout 只有 JSON-RPC
node server/archive/kf/mcp.js < /dev/null    # 不接传输层时应立刻退出，不应有输出
node --test scripts/test-kf-mcp.mjs          # 17 条，含 stdio 传输层与 stdout 纯净度
```

---

## 5. 三条不要做的事

1. **不要把后台那串数字当 `open_kfid`。** 会得到 `95000`，而且报错看起来像权限问题。
2. **不要用「取票成功」证明通道可用。** `gettoken` 不校验 IP，`60020` 一定出现在取票之后。
3. **不要给这条通道开自动回复。** 发出的是给真实客户的消息；本软件只有显式
   `reply <用户> <正文> --confirm` 才会发，默认是演练。请保留这个默认。
