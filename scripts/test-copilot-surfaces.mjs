// 萬星副驾挂载判定的单元测试（unify-yizuo-copilot-surface 1.1/1.2）。
//
// 判定必须是纯函数：它决定「本路由有没有原生对话入口」，而原生对话入口的
// 挂载点由 CopilotDockTrigger 定义——两处口径漂移会让某一面同时出现两个
// 对话入口，或者一个都没有。
//
// 跑法：node --test scripts/test-copilot-surfaces.mjs
// （Node ≥22 的类型剥离直接加载 .ts，不需要先编译。）
import test from "node:test";
import assert from "node:assert/strict";

const { shouldMountWanxingCopilot } = await import(
  "../web/src/lib/copilotSurfaces.ts"
);

test("有原生对话入口的面：萬星退场", () => {
  for (const path of [
    "/chat",
    "/chat/abc",
    "/zhiyu",
    "/zhiyu/room-1",
    "/boards/facet",
    "/fleets",
    "/fleets/f1",
    "/packs",
    "/login",
  ]) {
    assert.equal(shouldMountWanxingCopilot(path), false, path);
  }
});

test("市场 tab 退场，其它 tab 保留", () => {
  assert.equal(shouldMountWanxingCopilot("/agents"), false);
  assert.equal(shouldMountWanxingCopilot("/agents", "?tab=market"), false);
  assert.equal(shouldMountWanxingCopilot("/agents", "?tab=agents"), false);
  assert.equal(shouldMountWanxingCopilot("/agents", "?tab=skills"), true);
  assert.equal(shouldMountWanxingCopilot("/agents", "?tab=apps"), true);
});

test("配置类面无对话入口：萬星保留", () => {
  for (const path of [
    "/",
    "/knowledge",
    "/memory",
    "/apps",
    "/settings/general",
    "/teams/directory",
    "/machines",
    "/tasks",
    "/dashboard",
  ]) {
    assert.equal(shouldMountWanxingCopilot(path), true, path);
  }
});

test("前缀不误伤：/chatroom 之类不是 /chat", () => {
  assert.equal(shouldMountWanxingCopilot("/chatroom"), true);
  assert.equal(shouldMountWanxingCopilot("/fleetship"), true);
});

// ── 闸的挂载点必须在任何早返回之前（2026-11-18 生产实测暴露）─────────────
//
// 原来的闸挂在 WanxingCopilotHost，而 App.tsx 的 `loginRequired` 分支提前
// return <LoginPage />，组件不渲染 ⇒ 闸不跑 ⇒ /login 上万星圆钮仍可见。
//
// 修法是把宿主提到所有早返回之前（零逻辑改动，它只依赖 useLocation）。
// 这条测试守的是**结构**：源码里每一处早返回的页面，都必须带上宿主。
// 它不测运行时（react-dom 全文渲染成本高），而是钉住 App.tsx 的形状——
// 将来有人再加一个早返回分支却忘了带宿主，这里会红。
import { readFileSync } from "node:fs";

test("App.tsx 的每个早返回分支都带上了 WanxingCopilotHost", () => {
  const src = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");

  // 宿主必须被提取成一个常量，供各分支复用
  assert.match(
    src,
    /const copilotHost = <WanxingCopilotHost \/>/,
    "宿主应提取为 copilotHost 常量（各早返回分支复用）",
  );

  // 提取所有 `return (` / `return <` 的早返回块，每个都要带 {copilotHost}
  // （`return <Navigate ...>` 是重定向、不渲染页面，豁免）
  const branchStarts = [...src.matchAll(/^\s{2}if \([^)]*\bauthReady|^\s{2}if \(loginRequired\)/gm)];
  assert.ok(branchStarts.length >= 2, `应找到至少 2 个受保护分支，实际 ${branchStarts.length}`);

  // /login 分支：必须同时出现 copilotHost 与 LoginPage
  const loginBlock = /if \(loginRequired\)[\s\S]{0,600}?copilotHost[\s\S]{0,200}?LoginPage/;
  assert.match(src, loginBlock, "loginRequired 分支必须渲染 copilotHost + LoginPage");
});

test("宿主不再滞留在主布局里（防重复挂载 + 防回退）", () => {
  const src = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
  const mounts = [...src.matchAll(/<WanxingCopilotHost \/>/g)];
  assert.equal(
    mounts.length,
    1,
    `宿主应只出现 1 次（提取成常量），实际 ${mounts.length} 次`,
  );
});
