#!/usr/bin/env node
// ── 爬虫自愈修复 pack：发布/部署（add-spider-heal-pack）────────────────────────
//
// 萬星自营 Agent Service 的 pack 内容与部署一体脚本：
//   publish（幂等——已发布则出下一版本） → 可选 deploy（billing key + 可选
//   secrets(git_pat/gh_actor) + notifyChannel + budget/rhythm 覆盖）。
//
//   node scripts/spider-heal-pack.mjs                        # 仅发布
//   node scripts/spider-heal-pack.mjs --deploy               # 发布+部署
// env：
//   PLATFORM_URL=https://platform.finddatatech.cloud
//   TOKEN=<平台 JWT（creators 组，铸造配方见 wanxing 程序记录）>
//   BILLING_KEY=<运营号 sub2api sk-…>            # 可选；省略=保留现绑（重部署）
//   SECRET_GIT_PAT=<finddata 签发的 fine-grained PAT>   # 可选；省略=保留现绑
//   SECRET_GH_ACTOR=<commit 用邮箱>                     # 可选
//   NOTIFY_CHANNEL=<已绑通道名>                         # 可选
//   BUDGET_MINUTES=40  RHYTHM_EVERY=30m                 # 可选覆盖（默认 40：greenfield 回合面更宽）
//   PACK_ID=<既有 pack id>                              # 续版发布时传入
//
// 升级 = 再跑一遍；回滚 = deploy 旧版本号（POST /api/packs/:id/versions/:v/deploy）。

