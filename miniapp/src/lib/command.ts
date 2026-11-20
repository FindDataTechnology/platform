// 指挥台聚合数据的小程序侧胶水(openspec: add-mp-command-center)。
//
// 版本错位是这里的第一个约束(与 resources.ts 同款):指挥台聚合端点随 cell
// 发布,小程序按自己的节奏发布。旧 cell 没有 /api/mp/command-summary →
// 404 意味着"这个部署还没有指挥台",页面按此诚实降级,而不是把 404 甩给
// 用户;等新 cell 上线,同一个客户端无需更新就能亮起来。
// 401 走一次静默重登再重试(12h token 过期的标准恢复路径,taro-http 同款)。

import Taro from "@tarojs/taro";
import { authHeaders, refreshToken } from "./auth";
import { baseUrl } from "./config";

export interface PendingQuestionItem {
  sessionId: string;
  askId: string;
  questions: { question?: string }[];
  sessionTitle: string | null;
}

export interface AttentionJob {
  id: string;
  title: string;
  state: "failed" | "interrupted";
  lastRun: string | null;
  error: string | null;
}

export interface CommandSummary {
  pendingQuestions: PendingQuestionItem[];
  jobs: {
    counts: { total: number; active: number; paused: number; failed: number; interrupted: number };
    attention: AttentionJob[];
    recentDone: { jobId: string; title: string; time: string; duration: number }[];
  };
}

export const COMMAND_SUMMARY_ABSENT = "absent";

async function requestOnce(): Promise<Taro.request.SuccessCallbackResult> {
  return Taro.request({
    url: `${baseUrl()}/api/mp/command-summary`,
    header: authHeaders(),
    dataType: "json",
  });
}

export async function fetchCommandSummary(): Promise<CommandSummary | typeof COMMAND_SUMMARY_ABSENT> {
  let res = await requestOnce();
  if (res.statusCode === 401 && (await refreshToken())) res = await requestOnce();
  if (res.statusCode === 404) return COMMAND_SUMMARY_ABSENT;
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`指挥台读取失败(${res.statusCode})`);
  }
  return res.data as CommandSummary;
}
