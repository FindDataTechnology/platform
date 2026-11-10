# 阵列能力包创作指南（cluster pack）

> 词位说明（2026-10-27 起）：manifest 的 `cluster` 块在市场的徽章=**蓝图**；它在用户侧组装出的可分享小队叫「阵列」（en: Array），会话绑定、自拼即散。本文件的「cluster 声明」指 manifest 键，不指用户叫法。

> 面向在谦面发布能力包的创作者。基础发布流程见 `creating-packs.md`；本文只讲
> **如何把多个角色组成一个可分享的「阵列能力包」**——用户一键载入整队、集群任务扇出聚合。
>
> 首个生产样板：「柏讯 · 投研三镜头」（packId `egaYyOaZVTf0FWlLvaGAQA`），可对照其 manifest 阅读。

## 什么时候用 cluster 声明

| 你的情况 | 该用的形态 |
|---|---|
| 2-3 个互补角色，一个主题（如 宏观×估值×质询） | **cluster pack（本文）** |
| 更大的团队（4+ 角色）、跨包组队、临时组合 | 动态阵列（用户在「智能体 → 我的阵列」自建，无需你做任何事） |
| 单一垂直角色 | 普通 pack，别加 cluster |

**包上限是设计约束**：agents ≤3、mcpServers ≤5、skills ≤10。合集包是「小队模板」，
不是全明星队——想要更多成员的团队由用户用动态阵列叠加。

## manifest 写法

在普通 pack manifest 上加一个顶层 `cluster` 块：

```json
{
  "name": "我的小队",
  "skills": [ /* …全员技能，成员按 resources 收窄 */ ],
  "mcpServers": [ /* …全员 MCP 引用（包级声明并集，角色只收窄不越权） */ ],
  "agents": [
    {
      "id": "team-lens-a", "name": "镜头甲", "persona": "…",
      "resources": {
        "skills": ["skill-a1"],
        "mcpServers": ["fd-cn-report"],
        "mcpTools": { "fd-cn-report": ["tool_x", "tool_y"] }
      }
    },
    { "id": "team-lens-b", "name": "镜头乙", "persona": "…", "resources": { /* … */ } }
  ],
  "cluster": {
    "name": "我的小队",
    "description": "两镜头并行审读同一问题，聚合摘要定分歧。",
    "defaultAgents": ["team-lens-a", "team-lens-b"],
    "optionalAgents": [],
    "schedulingPolicy": { "maxConcurrentRuns": 3 }
  }
}
```

字段规则（发布时校验，违规即拒）：

- `name`/`description` 必填非空；`defaultAgents` 非空且全部指向本包声明的 agent id；
  `defaultAgents` 与 `optionalAgents` 不得重复。
- `schedulingPolicy.maxConcurrentRuns` 为 1-10 的正整数。
- **成员聚焦**：每个 agent 用 `resources.skills / mcpServers / mcpTools` 把自己的工具面
  收窄回它本来的套件面——`mcpTools` 里的工具必须在包级引用的 `allowTools` 之内
  （角色只能收窄，不能越权）。这保证「镜头甲」看不到「镜头乙」的私有工具。

## 从既有套件合集铸造（三镜头的真实配方）

1. 取同作者多套单角色套件（如 宏观/估值/投委会），拉各自 manifest。
2. 包级 `mcpServers` = 各套件同名引用的 **allowTools 并集**；`skills` = 全员技能去重并集。
3. 每个 agent 原样带过 persona，`resources.mcpTools` 填回**原套件自己的工具清单**。
4. 加 `cluster` 块，`defaultAgents` 放独立镜头、`optionalAgents` 放叠加位（质询/风控类）。
5. `POST /api/packs/validate` 过校验（工具面声明必须齐全——MCP 引用缺工具声明会被
   tool-face 闸拒），绿了再 `POST /api/packs` 发布。

## 用户侧会发生什么

- **市场**：详情页出现「集群信息」分节（默认/可选成员、数量徽章）；列表可按 agent 数筛选。
- **对话页**：agent 菜单里你的角色按集群分组（默认成员在前），「载入集群」一键
  绑定会话并切到首个默认成员。
- **集群任务**：`POST /api/cron` 带 `clusterId` + `executionPolicy`
  （`allowParallel`/`timeoutMinutes`/`resultAggregation: first|all|summary`）——
  成员各自子会话真实执行（本地 persona 恒串行、远端 a2a 成员可并行，摘要如实注记），
  `summary` 策略由首个成功成员领衔综合，绑定会话收聚合结论，历史记录每成员所用模型。

## 注意

- 与其他套件**同名 agent id 会互相遮蔽**（既有安装优先）——合成合集时保持成员 id 与
  原套件一致会让原套件已装用户只见到旧条目；预期行为，但上架说明里值得提一句。
- `serving` 契约与集群正交：要上萬星 A2A 的成员照常声明；部署侧模型闸
  （白名单/车道/roster）对带 serving 的成员照常生效。
