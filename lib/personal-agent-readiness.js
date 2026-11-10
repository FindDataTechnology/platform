// ── Personal agent readiness (2026-11-10) ──────────────────────────────────
//
// 为什么要有这个：这套授权是七个开关分散在三处的（委托状四域 × 事项接入三源 +
// 审计官 + 裁决令牌）。任何一处配错，表现都是「代理很安静」——和「没配好」长得
// 一模一样。本次开发里同一个形态踩了三次（摘要只收裁决 / 层级只记越界 / 越界计数
// 必须有域），所以这里把「安静」拆成一句可读的结论。
//
// 两类结论分开：
//   · blocked — 这个状态下代理**不会做任何有价值的事**，或做了也不安全；
//   · warn    — 能跑，但你大概不是这个意思（判例为零 = 它在盲判）。
//
// 纯函数，零 IO：入参由调用方（端点 / CLI）自己取。
//
// 文案是中文、由服务端生成——与本仓既有做法一致（裁决摘要、拍板问题文本、
// 报数摘要都是服务端中文；check:locales 只覆盖 web/src 的字面量键）。英文界面
// 里这块会显中文，属已知边界，不做半套翻译（半翻译比不翻译更难读）。

/** 一个域是否真的授予了东西（advise 不是授权）。 */
function grants(mode) {
  return mode === "draft" || mode === "act-notify" || mode === "act-silent";
}

function domainModes(mandate) {
  const out = {};
  for (const [name, block] of Object.entries(mandate?.domains ?? {})) {
    if (block?.mode) out[name] = block.mode;
  }
  return out;
}

/**
 * @param {object} input
 * @param {object} input.mandate            归一化后的委托状（v2）
 * @param {Array}  input.domainMap          事项接入映射
 * @param {boolean} input.hasAuditor        舰队里是否已有 auditor 岗位
 * @param {boolean} input.verdictTokenConfigured
 * @param {number} input.citablePrecedents  可作判例的条数
 * @param {object} input.levelSamples       各披露层级已发样本
 * @param {object} input.consistency        每域一致率 {domain:{samples,rate}}
 * @param {number} input.minLevelSamples    层级样本阈值（默认 20）
 */
export function assessPersonalAgent({
  mandate = null,
  domainMap = [],
  hasAuditor = false,
  verdictTokenConfigured = false,
  citablePrecedents = 0,
  levelSamples = {},
  consistency = {},
  minLevelSamples = 20,
} = {}) {
  const items = [];
  const modes = domainModes(mandate);
  const granting = Object.entries(modes).filter(([, m]) => grants(m));
  const autoDomains = Object.entries(modes).filter(([, m]) => m === "act-notify" || m === "act-silent");
  const openSources = (Array.isArray(domainMap) ? domainMap : []).filter((m) => m?.enabled === true);

  // 1 授权：没有任何域授予东西 → 它只会给建议
  items.push({
    id: "mandate-grants",
    severity: "blocked",
    ok: granting.length > 0,
    title: "至少一个域被授予了权限",
    detail: granting.length
      ? `已授予: ${granting.map(([d, m]) => `${d}=${m}`).join(", ")}`
      : "四个域全是「只给建议」——代理不会产出任何可执行动作",
    fix: "设置 → 管理 → 委托状：把要交给它的域设为「起草，待我放行」（先别直接上自动）",
  });

  // 2 接入：没有来源就是空转
  items.push({
    id: "intake-open",
    severity: "blocked",
    ok: openSources.length > 0,
    title: "至少一个事项来源已开启",
    detail: openSources.length
      ? `已开启: ${openSources.map((m) => m.source).join(", ")}`
      : "三个来源全关——没有任何事项会进入它负责的域",
    fix: "设置 → 管理 → 事项接入：先开「跨线阻塞」一类，够了再加",
  });

  // 3 判例：能跑，但它在盲判
  items.push({
    id: "precedents",
    severity: "warn",
    ok: citablePrecedents > 0,
    title: "有可引用的判例",
    detail: citablePrecedents > 0
      ? `${citablePrecedents} 条（只算你手打／你原样发出的）`
      : "0 条——它的判断没有依据可引，只能靠通用常识",
    fix: "正常使用即可积累；也可先跑 scripts/backfill-precedent-grades.mjs 把存量里属于你的裁决捞回来",
  });

  // 4 自动对外：需要裁决令牌，否则出站一律失败关闭
  if (autoDomains.length > 0) {
    items.push({
      id: "verdict-token",
      severity: "blocked",
      ok: verdictTokenConfigured === true,
      title: "对外裁决通道已配置",
      detail: verdictTokenConfigured
        ? "MANDATE_VERDICT_TOKEN 已注入"
        : "有域已设为自动，但没有裁决令牌——runner 侧取不到裁决就不发（失败关闭），对外会全部静默失败",
      fix: "注入 MANDATE_VERDICT_TOKEN 并在 runner 侧用同一个值",
    });
  }

  // 5 自动对外：层级样本
  if (autoDomains.length > 0) {
    const thin = Object.entries(levelSamples ?? {})
      .filter(([, n]) => Number(n) < minLevelSamples)
      .map(([level, n]) => `${level}=${n}`);
    const anySamples = Object.keys(levelSamples ?? {}).length > 0;
    items.push({
      id: "level-samples",
      severity: "warn",
      ok: anySamples && thin.length === 0,
      title: "对外各层级都有足够样本",
      detail: anySamples
        ? thin.length
          ? `样本不足（阈值 ${minLevelSamples}）: ${thin.join(", ")}`
          : "各层级样本达标"
        : "还没有任何对外发言样本——自动对外尚不可放量",
      fix: "先用「起草」跑一段，或把模式收回「起草」积累样本",
    });
  }

  // 6 审计官：没有它就是少一道反证
  items.push({
    id: "auditor",
    severity: "warn",
    ok: hasAuditor === true,
    title: "有审计官岗位",
    detail: hasAuditor
      ? "已设立，会对判断给出三态结论"
      : "未设立——没有人替你唱反调，代理容易自我强化",
    fix: "舰队页新增岗位，类型选 auditor（需先配好委托状）",
  });

  // 7 一致率：有样本却偏低，说明口径还没对上
  const weak = Object.entries(consistency ?? {})
    .filter(([, s]) => Number(s?.samples) >= 5 && Number(s?.rate ?? 1) < 0.8)
    .map(([d, s]) => `${d}=${Math.round((s.rate ?? 0) * 100)}%(${s.samples})`);
  if (weak.length) {
    items.push({
      id: "consistency",
      severity: "warn",
      ok: false,
      title: "与你的判断一致性偏低",
      detail: `这些域你多次不同意它: ${weak.join(", ")}`,
      fix: "把该域收回「起草」，用你的更正攒判例（系统会把它蒸馏成候选规则）",
    });
  }

  const blocked = items.filter((i) => !i.ok && i.severity === "blocked");
  const warns = items.filter((i) => !i.ok && i.severity === "warn");
  return {
    ready: blocked.length === 0,
    blocked: blocked.length,
    warns: warns.length,
    // 一句话结论：先说要修什么，而不是先报一串 true/false
    verdict: blocked.length
      ? `还不能用：${blocked.map((i) => i.title).join("；")}`
      : warns.length
        ? `可以跑，但有 ${warns.length} 处值得看一下`
        : "配置完整",
    items,
  };
}
