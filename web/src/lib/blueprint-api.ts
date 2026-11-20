// blueprint-api.ts — 蓝图构造间的 typed client (add-blueprint-studio, Slice 2).
//   - 资产面：清单/详情/创建/编辑（expectVersion 乐观锁）；
//   - 闸位：validate（全链校验，错误为既有校验器原文）/approve/cast；
//   - 试跑报告位：读（执行器随 Slice 3）。
// 错误体随行（409 携 currentVersion、422 携 errors/findings），页面直出原文。

export type BlueprintStatus = "draft" | "approved" | "cast";

export type BlueprintKind = "agent" | "team";

export interface BlueprintSkill {
  name: string;
  description?: string;
  content: string;
}

export interface BlueprintContent {
  /** add-agent-builder-workspace 4.1: agent（岗位文档）| team（场景文档）；缺省 = team。 */
  kind?: BlueprintKind;
  /** agent 型的名字与一句话（team 型在 boundary 下）。 */
  name?: string;
  description?: string;
  boundary?: { name?: string; oneLine?: string; outOfScope?: string };
  /** 判定该蓝图 llm-judged 断言的模型 id（空=跟随部署默认）。 */
  judgeModel?: string;
  dataSources?: { ref: string; note?: string }[];
  fleet?: Record<string, unknown>;
  agents?: unknown[];
  mcpServers?: unknown[];
  /** 4.3: 技能桶进持久文档（铸造/发射同源，不再静默丢）。 */
  skills?: BlueprintSkill[];
  monitoring?: Record<string, unknown>;
  acceptance?: unknown[];
  board?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BlueprintSummary {
  id: string;
  name: string;
  oneLine: string;
  /** 4.4: 清单行按 kind 统一列（缺省 team）。 */
  kind: BlueprintKind;
  status: BlueprintStatus;
  version: number;
  approvedBy: string | null;
  approvedAt: string | null;
  castPackId: string | null;
  castPackVersion: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Blueprint extends BlueprintSummary {
  ownerEmail: string;
  outOfScope: string;
  content: BlueprintContent;
  diffSummary: string | null;
  trialReport: unknown;
}

export interface ValidationError {
  error: string;
  entry?: string;
  /** add-agent-builder-workspace 5.1: stable code; unknown codes fall back to `error` verbatim. */
  code?: string;
}

export interface ValidationVerdict {
  ok: boolean;
  errors: ValidationError[];
  findings: {
    // v1 方言命中时只有这一段有内容（其余为空）——见 remove-blueprint-v1-compat。
    v1: ValidationError[];
    shape: ValidationError[];
    fleet: ValidationError[];
    manifest: ValidationError[];
    toolFace: ValidationError[];
    toolClosure: ValidationError[];
  };
  manifestPreview: Record<string, unknown>;
}

export class BlueprintApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body?.error === "string" ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new BlueprintApiError(res.status, body);
  return body as T;
}

export function listBlueprints() {
  return call<{ blueprints: BlueprintSummary[] }>("/api/blueprints");
}

export function getBlueprint(id: string) {
  return call<{ blueprint: Blueprint }>(`/api/blueprints/${encodeURIComponent(id)}`);
}

export function createBlueprint(content: BlueprintContent, name?: string) {
  return call<{ blueprint: Blueprint; warnings?: ValidationError[] }>("/api/blueprints", {
    method: "POST",
    body: JSON.stringify({ content, ...(name ? { name } : {}) }),
  });
}

export function updateBlueprint(id: string, expectVersion: number, content: BlueprintContent) {
  return call<{ blueprint: Blueprint; warnings?: ValidationError[] }>(`/api/blueprints/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ expectVersion, content }),
  });
}

export function validateBlueprint(id: string) {
  return call<ValidationVerdict>(`/api/blueprints/${encodeURIComponent(id)}/validate`, { method: "POST" });
}

export function approveBlueprint(id: string, expectVersion: number) {
  return call<{ blueprint: Blueprint }>(`/api/blueprints/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify({ expectVersion }),
  });
}

