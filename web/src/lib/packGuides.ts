// packGuides.ts — client-side guide content keyed by pack id (R2
// add-onboarding-tutorial, design D1). Guide bodies and per-pack prompt
// suggestions are CONTENT — the same class as pack personas and skills, which
// ship zh-authoritative single-language — so they live here in zh rather than
// in the five-locale UI bundles. Everything the user SEES as chrome (card
// titles, step labels, tab names) still resolves through i18n.
//
// Sources for every guide: the pack's own marketplace description and its
// skill workflow — no invented steps. Packs without an entry here render no
// guide card and keep the default/focused prompt sets.

export interface PackGuideStep {
  title: string;
  body: string;
}

export interface PackPromptCard {
  title: string;
  text: string;
}

export interface PackGuide {
  /** Pack display name as shown in the market — kept in sync with the market listing. */
  name: string;
  /** The three-step usage guide: prepare → ask → get. */
  steps: [PackGuideStep, PackGuideStep, PackGuideStep];
  /** Four suggested prompt cards shown on the welcome state when this expert is selected. */
  prompts?: PackPromptCard[];
}

export const PACK_GUIDES: Record<string, PackGuide> = {
  // 法律-合同：合同全流程审查
  "J9sO_wRCgUVjbYVEqD4Pog": {
    name: "法律-合同",
    steps: [
      {
        title: "准备合同文本",
        body: "把合同全文粘贴进对话，或把合同文件（Word/PDF 导出的文本）直接拖进输入框。条款越多越完整，审查越准。",
      },
      {
        title: "让专家审查",
        body: "选「法律-合同」专家后说：「审查这份合同，给出结构化提取、分级风险明细和可替换条款措辞」。也可以只问某几条条款。",
      },
      {
        title: "拿到风险清单与改法",
        body: "你会得到结构化要素提取、按风险等级排序的问题清单、每处风险的替换措辞建议，以及对应的法条附录。让专家生成文档即可保存到成果。",
      },
    ],
    prompts: [
      { title: "审查一份合同", text: "请审查我粘贴的这份合同，输出：结构化提取、分级风险明细、每处风险的可替换条款措辞，并附法条依据。\n（下方粘贴合同全文）" },
      { title: "比对两个版本", text: "这是同一份合同的两个版本，请逐条比对差异，指出哪些改动对我方不利并给出改法。\n（下方粘贴两版文本）" },
      { title: "起草保密协议", text: "帮我起草一份保密协议（NDA），我方为接受方，期限 3 年，适用中国法，违约金条款要合理可执行。" },
      { title: "解释条款含义", text: "用通俗语言解释合同中这一条款的法律含义和对我的影响，并说明行业内的常见做法：\n（粘贴条款）" },
    ],
  },

  // 法律-案件：民商事案件全流程研判
  "_r1lL81mBSMTtvjraEwkJA": {
    name: "法律-案件",
    steps: [
      {
        title: "讲清案情",
        body: "把案情经过、我方身份（原告/被告）、现有证据和诉求讲给专家——粘贴起诉状、答辩状或证据目录都可以。",
      },
      {
        title: "让专家研判",
        body: "说：「梳理案情、固定争议焦点、实查法条依据」。专家会用 law_search / law_read 实查法规原文，不凭印象引用。",
      },
      {
        title: "拿到攻防地图",
        body: "你会得到案情时间线、争议焦点清单、每项焦点的法条依据（带原文）和双方攻防要点，可直接追问下一步文书怎么写。",
      },
    ],
    prompts: [
      { title: "梳理案情焦点", text: "请梳理我粘贴的案情：列时间线、双方主张、争议焦点，并实查每个焦点对应的法条依据。\n（下方粘贴案情材料）" },
      { title: "检索类案与法条", text: "针对「（案由）」这类纠纷，检索常用法条并核查现行效力，给出条文原文和适用要点。" },
      { title: "起草起诉状", text: "根据以下案情帮我起草民事起诉状：诉讼请求、事实与理由分段写，引用实查过的法条。\n（粘贴案情）" },
      { title: "分析对方抗辩", text: "对方可能提出这些抗辩：（列举）。请逐项分析成立的可能性和我方的反驳要点。" },
    ],
  },

  // 数据-股票：个股研究全流程
  "Y5uR57UBAXi7_xruKQBsfg": {
    name: "数据-股票",
    steps: [
      {
        title: "给出标的",
        body: "告诉专家股票名称或代码（如「贵州茅台」或「600519」），也可以直接粘贴研报、公告或财报文本。",
      },
      {
        title: "让专家研究",
        body: "说：「做一份这个标的的研究」——专家会依次给出标的档案、财报速览与红旗项、估值汇总（DCF/可比公司）、行业对照与多空辩论。",
      },
      {
        title: "拿到研究纪要",
        body: "每个模块都带数据来源；让专家补趋势图或导出为文档，成果会自动存进成果页。",
      },
    ],
    prompts: [
      { title: "做一份标的档案", text: "请为「（股票名称/代码）」建立标的档案：主营业务、行业地位、股权结构、近期大事。" },
      { title: "速览财报红旗项", text: "读取「（股票）」最新财报，速览关键科目并专门标出红旗项（应收激增、存货异常、现金流背离等）。" },
      { title: "估值汇总", text: "对「（股票）」做估值汇总：DCF 与可比公司两条线，给出假设和敏感性说明。" },
      { title: "多空辩论", text: "请就「（股票）」组织一场多空辩论：多方三条论据、空方三条论据，各自标注数据依据。" },
    ],
  },

  // 数据-中国经济：宏观简报
  "hKvTCaWfSIAAJhZSseoE9w": {
    name: "数据-中国经济",
    steps: [
      {
        title: "说清要什么",
        body: "直接说主题即可：「生成上月宏观简报」或「查最新社融并画趋势」。专家接的是真数据源（M1/M2、社融、LPR、通胀等）。",
      },
      {
        title: "让专家出简报",
        body: "简报自带指标框架：每个关键数据逐项带期数来源，图表用真实序列绘制，不编数字。",
      },
      {
        title: "追问与导出",
        body: "可以对任何一个指标追问历史对比或结构拆解；让专家导出为文档，成果自动保存。",
      },
    ],
    prompts: [
      { title: "生成宏观简报", text: "请生成最近一期的中国宏观经济简报：增长、通胀、货币（M1/M2、社融）、LPR，关键数据带期数来源。" },
      { title: "查数据画趋势", text: "查询最近 24 个月的 M2 与社融存量同比，画成趋势图并标注拐点。" },
      { title: "对比通胀走势", text: "对比中国与美国最近两年的 CPI 走势，用一张图呈现并解释分化原因。" },
      { title: "解读政策变动", text: "最新一次 LPR 变动是什么？请结合历史序列解读其对房贷和企业融资的影响。" },
    ],
  },

  // 文档工坊：Office 三场景
  "qnhd7B3J1-HKDDKzZQ_fUQ": {
    name: "文档工坊",
    steps: [
      {
        title: "备好素材",
        body: "把要点、数据表或旧版文档发给专家——大纲、会议纪要、Excel 数据都行，不必先整理格式。",
      },
      {
        title: "点名要哪种文档",
        body: "明确说「生成一份 Word 商务报告 / Excel 数据工作簿 / PPT 汇报演示」，并给出受众和篇幅偏好。",
      },
      {
        title: "取件与修改",
        body: "文档生成后可继续迭代（改结构、换口径、补图表），定稿的文件保存到成果页，随时下载。",
      },
    ],
  },

  // 数据研究·生态版：官方功能集
  "Aqag8Mky4ksoPmwRDMCVYw": {
    name: "数据研究 · 生态版",
    steps: [
      {
        title: "确认数据范围",
        body: "这套官方功能集接的是 FindData 数据底座（宏观、金融等真数据源）。先告诉专家你关心的主题和时间段。",
      },
      {
        title: "直接提问",
        body: "像问同事一样问：「这个指标最近走势如何」「帮我对比这几个行业」——专家自动取数、核验、作图。",
      },
      {
        title: "拿到带来源的结论",
        body: "每个结论都标注数据来源与期数；需要留档时让专家生成文档，自动存入成果页。",
      },
    ],
  },
};

/** The guide for a pack id, or null when the module has no content for it. */
export function guideFor(packId: string | null | undefined): PackGuide | null {
  if (!packId) return null;
  return PACK_GUIDES[packId] ?? null;
}

/** Prompt cards for a pack id — undefined when the pack has no prompt set. */
export function promptsFor(packId: string | null | undefined): PackPromptCard[] | undefined {
  return guideFor(packId)?.prompts;
}
