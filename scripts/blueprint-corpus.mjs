// 蓝图构造集（iteration corpus）——贴近真实的垂直场景，覆盖各种形状与边界，
// 用来在生产上跑「草稿→校验→批准→铸造→试跑→签字」全链，把露出来的问题就地修。
//
// 设计意图：
//   · 4 个"应通过"的真场景（政策盯梢 / 客服工单 / 内容工厂 / 投研晨会），
//     每个都有机器断言 + 至少一条 llm-judged（判据写成证据可直接支持的形式）；
//   · 5 个"应被指名拒绝"的坏例，覆盖各类闸：缺 members / 坏 cron / 端点型
//     数据源 / 空 rubric / 自引用占位漏了 presetId；
//   · 每个用例带 `expect` 字段，驱动脚本据此判 pass/fail，不用人肉看。

export const ACCEPTANCE_MACHINE = [
  { id: "posts-staffed", kind: "post-materialized" },
  { id: "first-round", kind: "first-round-fired" },
];

export const CORPUS = [
  {
    name: "跨境电商政策盯梢",
    expect: "valid",
    content: {
      boundary: {
        name: "跨境电商政策盯梢",
        oneLine: "盯海关/商务/税务三路政策与公告面，异动即报；不做商品行情与汇率预测",
        outOfScope: "商品价格监控、汇率预测、平台规则解读",
      },
      dataSources: [{ ref: "websearch", note: "部委公告与政策流" }],
      fleet: {
        name: "政策盯梢集群",
        members: [
          {
            ref: "watch",
            title: "盯梢岗",
            target: { kind: "tool", id: "websearch::web_search" },
            cadence: { cron: "0 8 * * *", tz: "Asia/Shanghai", promptTemplate: "{\"query\":\"跨境电商 政策 海关 商务部\"}" },
          },
          {
            ref: "brief",
            title: "简报岗",
            parentRef: "watch",
            target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "policy-brief" },
            kpiSlots: [{ key: "briefs", label: "简报数", unit: "份" }],
            cadence: { cron: "30 8 * * *", tz: "Asia/Shanghai", promptTemplate: "汇总今日盯梢结果，出一份政策简报并报数。" },
          },
        ],
        orchestration: { mode: "supervisor", edges: [{ kind: "handoff", from: "watch", to: "brief" }] },
      },
      agents: [{ id: "policy-brief", name: "简报岗", persona: "你是政策简报岗，只汇总盯梢岗给出的原文要点，不臆测。" }],
      mcpServers: [],
      monitoring: { anomaly_criteria: ["部委公告出现新规"], escalate: { threshold: 3, severity_default: "high" }, notify: "proposal-channel" },
      acceptance: [
        ...ACCEPTANCE_MACHINE,
        { id: "two-posts", kind: "llm-judged", rubric: "盯梢岗与简报岗两个岗位在试跑集群中均已落位" },
      ],
      board: [{ artifact: "doc", title: "政策日报" }],
    },
  },
  {
    name: "客服工单分诊",
    expect: "valid",
    content: {
      boundary: {
        name: "客服工单分诊",
        oneLine: "把进线工单按类型分派给对应处置岗，超时升级；不做销售外呼",
        outOfScope: "电话外呼、退款审批",
      },
      dataSources: [{ ref: "websearch", note: "产品公告与已知问题库" }],
      fleet: {
        name: "工单分诊集群",
        members: [
          {
            ref: "triage",
            title: "分诊岗",
            target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "ticket-triage" },
            kpiSlots: [{ key: "triaged", label: "分诊数", unit: "件" }],
            cadence: { cron: "*/30 * * * *", tz: "Asia/Shanghai", promptTemplate: "拉取新工单，标注类型与优先级，分派到处置岗。" },
          },
          {
            ref: "resolve",
            title: "处置岗",
            parentRef: "triage",
            target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "ticket-resolve" },
            cadence: { cron: "*/30 * * * *", tz: "Asia/Shanghai", promptTemplate: "处理分派来的工单，给结论或升级。" },
          },
        ],
      },
      agents: [
        { id: "ticket-triage", name: "分诊岗", persona: "你是客服分诊岗，按类型与紧急度分派，不自行答复。" },
        { id: "ticket-resolve", name: "处置岗", persona: "你是客服处置岗，先查已知问题库再答复，不确定就升级。" },
      ],
      mcpServers: [],
      monitoring: { anomaly_criteria: ["工单积压超过阈值"], escalate: { threshold: 5 }, notify: "proposal-channel" },
      acceptance: [
        ...ACCEPTANCE_MACHINE,
        { id: "triage-post", kind: "llm-judged", rubric: "分诊岗与处置岗两个岗位在试跑集群中均已落位" },
      ],
    },
  },
  {
    name: "内容工厂",
    expect: "valid",
    content: {
      boundary: {
        name: "内容工厂",
        oneLine: "选题→初稿→审校的流水线，只出草稿供人定稿；不自动发布",
        outOfScope: "自动发布、投放",
      },
      dataSources: [{ ref: "websearch", note: "选题素材" }],
      fleet: {
        name: "内容工厂集群",
        members: [
          {
            ref: "topic",
            title: "选题岗",
            target: { kind: "tool", id: "websearch::web_search" },
            cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "{\"query\":\"行业热点\"}" },
          },
          {
            ref: "draft",
            title: "初稿岗",
            parentRef: "topic",
            target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "content-draft" },
            kpiSlots: [{ key: "drafts", label: "草稿数", unit: "篇" }],
            cadence: { cron: "30 9 * * *", tz: "Asia/Shanghai", promptTemplate: "按选题写初稿，不发布。" },
          },
        ],
      },
      agents: [{ id: "content-draft", name: "初稿岗", persona: "你是内容初稿岗，产出草稿供人定稿，绝不自行发布。" }],
      mcpServers: [],
      monitoring: { anomaly_criteria: ["连续两日无产出"], escalate: { threshold: 2 }, notify: "proposal-channel" },
      acceptance: [
        ...ACCEPTANCE_MACHINE,
        { id: "draft-post", kind: "llm-judged", rubric: "选题岗与初稿岗两个岗位在试跑集群中均已落位" },
      ],
    },
  },
  {
    name: "投研晨会",
    expect: "valid",
    content: {
      boundary: {
        name: "投研晨会",
        oneLine: "盘前汇总隔夜要闻与持仓异动，出晨会纪要；不做买卖建议",
        outOfScope: "荐股、下单",
      },
      dataSources: [{ ref: "websearch", note: "隔夜市场要闻" }],
      fleet: {
        name: "投研晨会集群",
        members: [
          {
            ref: "scan",
            title: "扫描岗",
            target: { kind: "tool", id: "websearch::web_search" },
            cadence: { cron: "0 7 * * 1-5", tz: "Asia/Shanghai", promptTemplate: "{\"query\":\"隔夜美股 宏观 要闻\"}" },
          },
          {
            ref: "brief",
            title: "纪要岗",
            parentRef: "scan",
            target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "research-brief" },
            cadence: { cron: "20 7 * * 1-5", tz: "Asia/Shanghai", promptTemplate: "汇总扫描结果，出晨会纪要，不给买卖建议。" },
          },
        ],
      },
      agents: [{ id: "research-brief", name: "纪要岗", persona: "你是投研纪要岗，只陈述事实与异动，不给投资建议。" }],
      mcpServers: [],
      monitoring: { anomaly_criteria: ["持仓标的异动超阈值"], escalate: { threshold: 3 }, notify: "proposal-channel" },
      acceptance: [
        ...ACCEPTANCE_MACHINE,
        { id: "both-posts", kind: "llm-judged", rubric: "扫描岗与纪要岗两个岗位在试跑集群中均已落位" },
      ],
    },
  },

  // ── 应被指名拒绝的坏例 ──────────────────────────────────────────────────
  {
    name: "坏例·无成员",
    expect: "invalid",
    expectEntry: "fleet",
    content: {
      boundary: { name: "坏例·无成员", oneLine: "x", outOfScope: "y" },
      dataSources: [{ ref: "websearch" }],
      fleet: { name: "空集群", members: [] },
      agents: [], mcpServers: [],
      acceptance: ACCEPTANCE_MACHINE,
    },
  },
  {
    name: "坏例·坏 cron",
    expect: "invalid",
    expectEntry: "fleet",
    content: {
      boundary: { name: "坏例·坏 cron", oneLine: "x", outOfScope: "y" },
      dataSources: [{ ref: "websearch" }],
      fleet: {
        name: "坏 cron 集群",
        members: [{ ref: "a", title: "岗", target: { kind: "tool", id: "websearch::web_search" },
          cadence: { cron: "这不是 cron", tz: "Asia/Shanghai", promptTemplate: "x" } }],
      },
      agents: [], mcpServers: [],
      acceptance: ACCEPTANCE_MACHINE,
    },
  },
  {
    name: "坏例·端点型数据源",
    expect: "invalid",
    expectEntry: "dataSources[0].ref",
    content: {
      boundary: { name: "坏例·端点型数据源", oneLine: "x", outOfScope: "y" },
      dataSources: [{ ref: "https://evil.example/feed" }],
      fleet: {
        name: "集群",
        members: [{ ref: "a", title: "岗", target: { kind: "tool", id: "websearch::web_search" } }],
      },
      agents: [], mcpServers: [],
      acceptance: ACCEPTANCE_MACHINE,
    },
  },
  {
    name: "坏例·空 rubric",
    expect: "invalid",
    expectEntry: "acceptance[0].rubric",
    content: {
      boundary: { name: "坏例·空 rubric", oneLine: "x", outOfScope: "y" },
      dataSources: [{ ref: "websearch" }],
      fleet: {
        name: "集群",
        members: [{ ref: "a", title: "岗", target: { kind: "tool", id: "websearch::web_search" } }],
      },
      agents: [], mcpServers: [],
      acceptance: [{ id: "sem", kind: "llm-judged" }],
    },
  },
  {
    name: "坏例·pack-preset 缺 presetId",
    expect: "invalid",
    expectEntry: "fleet",
    content: {
      boundary: { name: "坏例·pack-preset 缺 presetId", oneLine: "x", outOfScope: "y" },
      dataSources: [{ ref: "websearch" }],
      fleet: {
        name: "集群",
        members: [{ ref: "a", title: "岗", target: { kind: "pack-preset", packId: "{{PACK_ID}}" } }],
      },
      agents: [], mcpServers: [],
      acceptance: ACCEPTANCE_MACHINE,
    },
  },
];
