// 资源库的小程序侧胶水(openspec: add-resource-library,小程序):REST 读取 +
// resources_changed 事件的本地订阅。
//
// 版本错位是这里的第一个约束:资源库随 cell 发布,小程序按自己的节奏发布。旧
// cell 没有 /api/resources,REST 会 404 —— 那意味着"这个部署还没有资源库",
// 所有入口(历史抽屉的分组、聊天里的文件 chip)都据此隐藏,而不是把 404 甩给
// 用户;等新 cell 上线,同一个客户端无需更新就能亮起来。

import {
  listResources,
  ResourceApiError,
  type Resource,
  type ResourceListQuery,
} from "@platform/core";
import { runtime } from "./runtime";

// 本模块的版本号 + 订阅:与 web 的 zustand store 等价,但小程序不需要为这一个
// 事件引入全局 store。资源页在 show 时订阅,收到事件即重新拉取。
let version = 0;
const listeners = new Set<() => void>();

runtime.onServerMessage((m) => {
  if (m.type !== "resources_changed") return;
  version += 1;
  for (const fn of listeners) fn();
});

export function resourcesVersion(): number {
  return version;
}

export function subscribeResources(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 旧 cell(无 /api/resources)返回 404 —— 视为"不支持",不作为错误上抛。 */
export function isUnsupported(err: unknown): boolean {
  return err instanceof ResourceApiError && err.status === 404;
}

export interface LoadResult {
  supported: boolean;
  items: Resource[];
  total: number;
  limit: number;
  offset: number;
  error?: string;
}

export async function loadResources(query: ResourceListQuery = {}): Promise<LoadResult> {
  try {
    const page = await listResources({ limit: 30, ...query });
    return { supported: true, ...page };
  } catch (err) {
    if (isUnsupported(err)) return { supported: false, items: [], total: 0, limit: 0, offset: 0 };
    return {
      supported: true,
      items: [],
      total: 0,
      limit: 0,
      offset: 0,
      error: (err as Error).message || "读取失败",
    };
  }
}

export function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 保存被拒时的中文说明;未知 code 回落到服务端原文。 */
export function saveErrorText(err: unknown): string {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case "invalid_path":
      return "该文件不在工作区内";
    case "file_not_found":
      return "文件已不在工作区中";
    case "file_too_large":
      return "文件过大,无法存入资源";
    case "db_unavailable":
      return "资源库暂不可用";
    default:
      return (err as Error)?.message || "保存失败";
  }
}