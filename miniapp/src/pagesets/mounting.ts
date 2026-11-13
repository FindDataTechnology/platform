// 页面集「注册 ↔ 落盘」一致性（change: guard-pageset-mounting）。
//
// 一次页面集装载要三处同时对，少一处就是**声明了但没挂载**：
//   1. registry.ts 的 pages[] —— 决定入口是否出现、需要什么 grant；
//   2. src/<path>/index.tsx + index.config.ts —— 真正能被打开的页面；
//   3. app.config.ts 的 pages[] —— Taro 只在静态登记里找页面。
// 三处任何一处漏掉，用户看到的是「入口在、点进去白屏」或「页面在、永远进不去」，
// 而单元测试、类型检查、构建都可以全绿——2026-11-12 在 REST 那一层就撞过同类
// （端点做完、契约没写，一路绿到归档），所以这里也把它变成机器判据。
//
// 纯函数：调用方喂数据，便于用 fixture 造红，也便于在 worktree 里跑。

export interface PagesetPageRef {
  id: string;
  path: string;
}

export interface PagesetRef {
  key: string;
  pages: PagesetPageRef[];
}

export interface MountingInput {
  /** registry.ts 导出的页面集 */
  pagesets: PagesetRef[];
  /** app.config.ts 的 pages[]（只取以 pages/ 开头的静态登记） */
  declaredPages: string[];
  /** 落盘页面目录（相对 miniapp/src，形如 pages/se/invoice-audit） */
  pageDirs: string[];
  /** 已经带 index.config.ts 的目录（可与 pageDirs 相同集合，也可更小） */
  configuredDirs: string[];
  /** 四个业务面标签；只在这些前缀下做「孤儿页面」反向检查 */
  surfaces?: string[];
}

const DEFAULT_SURFACES = ["ue", "se", "sp", "cp"];

/** 返回问题清单（空数组 = 一致）。每条都写「是什么」+「怎么修」。 */
export function checkMounting(input: MountingInput): string[] {
  const problems: string[] = [];
  const surfaces = input.surfaces ?? DEFAULT_SURFACES;
  const registered = new Set<string>();
  const declared = new Set(input.declaredPages);
  const dirs = new Set(input.pageDirs);
  const configured = new Set(input.configuredDirs);

  // registry 自身：路径不得重复、不得跨页面集重名
  const seen = new Map<string, string>();
  for (const ps of input.pagesets) {
    for (const page of ps.pages) {
      const prev = seen.get(page.path);
      if (prev) {
        problems.push(
          `[重复注册] ${page.path} 同时出现在 ${prev} 与 ${ps.key} 的 pages[] —— 一个路径只能属于一个页面集`,
        );
      } else {
        seen.set(page.path, ps.key);
      }
      registered.add(page.path);
    }
  }

  for (const ps of input.pagesets) {
    for (const page of ps.pages) {
      // 2) 落盘：目录 + 页面本体 + 页面配置
      if (!dirs.has(page.path)) {
        problems.push(
          `[未落盘] ${ps.key} 的 ${page.id}（${page.path}）没有页面目录 —— 建 src/${page.path}/index.tsx，或从 registry 撤掉这条`,
        );
      } else if (!configured.has(page.path)) {
        problems.push(
          `[缺页面配置] ${page.path} 没有 index.config.ts —— 补一个 definePageConfig（导航标题），否则打包时会缺页面元信息`,
        );
      }
      // 3) app.config：Taro 的静态登记
      if (!declared.has(page.path)) {
        problems.push(
          `[未登记] ${page.path} 不在 app.config.ts 的 pages[] 里 —— Taro 只在静态登记里找页面，漏了等于这条入口永远打不开`,
        );
      }
    }
  }

  // 反向：四个业务面下已有的页面目录若没被任何页面集注册，就是「页面在、永远进不去」
  const prefixes = surfaces.map((s) => `pages/${s}/`);
  for (const dir of input.pageDirs) {
    if (!prefixes.some((p) => dir.startsWith(p))) continue;
    if (!registered.has(dir)) {
      problems.push(
        `[孤儿页面] ${dir} 有页面文件但没有任何页面集注册它 —— 加进对应 pageset 的 pages[]（或在 app.config 里也不登记，把它删掉）`,
      );
    }
  }

  return problems;
}
