// 部署归属判定（single-tenant-model-lane D1）。
//
// 回答一个问题：**这台机器属于一个客户，还是多个？**
//
// 为什么不是从宿主形态反推：`ciyuan-account` 的 D6 覆盖守卫原本用
// `cellUserEmail ? "cell" : "shared"`——「是不是 per-user cell」被当成
// 「是不是共享」。那个推断在私有化交付出现之前一直成立，因为当时单进程 = 桌面版
// = 安装方自己用。机房版打破了这个等式：单进程，但一客户一实例。
//
// 判反的代价不对称，所以缺省必须落在「不覆盖」一侧：
//   - 该覆盖没覆盖 → 客户绑了账号发现没扣自己的钱，可解释、可修
//   - 不该覆盖却覆盖 → 一套共享部署里所有人悄悄替某一个人计费，对账才发现
export const FORM_CELL = "cell";
export const FORM_SINGLE_TENANT = "single-tenant";
export const FORM_SHARED = "shared";

/** `SINGLE_TENANT` 的真值识别：只认明确的肯定写法，其余一律 false（安全侧）。 */
function isTruthyFlag(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

/**
 * @param {object} [env] 环境变量来源（默认 process.env）
 * @returns {"cell"|"single-tenant"|"shared"}
 *
 * cell 优先：有 `CELL_USER_EMAIL` 说明这是按用户切的 cell，它自带单一身份，
 * 不管 `SINGLE_TENANT` 写没写都按 cell 处理——两者同时出现是配置矛盾，
 * 取语义更窄的那个（cell 的身份是真实的，单租户标记是部署级的）。
 */
export function deploymentForm(env = process.env) {
  const cellEmail = String(env.CELL_USER_EMAIL ?? "").trim();
  if (cellEmail) return FORM_CELL;
  if (isTruthyFlag(env.SINGLE_TENANT)) return FORM_SINGLE_TENANT;
  return FORM_SHARED;
}

/**
 * 覆盖层该用哪个身份当键。
 *
 * 单租户下没有 `cellUserEmail`，所以按 design D2 的三级解析：
 *   CELL_USER_EMAIL → 绑定时使用的平台身份 → `owner@local`
 *
 * `owner@local` 不是新概念：`AUTH_MODE=none` 下建团队时 `ownerEmail` 就落这个值，
 * 产品面在单进程形态里本来就用它表示「本机唯一的那个主人」。沿用它是让系统只有
 * 一套「谁是主人」的直觉。
 *
 * **不接受**行业线变量（`ERP_TENANT_ID` 之类）当身份：那表达的是「哪个租户的数据」，
 * 不是「谁的调用」。混用会让不同线互相污染。
 */
export function modelLaneOwner(env, form, bindingEmail = null) {
  const cellEmail = String(env?.CELL_USER_EMAIL ?? "").trim();
  if (cellEmail) return cellEmail;
  if (form !== FORM_SINGLE_TENANT) return null;
  const email = String(bindingEmail ?? "").trim();
  return email || "owner@local";
}

/** 单租户下 key 失效时是否回落部署 key。cell 形态保持既有语义（回落）。 */
export function fallsBackOnStale(form) {
  return form !== FORM_SINGLE_TENANT;
}