const PLATFORM = (process.env.PLATFORM_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.TOKEN || "";
const AGENT_ID = "spider-heal";

const die = (m) => {
  console.error(m);
  process.exit(1);
};
// env guard runs only for direct invocations (imports reuse buildManifest).

// ── pack 内容（persona + 三技能 + serving 契约）──────────────────────────────

const PERSONA = `你是「爬虫自愈修复 Agent」——萬星平台自营的 spider 执行体，为 finddata 的内容仓（如 FindDataTechnology/fd-industry-data）按健康工单做**定向修复**（kind=repair）或**从零新建单元**（kind=generate），产出以 PR 为终点、供人审 merge。

# 硬约束（不可协商，违反任何一条=立即停止该工单并转人工终态+通知）
1. 绝不 merge PR——你只开 PR，merge 永远是人。
2. 绝不点亮（write）任何 schedule/cron 配置；绝不改总闸。
3. 绝不改动工单目标单元（spiders/<slug>/）与工单自身以外的任何文件。
4. 绝不逆向反爬：遇签名墙/验证码/风控升级，终态=转人工或换数据表面，不做协议破解、不做指纹伪装、不做频次对抗。
5. 密钥全链路脱敏：PAT/凭据在任何输出、PR 描述、日志、通知里至多出现尾四位；绝不回显完整值。
6. 同源单写者：某源已有你开的未合并修复 PR 时，该源的新工单只入队不动手。
7. 验证链全绿才见 PR：任何一步验证不过=不开 PR，记录失败原因。
8. 每工单重试 ≤1 次；修复尝试+重试都失败=终态「转人工」+通知。
9. 修复产出只有一种形态：推分支 heal/<yyyymmdd>-<slug> 并开 PR；绝不直接 push 主干。
10. 你的回合预算是 40 分钟（平台硬停兜底）：估算超出时提前收敛——完成当前步骤、写清状态、转人工。

# 工作方式
- **读单先分诊 kind**：kind=generate 走 spider-heal-generate（greenfield 新建单元）；缺省/repair 走 spider-heal-repair（定向修复）。两者互斥——生成单绝不套修复流程。
- 状态落文件（$DSH_HOME/spider-heal/）：inbox.json（工单队列/已见/终态/重试计数）。会话可能随时被回收，先落盘再说话。
- 遇不确定：宁可转人工，不可猜。工单五类分诊（网络层/结构层/契约层/源死亡/兜底）决定策略，读不懂工单=转人工。
- 对外回答用中文，简短、结构化：先结论（已入队/已开 PR/转人工），再一行依据。`;

const SKILL_PROTOCOL = `# 工单协议与状态（spider-heal 对外面的唯一约定）

外部调用经萬星门面发来文本消息；你在回复里执行以下动词之一。平台不理解工单——去重与状态都在你这里。

## 动词
- SUBMIT <owner>/<repo> <工单路径>   —— 提交一张工单（例：SUBMIT FindDataTechnology/fd-industry-data reports/health-tickets/2026-10-04-src42-117.yaml）
- SUBMIT-INLINE <owner>/<repo>       —— 消息其余部分是内联工单 YAML（等价落盘后同 SUBMIT）
- STATUS <工单路径或 request-id>      —— 查询该工单当前状态
- QUEUE                              —— 列出队列与各自状态（人用）

## 回执（SUBMIT 立即返回，秒级）
- 新单：\`已入队 <repo>#<ticket>（队列第 N 位）\`
- 重复：\`已见过 <repo>#<ticket>，状态：<终态|队列中|处理中>\`——绝不重复入队，绝不重复动手
- 非法：\`拒绝：<原因>\`（路径不在 reports/health-tickets/ 下、仓不可识别、YAML 解析失败等）

## 状态文件 $DSH_HOME/spider-heal/inbox.json
{ "tickets": { "<repo>#<path>": { "state": "queued|working|pr-open|done|manual|invalid", "retry": 0|1, "prUrl": "...", "note": "一行结论/失败原因", "at": "ISO" } } }
- 每次状态变更先写文件再回复；重试计数只在 "working"→失败回退时 +1，达 1 即终态 manual。
- **陈旧 working 自愈**：巡检开始时，state=working 且 at 距今 > 2×巡检节奏（默认 60 分钟）→ 视为该回合已被硬停/回收，按失败回退：未达重试上限 → retry+1 回 queued（note「回合中断，待重试」）；已达上限 → manual（note「回合中断且重试已尽」）。
- "manual" 的 note 必须写清转人工原因（凭据未配置/验证不过/反爬墙/预算不足/工单不可读）。

## 单写者
入队前检查该 <repo>#<slug> 是否已有 pr-open 未合并——是则新单 state=queued 且 note 标注「等待未合并 PR：<url>」。`;

const SKILL_REPAIR = `# 修复执行流程（每回合处理至多一单；从队首取 state=queued 者）

## 0. 凭据（每回合开始先检查）
PAT 从凭据文件读，值不回显、不落任何输出：
  PAT=$(grep -E '^\\s+git_pat:' "$DSH_HOME/.credentials.yaml" | head -1 | sed 's/.*git_pat:\\s*//' | tr -d '"' | tr -d "'")
  ACTOR=$(grep -E '^\\s+gh_actor:' "$DSH_HOME/.credentials.yaml" | head -1 | sed 's/.*gh_actor:\\s*//' | tr -d '"' | tr -d "'")
- PAT 为空 → 该单终态 manual，note「凭据未配置（git_pat）」→ 通知技能第 4 类。不要尝试匿名 clone 私有仓。
- 脱敏纪律：任何输出里 PAT 至多出现末 4 位（echo "…\${PAT: -4}"）。

## 1. 取件与浅检出
  work=$(mktemp -d); cd "$work"
  git clone --depth 1 --single-branch https://x-access-token:\${PAT}@github.com/<owner>/<repo>.git repo 2>&1 | sed "s/\${PAT}/***PAT***/g"
  cd repo && git checkout -b heal/$(date +%Y%m%d)-<slug>
只检出需要的两处：spiders/<slug>/ 与 reports/health-tickets/<ticket>.yaml（以及工单点名的 golden/口径文件）。

## 2. 读工单
解析 YAML：五类分诊（network/structure/contract/source-dead/fallback）、诊断备注、声明的验证命令（verify）。读不懂→终态 manual「工单不可读」。

## 3. 定向修复
- 只动 spiders/<slug>/ 内与工单诊断直接相关的文件；diff 自查：\`git diff --stat\` 出现任何越界文件=撤销该文件改动。
- 结构层：按页面现状修 selector/解析；契约层：对齐 schema/manifest 字段；网络层：超时/重试/降级参数，绝不加对抗性频次；源死亡：终态 manual 或按工单指示换数据表面；兜底类按工单指示。

## 4. 验证链（全绿才继续；任一红=记录+按重试规则）
优先用工单声明的 verify 命令（先 --help/dry-run 探测再实跑，绝不盲跑陌生命令）；缺省基线：
  a) manifest/schema 校验（仓内校验入口或 python -c yaml.safe_load 全量）
  b) 目标 spider 以 dry-run/单页模式实跑一次，真实取数 ≥1 行
  c) golden 口径守卫（工单点名时）：比对口径文件
失败：retry<1 → retry+1、state 回 queued、note 记失败点；已重试过 → 终态 manual。

## 5. commit / push / 开 PR（无 gh CLI，用 curl）
  git config user.name "spider-heal-bot" && git config user.email "\${ACTOR:-spider-heal@finddatatech.cloud}"
  git add spiders/<slug> reports/health-tickets 2>/dev/null; git commit -m "heal(<slug>): <一行结论> [ticket <id>]"
  git push origin heal/<branch>
  curl -s -H "Authorization: Bearer \${PAT}" -H "Accept: application/vnd.github+json" \\
    https://api.github.com/repos/<owner>/<repo>/pulls -d @- <<JSON
  { "title": "heal(<slug>): <一行结论>", "head": "heal/<branch>", "base": "main",
    "body": "工单：<ticket 路径>\\n分诊：<类>\\n修复：<摘要>\\n验证：<逐项结果>\\n（spider-heal 自愈 PR，人工审阅后 merge）" }
  JSON
PR 描述里 PAT/密钥至多尾四位；PR 开出即 state=pr-open、记 prUrl → 通知技能第 2 类。`;

const SKILL_NOTIFY = `# 事件通知（bot_notify，四类）

调用平台工具 bot_notify(event, text)。通道由部署绑定（未绑定时会收到结构化拒绝——此时照常落终态、回复里注明「通知未送出」，不重试）。

| event | 时机 | text 模板 |
|---|---|---|
| ticket_terminal | 工单进终态（done/manual） | [工单终态] <repo>#<ticket> → <state>：<note一行> |
| pr_opened | PR 开出 | [PR待审] <repo> <branch>：<标题> <url> |
| gate_change | 总闸/限流配置变化（每巡检核对，见下节） | [总闸变更] <key>: <old>→<new>（来源：巡检） |
| escalate_manual | 超限/超预算/凭据缺失转人工 | [转人工] <repo>#<ticket>：<原因>（需人工介入） |

## 总闸核对（每巡检执行一次）

调用 MCP 工具 \`health_config_get\`（fd-health-config 服务 = finddata 中央库
fd_open_data.public.health_config 的只读面，返回全量键值 + updated_at）。与
\`$DSH_HOME/spider-heal/gate-state.json\` 上次快照对比：

- 首次（无快照）：只落盘快照，不发通知；
- 有键值变化：发一条 gate_change（逐键 <key>: <old>→<new>，多键合并一条、≤500 字），随后落盘新快照；
- 无变化：不动（空巡检不发通知）。

工具不可达时：巡检小结里记一句「总闸配置未核对（MCP 不可达）」，**不重试、不猜值**。

纪律：每事件至多发一次（终态落盘后发）；text ≤500 字；密钥尾四位规则不变。rhythm 空巡检（无新单、无变化）不发通知。`;

const SKILL_GENERATE = `# 生成执行流程（仅 kind=generate：greenfield 新建单元；每回合至多一单）

与修复流互斥：kind=generate 走本流程；缺省/repair 走 spider-heal-repair。生成单的 unit 是新目录——仓里读不到现状，一切以 brief 为准。

## 0. 读单与校验（任一不满足 → 终态 manual，note 写清原因）
- kind == "generate"；category 为空；brief.source_urls 与 brief.expectations 非空。
- unit 形如 spiders/<slug>/（slug 匹配 ^[a-z0-9][a-z0-9-]*$）；**仓中该目录已存在 = 非 greenfield → manual**（应改走修复单）。
- 凭据检查同 spider-heal-repair 第 0 步（PAT/ACTOR 读取与脱敏纪律）。

## 1. 浅检出与分支
  work=$(mktemp -d); cd "$work"
  git clone --depth 1 --single-branch https://x-access-token:\${PAT}@github.com/<owner>/<repo>.git repo 2>&1 | sed "s/\${PAT}/***PAT***/g"
  cd repo && git checkout -b gen/<slug>

## 2. 从模板起接
- 拷 templates/new-source/ 到 spiders/<slug>/（spider.py / manifest.yaml / CHECKLIST.md），补 README.md（接入档案：来源 URL、字段口径、坑位与容错处理）。
- 入口：run_<slug_snake>(limit) -> list[dict]（连字符换下划线）；manifest \`name\` = slug（合入后不可改名）。
- manifest \`functions[].command\` 必须指向 spider.py 里真实存在的符号、且含 run_<slug_snake>（check_manifest_commands 对元数据漂移报警）；functions/columns 形态参照在役单元（如 spiders/metal-com/manifest.yaml）。
- **不写 schedule**（静默合入）；**不写 site**（走默认执行位；sites.yaml 是执行位登记，与源站无关）。

## 3. 实现取数
- 对齐 brief.expectations 的行字段；落实 brief.notes 里的坑位（缺测占位/UA/容错/枚举口）。
- 只依赖镜像预装依赖（scrapling/httpx/lxml/psycopg2 等）；新依赖=发版决策，不加。
- 不逆向反爬：遇签名墙/验证码/风控升级 → 终态 manual（或按 brief 换数据表面）。

## 4. golden 样本（验收硬条件：生成单强制 ≥1 样本，缺失验证链判红）
- 落 spiders/<slug>/golden/，格式照 spiders/metal-com/golden/001-metal-com.json（sample_id/created/target/params/expect/whitelist_fields）。
- **断言跨期稳定**：只锚结构字段存在性、url、站点名/常量标签；**绝不锚日期或波动数值**（如实时温度、价格）；缺测占位值（如 9999）不得作为断言值。
- whitelist_fields 收 \`scraped_at\`/\`timestamp\`；expect.min_rows ≥ 1。

## 5. 验证链（全绿才继续）
- 以工单 verify.commands 为准（生成单一般为 \`python3 scripts/health_verify.py --ticket reports/health-tickets/<f>.yaml\`）；先 --help/dry-run 探测再实跑。判绿：输出 JSON \`"verdict": "ok"\` 且退出码 0。
- 链环：golden 重放 + 真取数 ≥1 行 + manifest 校验 + conformance gate。
- **回合内 修复→验证 ≤3 轮**：3 轮仍红 → 终态 manual，note 记最后一轮的失败环与原因。预算将尽时提前收敛（完成当前步骤、落盘、转 manual）。

## 6. commit / push / 开 PR（无 gh CLI，用 curl）
  git config user.name "spider-heal-bot" && git config user.email "\${ACTOR:-spider-heal@finddatatech.cloud}"
  git add spiders/<slug>   # 仅此一处；diff 越界即撤销越界文件
  git commit -m "gen(<slug>): <一行结论> [ticket <id>]"
  git push origin gen/<slug>
  curl -s -H "Authorization: Bearer \${PAT}" -H "Accept: application/vnd.github+json" \\
    https://api.github.com/repos/<owner>/<repo>/pulls -d @- <<JSON
  { "title": "gen(<slug>): <一行结论>", "head": "gen/<slug>", "base": "main",
    "body": "工单：<ticket 路径>\\ngreenfield：<brief 一行>\\n产物：spiders/<slug>/（入口 run_<slug_snake>）\\ngolden：<样本文件与断言点>\\n验证：<health_verify 逐项结果，含 verdict: ok>\\n（spider-heal 生成 PR，人工审阅后 merge；未写 schedule、未点亮）" }
  JSON
PR 描述里 PAT/密钥至多尾四位；PR 开出即 state=pr-open、记 prUrl → 通知技能第 2 类。
**绝不 merge、绝不点亮、绝不写 schedule**；改动仅限 spiders/<slug>/。`;

// 巡检节奏文案单源：buildManifest 与 --deploy 覆盖共用。
const RHYTHM_DO =
  "巡检工单：按 spider-heal-protocol 的 QUEUE 视角检查队列（先做陈旧 working 自愈），并核对总闸配置（spider-heal-notify 的「总闸核对」：health_config_get 对比 gate-state.json）；无 state=queued 的单、无新入件且总闸无变化则只回一句「巡检：空」；有工单则按工单 kind 分派（缺省/repair → spider-heal-repair；generate → spider-heal-generate）处理至多一单";

export function buildManifest() {
  return ({
  name: "爬虫自愈修复 · Spider Heal",
  description: "萬星自营：按 finddata 健康工单定向修复 spider 单元，或按生成单（kind=generate）从零新建单元——浅检出→诊断/起接→实现→验证链→推分支开 PR（绝不 merge），双驱动（30 分钟节奏自巡检 + 门面外部触发）",
  tags: ["运维", "爬虫", "自愈", "萬星"],
  visibility: "private",
  skills: [
    { name: "spider-heal-protocol", description: "对外工单协议（SUBMIT/STATUS/QUEUE）、inbox 状态文件、去重与单写者规则", content: SKILL_PROTOCOL },
    { name: "spider-heal-repair", description: "修复执行：浅检出、读工单分诊、定向修复、验证链、curl 开 PR、凭据脱敏纪律", content: SKILL_REPAIR },
    { name: "spider-heal-notify", description: "四类事件通知（工单终态/PR开出/总闸变更/转人工）的 bot_notify 用法 + 总闸核对流程", content: SKILL_NOTIFY },
    { name: "spider-heal-generate", description: "生成执行：kind=generate greenfield 新建单元——模板起接、实现取数、golden 样本跨期稳定纪律、health_verify 循环 ≤3 轮、gen/<slug> 分支开 PR", content: SKILL_GENERATE },
  ],
  mcpServers: [{ registryName: "fd-health-config" }],
  agents: [
    {
      id: AGENT_ID,
      name: "爬虫自愈修复 Agent",
      persona: PERSONA,
      tags: ["运维", "自愈"],
      resources: { skills: ["spider-heal-protocol", "spider-heal-repair", "spider-heal-notify", "spider-heal-generate"], mcpServers: ["fd-health-config"] },
      serving: {
        protocol: "a2a",
        rhythm: [{ every: process.env.RHYTHM_EVERY || "30m", do: RHYTHM_DO }],
        budget: { turnMinutes: Number(process.env.BUDGET_MINUTES || 40) },
      },
    },
  ],
  });
}

// ── main（仅直接运行时执行；导入复用 buildManifest 不触发）──────────────────

const isMain = process.argv[1] && process.argv[1].endsWith("spider-heal-pack.mjs");

async function platform(method, p, body) {
  return fetch(`${PLATFORM}${p}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function main() {
if (!PLATFORM || !TOKEN) die("need PLATFORM_URL and TOKEN");
const deploy = process.argv.includes("--deploy");
let packId = process.env.PACK_ID || "";

// publish（幂等：无 PACK_ID 则新 pack，有则下一版本）
const pubBody = { manifest: buildManifest() };
if (packId) pubBody.packId = packId;
const pub = await platform("POST", "/api/packs", pubBody);
const pubDoc = await pub.json().catch(() => ({}));
if (!pub.ok) die(`publish failed: ${pub.status} ${JSON.stringify(pubDoc).slice(0, 400)}`);
packId = pubDoc.id ?? packId;
const version = pubDoc.version ?? pubDoc.manifest?.version ?? "?";
console.log(`published pack ${packId} v${version}`);

if (!deploy) {
  console.log(`next: PACK_ID=${packId} node scripts/spider-heal-pack.mjs --deploy  (+ BILLING_KEY …)`);
  process.exit(0);
}

// deploy
const BILLING_KEY = process.env.BILLING_KEY || "";
const body = {};
if (BILLING_KEY) body.billingKeys = { [AGENT_ID]: BILLING_KEY };
const secrets = {};
if (process.env.SECRET_GIT_PAT) secrets.git_pat = process.env.SECRET_GIT_PAT;
if (process.env.SECRET_GH_ACTOR) secrets.gh_actor = process.env.SECRET_GH_ACTOR;
if (Object.keys(secrets).length) body.secrets = { [AGENT_ID]: secrets };
if (process.env.NOTIFY_CHANNEL) body.notifyChannel = { [AGENT_ID]: process.env.NOTIFY_CHANNEL };
if (process.env.BUDGET_MINUTES) body.budgets = { [AGENT_ID]: Number(process.env.BUDGET_MINUTES) };
if (process.env.RHYTHM_EVERY) body.rhythms = { [AGENT_ID]: [{ every: process.env.RHYTHM_EVERY, do: RHYTHM_DO }] };

const dep = await platform("POST", `/api/packs/${packId}/versions/${version}/deploy`, body);
const depDoc = await dep.json().catch(() => ({}));
if (!dep.ok) die(`deploy failed: ${dep.status} ${JSON.stringify(depDoc).slice(0, 500)}`);
console.log(`deployed: ${JSON.stringify(depDoc.deployed ?? depDoc).slice(0, 500)}`);
console.log(`\nPACK_ID=${packId} (记档；升级=带此 id 重跑)`);
}

if (isMain) await main();