export function castBlueprint(id: string) {
  return call<{ blueprint: Blueprint; cast: { packId: string | null; version: number | null; selfPending: boolean } }>(
    `/api/blueprints/${encodeURIComponent(id)}/cast`,
    { method: "POST" },
  );
}

export interface TrialJudgement {
  id: string;
  kind: string;
  pass: boolean;
  verdict?: "pass" | "fail" | "insufficient-evidence";
  detail?: string;
  audit?: {
    assertionId?: string;
    rubric?: string;
    verdict?: string;
    model?: string | null;
    endpointDigest?: string | null;
    promptHash?: string | null;
    evidenceDigest?: string | null;
    rawVerdict?: string | null;
    judgeSource?: "blueprint" | "deployment" | "fallback" | null;
    judgeFallbackReason?: string | null;
    judgedAt?: string;
    // 判据没跑成（车道 429/5xx/不可达）与「模型看过说证据不足」是两件事。
    laneError?: { status: number | null; kind: "rate-limited" | "upstream" | "unreachable" } | null;
    cached?: boolean;
    cacheAgeMs?: number;
    quotaExceeded?: boolean;
  };
}

export interface TrialSignoff {
  by: string;
  at: string;
  reportRanAt: number;
}

export interface TrialReport {
  ranAt: number;
  fleetId: string | null;
  green: boolean;
  assertions: TrialJudgement[];
  judged?: TrialJudgement[];
  signoff?: TrialSignoff;
  judgeModelUsed?: string | null;
  errors?: string[];
  [key: string]: unknown;
}

export function signTrialReport(id: string) {
  return call<{ blueprint: Blueprint; report: TrialReport }>(`/api/blueprints/${encodeURIComponent(id)}/trial-signoff`, {
    method: "POST",
  });
}

export function unsignTrialReport(id: string) {
  return call<{ blueprint: Blueprint; report: TrialReport }>(`/api/blueprints/${encodeURIComponent(id)}/trial-signoff`, {
    method: "DELETE",
  });
}

export function deleteBlueprint(id: string) {
  return call<{ ok: boolean; id: string }>(`/api/blueprints/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getTrialReport(id: string) {
  return call<{ report: TrialReport | null }>(`/api/blueprints/${encodeURIComponent(id)}/trial-report`);
}

// 「跟随部署默认」实际解析到谁（优化③）。服务端用与判据同一个解析函数回答，
// 所以这里看到的就是试跑时真正会用的那条车道。
export interface JudgeDefaultProbe {
  resolved: { model: string; providerId?: string | null; judgeSource?: string | null } | null;
  unavailable?: boolean;
  reason?: string | null;
}

export function getJudgeDefault(forModel?: string) {
  const q = forModel?.trim() ? `?for=${encodeURIComponent(forModel.trim())}` : "";
  return call<JudgeDefaultProbe>(`/api/blueprints/judge-default${q}`);
}

export function runTrial(id: string) {
  return call<{ report: TrialReport; blueprint: Blueprint }>(`/api/blueprints/${encodeURIComponent(id)}/trial`, {
    method: "POST",
  });
}

// 新草稿骨架：六段在场、结构可编辑；场景名占位（创建后于表单轨改名）。
export function skeletonContent(name: string): BlueprintContent {
  return {
    kind: "team",
    boundary: { name, oneLine: "", outOfScope: "" },
    dataSources: [],
    fleet: { name, members: [] },
    agents: [],
    mcpServers: [],
    skills: [],
    monitoring: {},
    acceptance: [],
    board: {},
  };
}

// agent 型轻骨架（4.1/4.4）：无 boundary/fleet/acceptance，名字与一句话在顶层；
// 一个空岗位即「已选岗位」——一次点击建好即可填人设，名称输入框随即聚焦。
export function agentSkeletonContent(name: string): BlueprintContent {
  return {
    kind: "agent",
    name,
    description: "",
    agents: [{ id: "agent-1", name: "", persona: "" }],
    mcpServers: [],
    skills: [],
  };
}
